import { SupabaseService } from "../services/SupabaseService";
import * as fs from "fs/promises";
import * as path from "path";

import { createCanvas } from "@napi-rs/canvas";

/**
 * Supabase Real-time Listener
 * Listens to changes on a configurable table in Supabase
 * Uses a single channel with event routing to separate handlers
 */
export class SupabaseListener {
  private supabaseService: SupabaseService;
  private channelName: string;
  private tableName: string;
  private enabled: boolean;
  private readonly scoreImageDir: string;
  private lastRenderedTextByCourt: Map<string, string> = new Map();
  // One promise chain per court, so overlay writes for the SAME court run strictly
  // one-after-another. This is the load-bearing fix for the 8 Oct 2026 outage:
  // two score updates arriving together both raced on the single `<court>.png.tmp`
  // file — the first rename consumed it, the second threw ENOENT, and that
  // rejection reached the process-level handler and exited the WHOLE streamer.
  // Serialising per court means two writes can never touch the temp file at once,
  // and scores always land in order (no older score overwriting a newer one).
  private writeChainByCourt: Map<string, Promise<void>> = new Map();

  constructor(channelName: string, tableName: string) {
    this.supabaseService = SupabaseService.getInstance();
    this.channelName = channelName;
    this.tableName = tableName;
    this.enabled = this.supabaseService.isEnabled();
    this.scoreImageDir = path.resolve("./public/overlays");
  }

  /**
   * Subscribe to score updates for a specific court
   */
  public subscribeToCourt(courtId: string): void {
    if (!this.enabled) return;

    const channelName = `${this.channelName}-${courtId}`;
    const filter = `court_id=eq.${courtId}`;

    // Idempotent subscribe: if a live channel already exists for this court, do
    // NOT open a second one. Two channels on the same filter (court_id=eq.X) each
    // deliver every UPDATE, so the overlay renders twice per score — the duplicate
    // delivery seen in the 8 Oct incident (two identical UPDATE events at the same
    // timestamp). subscribeToTable's own "remove old, add new" path cannot prevent
    // this on its own: it removes the old channel WITHOUT awaiting, leaving a brief
    // window where both are live. Skipping here closes that window at the source.
    if (this.supabaseService.isChannelActive(channelName)) {
      console.log(`↩️  Already subscribed to court ${courtId}; skipping duplicate subscription`);
      return;
    }

    // Drop any cached render text from a previous session on this court so the
    // first update after (re)subscribing always redraws the (freshly reset)
    // transparent overlay, even if the score happens to match the old one.
    this.lastRenderedTextByCourt.delete(courtId);

    console.log(`🎯 Subscribing to Supabase updates for court: ${courtId}`);

    this.supabaseService.subscribeToTable(
      channelName,
      this.tableName,
      this.handleAllEvents.bind(this),
      "UPDATE",
      "public",
      filter
    );
  }

  /**
   * Unsubscribe from score updates for a specific court
   */
  public async unsubscribeFromCourt(courtId: string): Promise<void> {
    if (!this.enabled) return;

    const channelName = `${this.channelName}-${courtId}`;
    
    if (!this.supabaseService.isChannelActive(channelName)) {
      return;
    }

    console.log(`🛑 Unsubscribing from Supabase updates for court: ${courtId}`);
    await this.supabaseService.unsubscribe(channelName);

    // Drop this court's cached render text so the first update after a later
    // resubscribe always redraws the (freshly reset) overlay.
    //
    // We deliberately do NOT delete the write chain here. A write may still be in
    // flight, and the chain tail must stay reachable so that a write enqueued after a
    // resubscribe chains BEHIND it rather than starting a fresh, parallel chain. If we
    // dropped it here, a stop + immediate resubscribe could run the old in-flight write
    // and the new write at the same time — both renaming the same `<court>.png.tmp`
    // file, which is exactly the race this PR removes. The chain cleans itself up once
    // it drains (see enqueueScoreWrite), so there is nothing to free here.
    this.lastRenderedTextByCourt.delete(courtId);
  }

  /**
   * Handle UPDATE events from Supabase
   */
  private handleAllEvents(payload: any): void {
    console.log("✏️  UPDATE event received");
    const score = this.extractScore(payload.new);
    if (!score) {
      return;
    }
    this.enqueueScoreWrite(score);
  }

  /**
   * Queue a score-overlay write, serialised per court and guarded against failure.
   *
   * ── WHY THIS EXISTS (change at your peril) ──
   * writeScoreImage renders to one fixed temp file per court (`<court>.png.tmp`)
   * and renames it into place. Firing two of them at once for the same court
   * raced on that temp file: the losing rename threw ENOENT, and — called
   * fire-and-forget — that became an unhandled rejection that exited the WHOLE
   * streamer (8 Oct 2026 outage, 18 crashes in a day).
   *
   * Two guards here, both load-bearing:
   *  - serialise: each court's writes are chained, so only one runs at a time.
   *    No temp-file collision, and scores land in order (a slower older write can
   *    never finish last and leave a stale scoreboard on screen).
   *  - catch: an overlay write failing must NEVER reach the process. We log it and
   *    move on; the next update redraws. This alone turns a stream-killing crash
   *    into a logged warning.
   */
  private enqueueScoreWrite(score: {
    courtId: string;
    left: string;
    right: string;
    leftGames: string;
    rightGames: string;
    leftTeam: string;
    rightTeam: string;
  }): void {
    const run = () =>
      this.writeScoreImage(
        score.courtId,
        score.left,
        score.right,
        score.leftGames,
        score.rightGames,
        score.leftTeam,
        score.rightTeam,
      ).catch((err) => {
        console.error(
          `❌ Score overlay write failed for court ${score.courtId}; skipping this update:`,
          err,
        );
      });

    // Chain after this court's previous write. `run` always resolves (it catches),
    // so the chain never rejects and a failed write can't break the writes after it.
    const prev =
      this.writeChainByCourt.get(score.courtId) ?? Promise.resolve();
    const next = prev.then(run);
    this.writeChainByCourt.set(score.courtId, next);

    // Let the chain drop itself once it has fully drained — but ONLY if nothing new was
    // queued behind it (i.e. this is still the tail). Keeping the entry alive until it
    // settles is what preserves per-court serialisation across an unsubscribe +
    // resubscribe: a write still in flight when the court is torn down stays the tail,
    // so the next write chains behind it instead of racing it on the shared temp file.
    // Deleting only when still-current also stops the map leaking one settled promise
    // per court for the life of the process.
    void next.then(() => {
      if (this.writeChainByCourt.get(score.courtId) === next) {
        this.writeChainByCourt.delete(score.courtId);
      }
    });
  }

  private extractScore(record: Record<string, unknown>): {
    courtId: string;
    left: string;
    right: string;
    leftGames: string;
    rightGames: string;
    leftTeam: string;
    rightTeam: string;
  } | null {
    const courtId = record["court_id"];
    const leftValue = record["red_score"];
    const rightValue = record["blue_score"];
    const leftGamesValue = record["red_games"];
    const rightGamesValue = record["blue_games"];
    const leftTeamValue = record["red_team"];
    const rightTeamValue = record["blue_team"];

    if (
      typeof courtId !== "string" ||
      leftValue === undefined ||
      rightValue === undefined ||
      leftGamesValue === undefined ||
      rightGamesValue === undefined
    ) {
      return null;
    }

    // Team names are optional: older rows / other tables may not carry them,
    // so fall back to the previous generic labels when absent or blank.
    const leftTeam =
      typeof leftTeamValue === "string" && leftTeamValue.trim()
        ? leftTeamValue.trim()
        : "TEAM A";
    const rightTeam =
      typeof rightTeamValue === "string" && rightTeamValue.trim()
        ? rightTeamValue.trim()
        : "TEAM B";

    return {
      courtId,
      left: String(leftValue),
      right: String(rightValue),
      leftGames: String(leftGamesValue),
      rightGames: String(rightGamesValue),
      leftTeam,
      rightTeam,
    };
  }

  private async writeScoreImage(
    courtId: string,
    leftScore: string,
    rightScore: string,
    leftGames: string,
    rightGames: string,
    leftTeam: string,
    rightTeam: string,
  ): Promise<void> {
    const width = 420;
    const height = 120;

    const text = `${leftTeam}|${rightTeam} ${leftScore}-${rightScore} ${leftGames}-${rightGames}`;
    if (text === this.lastRenderedTextByCourt.get(courtId)) {
      return;
    }

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Make transparent background
    ctx.clearRect(0, 0, width, height);

    // Color definitions
    const bgMain = "#010211"; // Dropshot black
    const redAccent = "#f8041d"; // Dropshot red
    const whiteBorder = "#FFFFFF";

    // Parallelogram properties
    const slantX = 12; // Amount of horizontal shift
    const redWidth = 8;
    
    // Draw red accent left border
    ctx.beginPath();
    ctx.moveTo(slantX, 0);
    ctx.lineTo(slantX + redWidth, 0);
    ctx.lineTo(redWidth, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fillStyle = redAccent;
    ctx.fill();

    // Draw main background
    const bgStartX = slantX + redWidth;
    const bgEndX = width;
    const bgBotStartX = redWidth;
    const bgBotEndX = width - slantX;
    
    ctx.beginPath();
    ctx.moveTo(bgStartX, 0);
    ctx.lineTo(bgEndX, 0);
    ctx.lineTo(bgBotEndX, height);
    ctx.lineTo(bgBotStartX, height);
    ctx.closePath();
    ctx.fillStyle = bgMain;
    ctx.fill();

    // The line widths
    const lineWidth = 2;
    ctx.strokeStyle = whiteBorder;
    ctx.lineWidth = lineWidth;

    // Draw horizontal separator
    ctx.beginPath();
    ctx.moveTo(slantX / 2 + redWidth, height / 2); // Middle roughly aligned to slant
    ctx.lineTo(width - slantX / 2, height / 2);
    ctx.stroke();

    // Measurements for columns
    const hasGames = leftGames !== "|" && rightGames !== "|";
    const namesWidth = 240;
    let pointsWidth = 90;
    let gamesWidth = 0;
    
    if (hasGames) {
        gamesWidth = width - namesWidth - pointsWidth;
    } else {
        // Distribute remaining space to points if no games
        pointsWidth = width - namesWidth;
    }

    // Draw vertical separators matching the slant
    const drawSlantedLine = (xOffset: number) => {
        ctx.beginPath();
        ctx.moveTo(slantX + xOffset, 0);
        ctx.lineTo(xOffset, height);
        ctx.stroke();
    };

    drawSlantedLine(namesWidth);
    if (hasGames) {
        drawSlantedLine(namesWidth + pointsWidth);
    }

    // Typography
    ctx.fillStyle = "#FFFFFF";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    // Team Names
    ctx.font = "300 28px sans-serif";
    const namePad = 40;
    // Clamp names to the width of the names column (up to the first slanted
    // separator) so a long name is ellipsized instead of bleeding over the
    // points/games columns. 8px right gap keeps it clear of the divider.
    const maxNameWidth = namesWidth - namePad - 8;
    const leftName = this.truncateToWidth(ctx, leftTeam.toUpperCase(), maxNameWidth);
    const rightName = this.truncateToWidth(ctx, rightTeam.toUpperCase(), maxNameWidth);
    ctx.fillText(leftName, namePad, height / 4 + 2);
    ctx.fillText(rightName, namePad - (slantX / 2), 3 * height / 4 + 2);

    // Points
    ctx.textAlign = "center";
    ctx.font = "500 42px sans-serif";
    const p1CenterX = namesWidth + pointsWidth / 2 + slantX / 2;
    const p2CenterX = namesWidth + pointsWidth / 2;
    ctx.fillText(leftScore, p1CenterX, height / 4 + 4);
    ctx.fillText(rightScore, p2CenterX, 3 * height / 4 + 4);

    // Games
    if (hasGames) {
        ctx.font = "400 36px sans-serif";
        const g1CenterX = namesWidth + pointsWidth + gamesWidth / 2 + slantX / 2;
        const g2CenterX = namesWidth + pointsWidth + gamesWidth / 2;
        ctx.fillText(leftGames, g1CenterX, height / 4 + 2);
        ctx.fillText(rightGames, g2CenterX, 3 * height / 4 + 2);
    }

    const scoreImagePath = this.getScoreImagePath(courtId);
    await fs.mkdir(path.dirname(scoreImagePath), { recursive: true });
    const buffer = canvas.encodeSync('png');
    
    // One fixed temp path per court is safe ONLY because writes are serialised per
    // court (see enqueueScoreWrite) — nothing else is touching this file right now.
    const tempPath = `${scoreImagePath}.tmp`;
    await fs.writeFile(tempPath, buffer);
    await fs.rename(tempPath, scoreImagePath);

    // Mark this score rendered only AFTER it has landed on disk. Serialisation
    // means the court's next update runs after this line, so an identical score is
    // correctly skipped by the guard above — while a write that FAILED never marks
    // itself done (the error is caught in enqueueScoreWrite), so it simply redraws
    // on the next update instead of being silently suppressed. This is why the
    // marker stays here and is not moved before the awaits.
    this.lastRenderedTextByCourt.set(courtId, text);
  }

  /**
   * Trim `text` with a trailing ellipsis until it fits within `maxWidth` at the
   * context's current font. Returns the text unchanged when it already fits.
   */
  private truncateToWidth(
    ctx: { measureText(text: string): { width: number } },
    text: string,
    maxWidth: number,
  ): string {
    if (ctx.measureText(text).width <= maxWidth) {
      return text;
    }
    const ellipsis = "…";
    let truncated = text;
    while (
      truncated.length > 0 &&
      ctx.measureText(truncated + ellipsis).width > maxWidth
    ) {
      truncated = truncated.slice(0, -1);
    }
    return truncated.length > 0 ? truncated + ellipsis : ellipsis;
  }

  private getScoreImagePath(courtId: string): string {
    return path.join(this.scoreImageDir, `${courtId}.png`);
  }

  /**
   * Stop listening to table changes
   */
  public async stop(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    console.log("🛑 Stopping Supabase listener...");
    await this.supabaseService.unsubscribeAll();
    console.log("✅ All channels unsubscribed");
  }
}
