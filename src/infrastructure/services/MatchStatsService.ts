import * as fs from "fs";
import * as path from "path";
import { Logger } from "../../application/interfaces/Logger";
import { HttpClient } from "../../application/services/HttpClient";
import { AppConfig } from "../config/Config";
import { safeSegment } from "../utils/paths";
import { maskCameraUrl, toSubstreamUrl } from "../utils/cameraSubstream";
import {
  LiveStatsReaderSettings,
  LiveStatsRunner,
  killOrphanReader,
} from "./LiveStatsRunner";
import {
  MATCH_FILE,
  MatchRecord,
  MatchStatsOutbox,
  PENDING_FILE,
  REJECTED_FILE,
  readJson,
  writeJsonAtomic,
} from "./MatchStatsOutbox";

/**
 * Near-live match stats for every live court: start a reader when a court
 * goes live, finish it and queue the result when the court stops.
 *
 * ── IN SIMPLE WORDS ──
 * When the backend tells this box "court X is live", we start a stats reader
 * for court X in a new match folder. When it says "court X stopped", we let
 * the reader write its final numbers, then hand the folder to the outbox,
 * which sends it to the backend. If the app itself restarts in the middle of
 * a match, the next "court X is live" picks the same folder back up, so one
 * match stays one record instead of two halves.
 *
 * ── BUSINESS RULES ──
 * - One match = one stream start-to-stop on a court (docs/stats-db-handoff.md
 *   §0: final numbers, sent once, when the match's stream stops).
 * - At most STATS_MAX_READERS courts run a reader at once (default 1 — the
 *   only proven speed result is one reader on a 4-core box).
 * - The reader only ever reads the camera's low-res stream; if we can't work
 *   out its address, that court gets no stats (unless STATS_ALLOW_MAIN_STREAM).
 * - The record names its scored match (the backend's live_match id) so the
 *   stats land on the right game. The backend tells us which match is active
 *   on each court in `match_state` events, not in the start event (ds-backend
 *   staging, MatchSignalService, checked 2026-10-20). No match seen = matchId
 *   null, and the backend picks the match by time instead.
 * - If a second scored match starts during one stream, the record is filed
 *   under the newest match (same choice the backend makes when it guesses).
 * - Known v1 gap, out of scope here: the reader labels players by which END
 *   they are on, and pairs change ends every two games, so over a full match
 *   one label can hold different people (memory: stats-end-change-bug).
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - The reader is keyed by COURT and survives stream retries. An ffmpeg retry
 *   re-runs the start use-case with a new stream id, but the match on court
 *   continues; restarting the reader there would split the match. Duplicate
 *   and reconciliation start events are no-ops for the same reason.
 * - Stop returns at once and finishes in the background. The reader can take
 *   up to a couple of minutes to wrap up its last clip; the stop handler must
 *   not wait on that (a new match on the same court may start right away).
 * - App shutdown does NOT finish matches; it only asks readers to stop. The
 *   folders stay open so the post-restart start event resumes them. Folders
 *   nobody resumes within RESUME_DEADLINE_MS are closed and queued. That
 *   deadline is kept below the reader's own resume window, or the reader
 *   would treat its saved progress as a previous match and start from zero.
 * - A safety timer finishes a reader whose stop event never arrives
 *   (STATS_MAX_MATCH_MIN), so a lost event can't keep the CPU busy forever.
 * - At stream start, a match id is only used if the backend confirmed it in
 *   the last MATCH_STATE_FRESH_MS. The backend repeats match_state every
 *   minute only while a match is active and sends "no match" just once; if
 *   this box missed that one message (SSE reconnect), an ended match's id
 *   would linger and the next stream's stats would be filed under it.
 * - Ending a match (activeMatchId null) does NOT clear the id from the
 *   record: the stats go out after the stream stops, which is usually after
 *   the scorer ends the match.
 *
 * ── DO NOT ──
 * - Do NOT throw from onStreamStarted/onStreamStopped/onMatchState — they sit
 *   in the live stream's event path. Stats must never break a stream.
 * - Do NOT finish a court's reader from the stream-retry path; only the
 *   backend's stop event (or the safety timer) ends a match.
 */

export interface MatchStartInfo {
  courtId: string;
  cameraUrl: string;
  streamId: string;
  matchId?: string;
}

interface ActiveReader {
  runner: LiveStatsRunner;
  matchDir: string;
  guard: NodeJS.Timeout;
}

const RESUME_DEADLINE_MS = 10 * 60_000;
const READER_RESUME_WINDOW_SEC = 15 * 60;
const FINISH_GRACE_MS = 120_000;
const FLUSH_EVERY_MS = 60_000;
// Backend repeats match_state every minute; 3 min tolerates two lost repeats.
const MATCH_STATE_FRESH_MS = 3 * 60_000;

export class MatchStatsService {
  private readonly readers = new Map<string, ActiveReader>();
  private readonly activeMatch = new Map<string, { matchId: string | null; seenAt: number }>();
  private readonly resumable = new Map<string, { matchDir: string; deadline: number }>();
  private readonly rootDir: string;
  private readonly readerSettings: LiveStatsReaderSettings;
  private readonly outbox: MatchStatsOutbox;
  private readonly settings: AppConfig["stats"];
  private readonly groundId: string;
  private timer?: NodeJS.Timeout;

  constructor(
    config: AppConfig,
    httpClient: HttpClient,
    private readonly logger: Logger,
    scriptPath?: string
  ) {
    this.settings = config.stats;
    this.groundId = config.groundInfo.groundId;
    this.rootDir = path.resolve(this.settings.outputDir);
    this.outbox = new MatchStatsOutbox(
      this.rootDir,
      { sendEnabled: this.settings.sendEnabled, keepDays: this.settings.keepDays },
      config.cloudinary,
      httpClient,
      logger
    );
    // Same lookup as PythonBallReframer: inside the npm package first (the
    // build copies scripts/ into dist/), then a repo checkout.
    const candidates = [
      path.join(__dirname, "..", "..", "..", "scripts", "live_stats.py"),
      path.resolve("scripts/live_stats.py"),
    ];
    const python = this.settings.pythonPath;
    this.readerSettings = {
      pythonPath: python.includes("/") ? path.resolve(python) : python,
      scriptPath: scriptPath ?? candidates.find((p) => fs.existsSync(p)) ?? candidates[0],
      modelPath: path.resolve(this.settings.modelPath),
      logoPath: path.resolve("public/ds.png"),
      targetFps: this.settings.targetFps,
      imgsz: this.settings.imgsz,
      threads: this.settings.threads,
      clipSec: this.settings.clipSec,
      resumeWindowSec: READER_RESUME_WINDOW_SEC,
    };
  }

  /** Boot: clean up after the previous run, then start the send loop. */
  public async start(): Promise<void> {
    fs.mkdirSync(this.rootDir, { recursive: true });
    for (const dir of this.outbox.listMatchDirs()) {
      if (fs.existsSync(path.join(dir, PENDING_FILE))) continue;
      if (fs.existsSync(path.join(dir, REJECTED_FILE))) continue;

      // An unfinished match: the app stopped (or crashed) mid-match.
      await killOrphanReader(dir);
      const match = readJson<MatchRecord>(path.join(dir, MATCH_FILE));
      if (!match) {
        fs.rmSync(dir, { recursive: true, force: true });
        continue;
      }
      const last = lastActivityMs(dir);
      if (Date.now() - last < RESUME_DEADLINE_MS) {
        // Folders are oldest-first, so a newer one for the court wins.
        const older = this.resumable.get(match.courtId);
        if (older) this.outbox.enqueue(older.matchDir, new Date(lastActivityMs(older.matchDir)));
        this.resumable.set(match.courtId, { matchDir: dir, deadline: last + RESUME_DEADLINE_MS });
        this.logger.info("Unfinished match stats can resume", { courtId: match.courtId, matchDir: dir });
      } else {
        this.outbox.enqueue(dir, new Date(last));
      }
    }

    this.logger.info("Match stats enabled", {
      rootDir: this.rootDir,
      maxReaders: this.settings.maxReaders,
      sendEnabled: this.settings.sendEnabled,
      python: this.readerSettings.pythonPath,
      script: this.readerSettings.scriptPath,
      model: this.readerSettings.modelPath,
    });

    void this.outbox.flush();
    this.timer = setInterval(() => {
      this.closeExpiredResumable();
      void this.outbox.flush();
    }, FLUSH_EVERY_MS);
    this.timer.unref();
  }

  /** A court went live (or a start event repeated). Never throws. */
  public onStreamStarted(info: MatchStartInfo): void {
    try {
      const { courtId } = info;
      if (this.readers.has(courtId)) return; // same match: retry / duplicate / reconciliation

      if (this.readers.size >= this.settings.maxReaders) {
        this.logger.info("No stats for this court: reader limit reached", {
          courtId,
          maxReaders: this.settings.maxReaders,
          busyCourts: [...this.readers.keys()],
        });
        return;
      }

      const substream = toSubstreamUrl(info.cameraUrl);
      const cameraUrl = substream ?? (this.settings.allowMainStream ? info.cameraUrl : null);
      if (!cameraUrl) {
        this.logger.warn("No stats for this court: can't work out the camera's low-res stream", {
          courtId,
          cameraUrl: maskCameraUrl(info.cameraUrl),
        });
        return;
      }
      for (const [what, file] of [
        ["reader script", this.readerSettings.scriptPath],
        ["model weights (STATS_MODEL_PATH)", this.readerSettings.modelPath],
      ]) {
        if (!fs.existsSync(file)) {
          this.logger.warn(`No stats for this court: ${what} not found`, { courtId, file });
          return;
        }
      }

      let matchDir: string;
      let resumed = false;
      const matchId = info.matchId ?? this.freshMatchId(courtId);
      const open = this.resumable.get(courtId);
      if (open) this.resumable.delete(courtId);
      if (open && Date.now() < open.deadline) {
        matchDir = open.matchDir;
        resumed = true;
        if (matchId) this.attachMatch(courtId, matchDir, matchId);
      } else {
        if (open) this.outbox.enqueue(open.matchDir, new Date(lastActivityMs(open.matchDir)));
        matchDir = this.newMatchDir(info, matchId);
      }

      const runner = new LiveStatsRunner(courtId, matchDir, cameraUrl, this.readerSettings, this.logger);
      runner.start();
      const guard = setTimeout(() => {
        this.logger.warn("No stop event before the match time limit; finishing stats", {
          courtId,
          maxMatchMin: this.settings.maxMatchMin,
        });
        this.onStreamStopped(courtId);
      }, this.settings.maxMatchMin * 60_000);
      guard.unref();
      this.readers.set(courtId, { runner, matchDir, guard });

      this.logger.info("Match stats started", {
        courtId,
        resumed,
        matchDir,
        matchId,
        camera: maskCameraUrl(cameraUrl),
      });
    } catch (error) {
      this.logger.warn("Could not start match stats", {
        courtId: info.courtId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** The court's match ended. Returns at once; finishing runs in the background. */
  public onStreamStopped(courtId: string): void {
    const active = this.readers.get(courtId);
    if (!active) {
      // Stopped while its folder was waiting to resume after an app restart.
      const open = this.resumable.get(courtId);
      if (open) {
        this.resumable.delete(courtId);
        this.queue(open.matchDir, new Date(lastActivityMs(open.matchDir)));
      }
      return;
    }
    this.readers.delete(courtId);
    clearTimeout(active.guard);
    void active.runner
      .finish(FINISH_GRACE_MS)
      .then(() => this.queue(active.matchDir, new Date()))
      .catch((error) =>
        this.logger.warn("Finishing match stats failed", {
          courtId,
          error: error instanceof Error ? error.message : String(error),
        })
      );
  }

  /** Backend match_state: the scored match now active on a court. Never throws. */
  public onMatchState(courtId: string, activeMatchId: string | null): void {
    try {
      this.activeMatch.set(courtId, { matchId: activeMatchId, seenAt: Date.now() });
      const active = this.readers.get(courtId);
      if (active && activeMatchId) this.attachMatch(courtId, active.matchDir, activeMatchId);
    } catch (error) {
      this.logger.warn("Could not record the court's match", {
        courtId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** App shutdown: ask every reader to stop, leave folders open to resume. */
  public shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    for (const { runner, guard } of this.readers.values()) {
      clearTimeout(guard);
      runner.requestStop();
    }
    this.readers.clear();
  }

  private queue(matchDir: string, capturedAt: Date): void {
    try {
      this.outbox.enqueue(matchDir, capturedAt);
    } catch (error) {
      this.logger.warn("Could not queue match stats", {
        matchDir,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    void this.outbox.flush();
  }

  private closeExpiredResumable(): void {
    for (const [courtId, open] of this.resumable) {
      if (Date.now() >= open.deadline) {
        this.resumable.delete(courtId);
        this.queue(open.matchDir, new Date(lastActivityMs(open.matchDir)));
      }
    }
  }

  private freshMatchId(courtId: string): string | null {
    const seen = this.activeMatch.get(courtId);
    if (!seen?.matchId || Date.now() - seen.seenAt > MATCH_STATE_FRESH_MS) return null;
    return seen.matchId;
  }

  // Name the scored match in the folder's record; the outbox sends it from there.
  private attachMatch(courtId: string, matchDir: string, matchId: string): void {
    const file = path.join(matchDir, MATCH_FILE);
    const record = readJson<MatchRecord>(file);
    if (!record || record.matchId === matchId) return;
    if (record.matchId) {
      this.logger.info("A new scored match started during this stream; stats will go to the newest", {
        courtId,
        previousMatchId: record.matchId,
        matchId,
      });
    } else {
      this.logger.info("Match stats linked to the scored match", { courtId, matchId });
    }
    writeJsonAtomic(file, { ...record, matchId });
  }

  private newMatchDir(info: MatchStartInfo, matchId: string | null): string {
    // Timestamp first, so folder names sort oldest-first.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = path.join(
      this.rootDir,
      safeSegment(info.courtId),
      `${stamp}-${safeSegment(info.streamId)}`
    );
    fs.mkdirSync(dir, { recursive: true });
    const record: MatchRecord = {
      groundId: this.groundId,
      courtId: info.courtId,
      matchId,
      streamId: info.streamId,
      startedAt: new Date().toISOString(),
    };
    writeJsonAtomic(path.join(dir, MATCH_FILE), record);
    return dir;
  }
}

// When the reader last wrote progress in this folder.
function lastActivityMs(dir: string): number {
  let last = 0;
  for (const name of ["master-tracks.json", "stats.json", "reader.log", MATCH_FILE]) {
    try {
      last = Math.max(last, fs.statSync(path.join(dir, name)).mtimeMs);
    } catch {
      // not written yet
    }
  }
  return last;
}
