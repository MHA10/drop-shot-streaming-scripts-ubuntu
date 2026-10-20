import * as fs from "fs";
import * as path from "path";
import { v2 as cloudinaryClient } from "cloudinary";
import { Logger } from "../../application/interfaces/Logger";
import { HttpClient } from "../../application/services/HttpClient";
import { safeSegment } from "../utils/paths";

/**
 * The send queue for finished match stats: heatmap to Cloudinary, numbers to
 * the backend, retried until the backend confirms.
 *
 * ── IN SIMPLE WORDS ──
 * When a match ends, its folder gets a "ready to send" note (pending.json).
 * This class walks those folders, uploads the pictures (the four-map heatmap,
 * each player's own map, and each player's photo sheet) to the image host we
 * already use for logos, then sends the numbers + picture links to the
 * backend. Like a post-office outbox: a letter stays in the tray until the
 * other side signs for it. Once it has, the folder is deleted.
 *
 * ── BUSINESS RULES ──
 * - Stats are sent ONCE per match, at the end, as the complete final record
 *   (docs/stats-db-handoff.md §0–§2, decided 2026-10-16). The envelope fields
 *   (groundId, courtId, matchId, streamId, capturedAt, heatmapUrl) wrap the
 *   reader's stats.json unchanged under `stats`.
 * - matchId is the backend's scored-match id, learned from its match_state
 *   events (MatchStatsService). Null when no scored match was seen; the
 *   backend then picks the match by capturedAt.
 * - Pictures (§4): heatmap.png → heatmapUrl (four maps in one picture);
 *   heatmap-A..D.png → heatmapUrls (the backend shows these on each player's
 *   card); photo-A..D.jpg → photoUrls (cut-outs of each player, so the venue
 *   or the player can match A–D to real people — 2026-10-20).
 * - Photos of people are only uploaded when STATS_SEND_PHOTOS is on (default
 *   off): the backend doesn't store photoUrls yet (asked 2026-10-20), and a
 *   link nobody records is a photo of a real person on a public URL that no
 *   one can find to remove. Turn it on once the backend keeps the field.
 * - Pictures are optional: no Cloudinary keys, or repeated upload failures,
 *   send without the missing links and the numbers still go.
 * - Nothing is sent while STATS_SEND_ENABLED is off — the backend route is
 *   only on staging so far (2026-10-20). Finished matches wait here and go
 *   out once it's on.
 * - A record that is never delivered (rejected, or expired unsent) has its
 *   uploaded pictures deleted from Cloudinary, for the same reason. A delete
 *   that fails is kept and retried hourly (for up to PICTURE_DELETE_GIVE_UP_MS
 *   more), never silently dropped.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - The queue lives on disk, not in memory. The app is restarted by deploys
 *   and crashes; an in-memory queue would silently lose every match that
 *   ended while the backend was briefly unreachable.
 * - Each picture uploads under a fixed name per match with overwrite on, so a
 *   retry replaces the same image instead of piling up copies, and each link
 *   is saved after its first success so a retry only uploads what's missing.
 * - At most ONE match's pictures upload per PICTURE_PACE_MS (about a minute,
 *   counted by time, not per pass), and never sooner than PICTURE_GAP_MS
 *   after the previous upload FINISHED (a slow line can take minutes). A box whose sending was off for days has a
 *   backlog of ~1 MB per match; sent in one burst it would compete with the
 *   live streams for the venue's upload line. A match with nothing to upload
 *   (no pictures, or no Cloudinary keys) is not held back.
 * - 400/413/422 mean "this record itself is wrong" — resending can't fix it,
 *   so it is parked as rejected.json (kept for a look, then expired). Every
 *   other failure, including 404 (route not deployed yet) and 401 (key not
 *   set yet), is retried with growing gaps (1 min doubling to 1 h).
 * - Everything expires after STATS_KEEP_DAYS, sent or not, so a box whose
 *   sending stays off can't fill its disk.
 *
 * ── DO NOT ──
 * - Do NOT throw out of flush(): it runs from a timer next to the live
 *   stream. Every failure is logged and retried.
 * - Do NOT delete a folder before a 2xx — that is the only proof the backend
 *   has the record.
 * - Do NOT touch a folder without match.json: STATS_OUTPUT_DIR is a setting,
 *   and a wrong one must not get some other folder deleted.
 */

export const MATCH_FILE = "match.json";
export const PENDING_FILE = "pending.json";
export const REJECTED_FILE = "rejected.json";
export const STATS_FILE = "stats.json";
export const HEATMAP_FILE = "heatmap.png";
// Written at stop, before the background finish (MatchStatsService header).
export const ENDED_FILE = "ended.json";

/** Written when the reader starts; who/where this match is. */
export interface MatchRecord {
  groundId: string;
  courtId: string;
  matchId: string | null;
  streamId: string | null;
  // Hash of the booking's YouTube key: a different one = a different booking.
  streamKeyHash?: string | null;
  startedAt: string;
}

/** A send the backend refused; kept for a look, its pictures deleted. */
interface RejectedSend extends PendingSend {
  status: number;
  response: string;
  rejectedAt: number;
}

/** Written when the match ends; the send's progress. */
interface PendingSend extends MatchRecord {
  capturedAt: string;
  pictureUrls: Record<string, string>; // picture key -> uploaded link
  pictureIds?: Record<string, string>; // picture key -> Cloudinary id (to delete)
  pictureDeleteAt?: number; // when to retry deletes that failed (not the send retry)
  picturesDone: boolean;
  attempts: number;
  nextAttemptAt: number;
  queuedAt: number;
  lastError?: string;
}

// Files only the live reader needs; dropped once the match is finished.
const WORKING_FILES = [
  "master-tracks.json",
  "master-tracks.json.tmp",
  "segments",
  "photos", // raw cut-outs; the photo sheets built from them stay
  "reader.pid",
  "court.json",
  ENDED_FILE,
];
const SLOTS = ["A", "B", "C", "D"] as const;
type Slot = (typeof SLOTS)[number];
// Every picture the reader may leave, keyed by its name in the send.
const PICTURES: Array<{ key: string; file: string }> = [
  { key: "heatmap", file: HEATMAP_FILE },
  ...SLOTS.map((s) => ({ key: `heatmap-${s}`, file: `heatmap-${s}.png` })),
  ...SLOTS.map((s) => ({ key: `photo-${s}`, file: `photo-${s}.jpg` })),
];
const PERMANENT_REJECT = new Set([400, 413, 422]);
const PICTURE_UPLOAD_TRIES = 3;
const PICTURE_PACE_MS = 55_000; // from the last upload's START; just under the 60 s pass
const PICTURE_GAP_MS = 20_000; // and from its END, so a slow upload still leaves a pause
const PICTURE_DELETE_RETRY_MS = 3600_000;
const PICTURE_DELETE_GIVE_UP_MS = 7 * 24 * 3600_000;

export interface OutboxSettings {
  sendEnabled: boolean;
  sendPhotos: boolean;
  keepDays: number;
}

export interface CloudinarySettings {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

export class MatchStatsOutbox {
  private flushing = false;
  private flushAgain = false;
  private loggedSendOff = false;
  private lastPictureUploadAt = 0; // when the last upload started
  private lastPictureUploadEndAt = 0;

  constructor(
    private readonly rootDir: string,
    private readonly settings: OutboxSettings,
    private readonly cloudinary: CloudinarySettings,
    private readonly httpClient: HttpClient,
    private readonly logger: Logger
  ) {}

  /** Every match folder (<root>/<court>/<match>), oldest first. */
  public listMatchDirs(): string[] {
    const dirs: string[] = [];
    for (const court of safeReaddir(this.rootDir)) {
      const courtDir = path.join(this.rootDir, court);
      for (const match of safeReaddir(courtDir)) {
        const dir = path.join(courtDir, match);
        if (isDir(dir)) dirs.push(dir);
      }
    }
    return dirs.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  }

  /**
   * Mark a finished match ready to send and drop the reader's working files.
   * `capturedAt` defaults to now (pass the last-activity time for a match that
   * was interrupted and is being closed later).
   */
  public enqueue(matchDir: string, capturedAt: Date = new Date()): void {
    const match = readJson<MatchRecord>(path.join(matchDir, MATCH_FILE));
    if (!match) {
      this.logger.warn("Match stats folder has no match record; discarding", { matchDir });
      fs.rmSync(matchDir, { recursive: true, force: true });
      return;
    }
    const pending: PendingSend = {
      ...match,
      capturedAt: capturedAt.toISOString(),
      pictureUrls: {},
      picturesDone: false,
      attempts: 0,
      nextAttemptAt: 0,
      queuedAt: Date.now(),
    };
    writeJsonAtomic(path.join(matchDir, PENDING_FILE), pending);
    for (const name of WORKING_FILES) {
      fs.rmSync(path.join(matchDir, name), { recursive: true, force: true });
    }
    this.logger.info("Match stats queued to send", {
      courtId: match.courtId,
      matchDir,
      sendEnabled: this.settings.sendEnabled,
    });
  }

  /**
   * Try every due send once. A call that lands mid-pass runs one more pass
   * right after, so a match queued meanwhile isn't left for the next timer
   * tick. Never throws.
   */
  public async flush(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return;
    }
    this.flushing = true;
    try {
      do {
        this.flushAgain = false;
        for (const dir of this.listMatchDirs()) {
          try {
            await this.processDir(dir);
          } catch (error) {
            this.logger.warn("Match stats send step failed", {
              matchDir: dir,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } while (this.flushAgain);
    } finally {
      this.flushing = false;
    }
  }

  private async processDir(dir: string): Promise<void> {
    if (!fs.existsSync(path.join(dir, MATCH_FILE))) return; // not ours (DO NOT)
    const keepMs = this.settings.keepDays * 24 * 3600_000;
    const rejectedPath = path.join(dir, REJECTED_FILE);
    if (fs.existsSync(rejectedPath)) {
      const rejected = readJson<RejectedSend>(rejectedPath);
      const since = rejected?.rejectedAt ?? fs.statSync(rejectedPath).mtimeMs;
      if (rejected && this.picturesLeft(rejected) && Date.now() >= (rejected.pictureDeleteAt ?? 0)) {
        await this.discardPictures(rejected);
        writeJsonAtomic(rejectedPath, rejected);
      }
      const picturesLeft = !!rejected && this.picturesLeft(rejected);
      if (Date.now() > since + keepMs + (picturesLeft ? PICTURE_DELETE_GIVE_UP_MS : 0)) {
        if (picturesLeft) this.logGaveUp(rejected!);
        fs.rmSync(dir, { recursive: true, force: true });
      }
      return;
    }

    const pendingPath = path.join(dir, PENDING_FILE);
    if (!fs.existsSync(pendingPath)) return; // match still running / resumable
    const pending = readJson<PendingSend>(pendingPath);
    if (!pending) {
      this.logger.warn("Unreadable match stats send record; parking it", { matchDir: dir });
      fs.renameSync(pendingPath, rejectedPath);
      return;
    }

    if (Date.now() - pending.queuedAt > keepMs) {
      if (this.picturesLeft(pending)) {
        if (Date.now() < (pending.pictureDeleteAt ?? 0)) return;
        await this.discardPictures(pending);
        if (this.picturesLeft(pending) && Date.now() - pending.queuedAt < keepMs + PICTURE_DELETE_GIVE_UP_MS) {
          writeJsonAtomic(pendingPath, pending); // try those deletes again later (header)
          return;
        }
        if (this.picturesLeft(pending)) this.logGaveUp(pending);
      }
      this.logger.warn("Match stats never sent; deleting after keep period", {
        courtId: pending.courtId,
        matchDir: dir,
        attempts: pending.attempts,
        lastError: pending.lastError,
      });
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }

    // Cheap checks first: this runs every minute over every queued folder.
    if (!this.settings.sendEnabled) {
      if (!this.loggedSendOff) {
        this.loggedSendOff = true;
        this.logger.info("Match stats sending is off (STATS_SEND_ENABLED); keeping them queued", {
          rootDir: this.rootDir,
        });
      }
      return;
    }
    if (Date.now() < pending.nextAttemptAt) return;

    const stats = readJson<object>(path.join(dir, STATS_FILE));
    if (!stats) {
      // The reader only writes numbers once it has seen all four players.
      this.logger.info("Match ended with no stats (players never clearly seen); nothing to send", {
        courtId: pending.courtId,
        matchDir: dir,
      });
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }

    if (!pending.picturesDone) {
      const todo = this.picturesToUpload(dir, pending);
      if (todo.length > 0 && this.hasKeys()) {
        // one match's pictures per PICTURE_PACE_MS, with a PICTURE_GAP_MS pause (header)
        if (Date.now() - this.lastPictureUploadAt < PICTURE_PACE_MS) return;
        if (Date.now() - this.lastPictureUploadEndAt < PICTURE_GAP_MS) return;
        this.lastPictureUploadAt = Date.now();
      }
      const upload = await this.uploadPictures(todo, dir, pending);
      // On a slow line one match's pictures can take minutes; the next must
      // still leave a pause after it, not start straight away (header).
      if (todo.length > 0 && this.hasKeys()) this.lastPictureUploadEndAt = Date.now();
      writeJsonAtomic(pendingPath, pending); // keep the links that did upload
      if (!upload.done) {
        this.recordFailure(pendingPath, pending, `picture upload failed: ${upload.error}`);
        return;
      }
      pending.picturesDone = true;
      writeJsonAtomic(pendingPath, pending);
    }

    const urls = pending.pictureUrls;
    const body = {
      schemaVersion: 1,
      groundId: pending.groundId,
      courtId: pending.courtId,
      matchId: pending.matchId,
      streamId: pending.streamId,
      capturedAt: pending.capturedAt,
      heatmapUrl: urls.heatmap ?? null,
      heatmapUrls: perSlot(urls, "heatmap"),
      photoUrls: perSlot(urls, "photo"),
      stats,
    };

    let res: Response;
    try {
      res = await this.httpClient.postMatchStats(pending.groundId, pending.courtId, body);
    } catch (error) {
      this.recordFailure(
        pendingPath,
        pending,
        error instanceof Error ? error.message : String(error)
      );
      return;
    }

    if (res.ok) {
      this.logger.info("Match stats sent", {
        courtId: pending.courtId,
        status: res.status,
        pictures: Object.keys(urls).length,
        attempts: pending.attempts + 1,
      });
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    }

    const responseText = (await res.text().catch(() => "")).slice(0, 500);
    if (PERMANENT_REJECT.has(res.status)) {
      this.logger.warn("Backend rejected match stats; parking them (resending won't help)", {
        courtId: pending.courtId,
        status: res.status,
        response: responseText,
        matchDir: dir,
      });
      const rejected: RejectedSend = {
        ...pending,
        status: res.status,
        response: responseText,
        rejectedAt: Date.now(),
      };
      await this.discardPictures(rejected);
      writeJsonAtomic(rejectedPath, rejected);
      fs.rmSync(pendingPath, { force: true });
      return;
    }
    this.recordFailure(pendingPath, pending, `HTTP ${res.status} ${responseText}`.trim());
  }

  private recordFailure(pendingPath: string, pending: PendingSend, reason: string): void {
    pending.attempts++;
    const waitMs = Math.min(3600_000, 60_000 * 2 ** (pending.attempts - 1));
    pending.nextAttemptAt = Date.now() + waitMs;
    pending.lastError = reason.slice(0, 300);
    writeJsonAtomic(pendingPath, pending);
    this.logger.warn("Match stats send failed; will retry", {
      courtId: pending.courtId,
      attempts: pending.attempts,
      retryInSec: Math.round(waitMs / 1000),
      reason: pending.lastError,
    });
  }

  // Upload every picture not uploaded yet, saving each link in pending. done=false
  // means "try again later"; done=true means "send now with whatever links we have"
  // (no keys, nothing to upload, or failures that kept repeating).
  private picturesToUpload(dir: string, pending: PendingSend): typeof PICTURES {
    return PICTURES.filter(
      (p) =>
        (this.settings.sendPhotos || !p.key.startsWith("photo-")) &&
        !pending.pictureUrls[p.key] &&
        fs.existsSync(path.join(dir, p.file))
    );
  }

  private async uploadPictures(
    todo: typeof PICTURES,
    dir: string,
    pending: PendingSend
  ): Promise<{ done: boolean; error?: string }> {
    if (todo.length === 0) return { done: true };
    const c = this.cloudinary;
    if (!this.hasKeys()) {
      this.logger.warn("Cloudinary keys not set; sending match stats without pictures", {
        courtId: pending.courtId,
      });
      return { done: true };
    }
    cloudinaryClient.config({
      cloud_name: c.cloudName,
      api_key: c.apiKey,
      api_secret: c.apiSecret,
    });
    let firstError: string | undefined;
    for (const picture of todo) {
      try {
        const result = await cloudinaryClient.uploader.upload(path.join(dir, picture.file), {
          folder: `dropshot/match-stats/${safeSegment(pending.groundId)}/${safeSegment(pending.courtId)}`,
          public_id: `${safeSegment(path.basename(dir))}-${picture.key}`,
          overwrite: true,
          resource_type: "image",
          timeout: 60_000,
        });
        pending.pictureUrls[picture.key] = result.secure_url;
        (pending.pictureIds ??= {})[picture.key] = result.public_id;
      } catch (error) {
        firstError ??= `${picture.key}: ${error instanceof Error ? error.message : JSON.stringify(error)}`;
      }
    }
    if (!firstError) return { done: true };
    if (pending.attempts + 1 >= PICTURE_UPLOAD_TRIES) {
      this.logger.warn("Picture upload keeps failing; sending match stats without the missing ones", {
        courtId: pending.courtId,
        error: firstError,
      });
      return { done: true };
    }
    return { done: false, error: firstError };
  }

  private hasKeys(): boolean {
    const c = this.cloudinary;
    return !!(c.cloudName && c.apiKey && c.apiSecret);
  }

  private picturesLeft(rec: PendingSend): boolean {
    return Object.keys(rec.pictureIds ?? {}).length > 0;
  }

  // Delete this record's uploaded pictures (it will never be delivered, so
  // nothing would ever point at them). Ids whose delete failed stay in
  // rec.pictureIds and are retried after PICTURE_DELETE_RETRY_MS. Never throws.
  private async discardPictures(rec: PendingSend): Promise<void> {
    const ids = rec.pictureIds ?? {};
    if (Object.keys(ids).length === 0) return;
    const left: Record<string, string> = {};
    if (!this.hasKeys()) {
      Object.assign(left, ids);
    } else {
      const c = this.cloudinary;
      cloudinaryClient.config({ cloud_name: c.cloudName, api_key: c.apiKey, api_secret: c.apiSecret });
      for (const [key, id] of Object.entries(ids)) {
        try {
          // invalidate: also drop the copies Cloudinary's CDN still serves.
          const result = await cloudinaryClient.uploader.destroy(id, {
            resource_type: "image",
            invalidate: true,
          });
          if (result?.result !== "ok" && result?.result !== "not found") {
            throw new Error(`destroy answered ${JSON.stringify(result)}`);
          }
          delete rec.pictureUrls[key];
        } catch (error) {
          left[key] = id;
          this.logger.warn("Could not delete an undelivered match picture; will retry", {
            courtId: rec.courtId,
            publicId: id,
            error: error instanceof Error ? error.message : JSON.stringify(error),
          });
        }
      }
    }
    rec.pictureIds = left;
    if (Object.keys(left).length > 0) rec.pictureDeleteAt = Date.now() + PICTURE_DELETE_RETRY_MS;
  }

  private logGaveUp(rec: PendingSend): void {
    this.logger.error("Gave up deleting undelivered match pictures; remove them by hand", {
      courtId: rec.courtId,
      publicIds: Object.values(rec.pictureIds ?? {}),
    });
  }
}

// {A: link, ...} for one kind of picture, or null when none uploaded.
function perSlot(urls: Record<string, string>, kind: string): Partial<Record<Slot, string>> | null {
  const out: Partial<Record<Slot, string>> = {};
  for (const s of SLOTS) {
    const url = urls[`${kind}-${s}`];
    if (url) out[s] = url;
  }
  return Object.keys(out).length ? out : null;
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
