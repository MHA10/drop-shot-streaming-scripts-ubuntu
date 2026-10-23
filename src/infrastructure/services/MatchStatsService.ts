import * as crypto from "crypto";
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
  DONE_FILE,
  ENDED_FILE,
  MATCH_FILE,
  MatchRecord,
  MatchStatsOutbox,
  PENDING_FILE,
  REJECTED_FILE,
  readJson,
  writeJsonAtomic,
} from "./MatchStatsOutbox";
import {
  MatchRecorder,
  RecorderTiming,
  finalizeMatchFolder,
  writeMatchSummary,
} from "./MatchRecorder";

/**
 * Near-live match stats for each live court in STATS_COURTS (all by default),
 * up to STATS_MAX_READERS at once: start a reader when a court
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
 * - A start with a DIFFERENT YouTube stream key on a court that is already
 *   live is a new booking: the start use-case stops the old stream and starts
 *   the new one (StartStreamUseCase, INVALID_YOUTUBE_STREAM_KEY), so the old
 *   match is closed and a new record begins. Same key = same match (retry,
 *   duplicate, reconciliation). Only a hash of the key is kept on disk.
 * - Events for a booking that has already ended are ignored: a late or
 *   retried start with an ended booking's key (the start use-case answers it
 *   as a duplicate and still returns that old stream), or a stop carrying an
 *   earlier booking's key. Either would otherwise close the current booking's
 *   stats part-way, and a late start would refile the fragment under the old
 *   booking (the backend replaces by match/stream, overwriting real stats).
 * - At most STATS_MAX_READERS readers at once (default 1 — the only proven
 *   speed result is one reader on a 4-core box). A reader still wrapping up
 *   its last clip counts too.
 * - STATS_COURTS, when set, limits stats to those courts; others never take
 *   the reader (Padel Central 2026-10-23: Court 1 only). Without it the first
 *   court to go live gets the reader, so which court has stats changes from
 *   booking to booking, and after an app restart the reader can move to the
 *   other court mid-booking. Listing more courts than STATS_MAX_READERS brings
 *   that first-come behaviour back among the listed ones. Entries that don't
 *   look like a court id are warned about at boot: a typo would otherwise cost
 *   every court its stats with only one quiet line per court to show for it.
 * - The reader only ever reads the camera's low-res stream; if we can't work
 *   out its address, that court gets no stats (unless STATS_ALLOW_MAIN_STREAM).
 * - The record names its scored match (the backend's live_match id) so the
 *   stats land on the right game. The backend tells us which match is active
 *   on each court in `match_state` events, not in the start event (ds-backend
 *   staging, MatchSignalService, checked 2026-10-20). No match seen = matchId
 *   null, and the backend picks the match by time instead.
 * - If a second scored match starts during one stream, the record is filed
 *   under the newest match (same choice the backend makes when it guesses).
 * - A match id already on this court's previous record is never put on the
 *   next one: the backend REPLACES a record with the same match id, so reusing
 *   it (a scorer who hasn't ended the match yet when the next booking starts)
 *   would overwrite the previous booking's stats. "Previous record" = the last
 *   folder closed for the court by ANY path (stop, new key, expired resume,
 *   boot), and the new match id is chosen only after that folder is closed.
 *   Trade-off: if the app is down for more than RESUME_DEADLINE_MS in the
 *   middle of a booking, its first half is closed and the second half is NOT
 *   linked to that match (matchId null; the backend then files it by time).
 *   Losing the link beats overwriting the first half.
 * - Known v1 gap, out of scope here: the reader labels players by which END
 *   they are on, and pairs change ends every two games, so over a full match
 *   one label can hold different people (memory: stats-end-change-bug).
 * - Every match folder is also the match's local record, sent or not
 *   (2026-10-23): resources every minute, a snapshot every STATS_SNAPSHOT_MIN,
 *   a final snapshot and summary.md (MatchRecorder). Closing a folder by ANY
 *   path files the final snapshot, right after it is queued.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - The reader is keyed by COURT and survives stream retries. An ffmpeg retry
 *   re-runs the start use-case with a new stream id, but the match on court
 *   continues; restarting the reader there would split the match.
 * - Stop returns at once and finishes in the background (the reader can take
 *   up to FINISH_GRACE_MS to wrap up its last clip). A start that arrives
 *   meanwhile — the next booking on that court, or another court when the
 *   reader limit is full — WAITS for that finish instead of being refused.
 *   Back-to-back bookings are normal: refusing would lose the next match
 *   entirely, and running both would put two player-finders and two camera
 *   connections on a box tuned for one.
 * - The stop writes ended.json BEFORE the background finish. Without it, an
 *   app restart during that finish sees an unfinished recent folder, marks it
 *   resumable, and the next booking continues the old match's file — two
 *   matches in one record.
 * - App shutdown does NOT finish matches; it only asks readers to stop. The
 *   folders stay open so the post-restart start event resumes them. Folders
 *   nobody resumes within RESUME_DEADLINE_MS are closed and queued. That
 *   deadline is kept below the reader's own resume window, or the reader
 *   would treat its saved progress as a previous match and start from zero.
 * - start() never throws and stays short: it runs during app boot, BEFORE the
 *   stream manager exists. An error there exits the app (no court streams);
 *   time spent there delays every court's stream restart. So leftover readers
 *   are stopped in parallel with a short grace (killOrphanReader), and the
 *   first send pass waits for the 60 s timer (the live streams are
 *   reconnecting and the upload line is theirs).
 * - Boot never deletes a folder it doesn't recognise (no match.json):
 *   STATS_OUTPUT_DIR is a setting, and pointing it at the wrong folder must
 *   not wipe that folder.
 * - A safety timer finishes a reader whose stop event never arrives
 *   (STATS_MAX_MATCH_MIN), so a lost event can't keep the CPU busy forever.
 * - The court's last match id and its ended bookings are saved to
 *   <court>/court-memory.json, not just kept in memory. A deploy between two
 *   bookings is normal; forgetting them on restart would let the next booking
 *   take the previous match's id (and overwrite its stats on the backend) or
 *   let a late repeat of the old start close the new booking's stats.
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
 * - Do NOT throw from start/onStreamStarted/onStreamStopped/onMatchState —
 *   they sit in app boot and the live stream's event path.
 * - Do NOT finish a court's reader from the stream-retry path; only the
 *   backend's stop event, a new stream key, or the safety timer ends a match.
 * - Do NOT start a reader for a court whose previous reader is still finishing.
 * - Do NOT skip isStatsCourt() on a new path to startReader (it also guards
 *   startReader itself, so a court outside STATS_COURTS never gets a reader).
 */

export interface MatchStartInfo {
  courtId: string;
  cameraUrl: string;
  streamId: string;
  // The booking's YouTube key; a different one on a live court = a new booking.
  streamKey?: string;
  matchId?: string;
}

interface ActiveReader {
  runner: LiveStatsRunner;
  recorder: MatchRecorder;
  matchDir: string;
  keyHash: string | null;
  guard: NodeJS.Timeout;
}

interface OpenFolder {
  matchDir: string;
  deadline: number;
  keyHash: string | null;
}

const RESUME_DEADLINE_MS = 10 * 60_000;
const READER_RESUME_WINDOW_SEC = 15 * 60;
const FINISH_GRACE_MS = 120_000;
const FLUSH_EVERY_MS = 60_000;
// Backend repeats match_state every minute; 3 min tolerates two lost repeats.
const MATCH_STATE_FRESH_MS = 3 * 60_000;
const COURT_MEMORY_FILE = "court-memory.json";
// Court ids are UUIDs (docs/stats-db-handoff.md).
const COURT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface CourtMemory {
  courtId: string;
  previousMatchId?: string;
  endedKeys?: string[];
}

export class MatchStatsService {
  private readonly readers = new Map<string, ActiveReader>();
  // Courts whose stopped reader is still writing its final numbers.
  private readonly finishing = new Map<string, Promise<void>>();
  // Starts held back until a finishing reader is done (see header).
  private readonly waiting = new Map<string, MatchStartInfo>();
  private readonly activeMatch = new Map<string, { matchId: string | null; seenAt: number }>();
  // The match id on each court's last closed record; never reused (header).
  private readonly previousMatchId = new Map<string, string>();
  // Key hashes of bookings that have ended on each court (header: late events).
  private readonly endedKeys = new Map<string, string[]>();
  private readonly resumable = new Map<string, OpenFolder>();
  // Courts already logged as "not a stats court" (start events repeat).
  private readonly notStatsCourt = new Set<string>();
  private readonly rootDir: string;
  private readonly readerSettings: LiveStatsReaderSettings;
  private readonly outbox: MatchStatsOutbox;
  private readonly settings: AppConfig["stats"];
  private readonly groundId: string;
  private readonly timing: RecorderTiming;
  private timer?: NodeJS.Timeout;

  constructor(
    config: AppConfig,
    httpClient: HttpClient,
    private readonly logger: Logger,
    scriptPath?: string,
    timing?: RecorderTiming // tests only: shorter than a minute
  ) {
    this.settings = config.stats;
    this.groundId = config.groundInfo.groundId;
    this.rootDir = path.resolve(this.settings.outputDir);
    this.timing = timing ?? {
      sampleEveryMs: 60_000,
      snapshotEveryMs: this.settings.snapshotMin * 60_000,
    };
    this.outbox = new MatchStatsOutbox(
      this.rootDir,
      {
        sendEnabled: this.settings.sendEnabled,
        sendPhotos: this.settings.sendPhotos,
        keepDays: this.settings.keepDays,
      },
      config.cloudinary,
      httpClient,
      logger,
      (dir) => writeMatchSummary(dir, { sendEnabled: this.settings.sendEnabled })
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

  /** Boot: clean up after the previous run, then start the send loop. Never throws. */
  public async start(): Promise<void> {
    try {
      // Owner-only: match folders hold photos of players (header).
      fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
      this.loadCourtMemory();
      await this.sweepUnfinished();
    } catch (error) {
      this.logger.error("Match stats boot clean-up failed; continuing without it", {
        rootDir: this.rootDir,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    for (const court of this.settings.courts) {
      if (!COURT_ID_RE.test(court)) {
        this.logger.warn("STATS_COURTS entry is not a court id; no court will match it", {
          entry: court,
        });
      }
    }
    this.logger.info("Match stats enabled", {
      rootDir: this.rootDir,
      maxReaders: this.settings.maxReaders,
      courts: this.settings.courts.length ? this.settings.courts : "all",
      sendEnabled: this.settings.sendEnabled,
      sendPhotos: this.settings.sendPhotos,
      snapshotMin: this.timing.snapshotEveryMs / 60_000,
      keepDays: this.settings.keepDays,
      python: this.readerSettings.pythonPath,
      script: this.readerSettings.scriptPath,
      model: this.readerSettings.modelPath,
    });

    // First send pass on the timer, not now (header: start() stays short).
    this.timer = setInterval(() => {
      try {
        this.closeExpiredResumable();
        void this.outbox.flush().catch(() => {}); // flush never rejects; belt and braces
      } catch (error) {
        this.logger.warn("Match stats housekeeping failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, FLUSH_EVERY_MS);
    this.timer.unref();
  }

  /** A court went live (or a start event repeated). Never throws. */
  public onStreamStarted(info: MatchStartInfo): void {
    try {
      const { courtId } = info;
      if (!this.isStatsCourt(courtId)) {
        if (!this.notStatsCourt.has(courtId)) {
          this.notStatsCourt.add(courtId);
          this.logger.info("No stats for this court: not in STATS_COURTS", {
            courtId,
            statsCourts: this.settings.courts,
          });
        }
        return;
      }
      const keyHash = hashKey(info.streamKey);
      if (keyHash && this.endedKeys.get(courtId)?.includes(keyHash)) {
        this.logger.info("Ignoring a start for a booking that already ended on this court", {
          courtId,
        });
        return;
      }
      const active = this.readers.get(courtId);
      if (active) {
        if (!keyHash || !active.keyHash || keyHash === active.keyHash) return; // same booking
        this.logger.info("New booking on a live court; closing the previous match's stats", {
          courtId,
        });
        this.onStreamStopped(courtId);
      }

      const busy = this.readers.size + this.finishing.size >= this.settings.maxReaders;
      if (this.finishing.has(courtId) || busy) {
        if (this.finishing.size > 0 && this.readers.size < this.settings.maxReaders) {
          if (!this.waiting.has(courtId)) {
            this.logger.info("Match stats will start once the previous match's stats are saved", {
              courtId,
            });
          }
          this.waiting.set(courtId, info);
          return;
        }
        this.logger.info("No stats for this court: reader limit reached", {
          courtId,
          maxReaders: this.settings.maxReaders,
          busyCourts: [...this.readers.keys()],
        });
        return;
      }
      this.startReader(info, keyHash);
    } catch (error) {
      this.logger.warn("Could not start match stats", {
        courtId: info.courtId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The court's match ended. `streamKey` is the stop event's booking key; a
   * stop for an earlier booking leaves the current one alone (header). No key
   * (safety timer, new-key close) = stop whatever runs. Returns at once;
   * finishing runs in the background. Never throws.
   */
  public onStreamStopped(courtId: string, streamKey?: string): void {
    try {
      const keyHash = hashKey(streamKey);
      const otherBooking = (h: string | null | undefined) => !!keyHash && !!h && h !== keyHash;
      if (keyHash) this.rememberEnded(courtId, keyHash);

      const held = this.waiting.get(courtId);
      if (held && !otherBooking(hashKey(held.streamKey))) {
        this.waiting.delete(courtId);
        this.logger.info("Court stopped before its match stats could start", { courtId });
      }
      const active = this.readers.get(courtId);
      if (!active) {
        // Stopped while its folder was waiting to resume after an app restart.
        const open = this.resumable.get(courtId);
        if (open && !otherBooking(open.keyHash)) {
          this.resumable.delete(courtId);
          this.close(courtId, open.matchDir, new Date(lastActivityMs(open.matchDir)));
        }
        return;
      }
      if (otherBooking(active.keyHash)) {
        this.logger.info("Stop for an earlier booking; this court's current match stats carry on", {
          courtId,
        });
        return;
      }
      if (active.keyHash) this.rememberEnded(courtId, active.keyHash);
      this.readers.delete(courtId);
      clearTimeout(active.guard);
      const endedAt = new Date();
      try {
        writeJsonAtomic(path.join(active.matchDir, ENDED_FILE), { endedAt: endedAt.toISOString() });
      } catch {
        // Only a restart during the finish relies on it; the finish goes on.
      }
      this.notePrevious(courtId, active.matchDir);

      // The recorder keeps sampling while the reader wraps up, and stops
      // before the final snapshot so no milestone lands after it.
      const done = active.runner
        .finish(FINISH_GRACE_MS)
        .then(() => {
          active.recorder.stop();
          this.queue(active.matchDir, endedAt);
        })
        .catch((error) =>
          this.logger.warn("Finishing match stats failed", {
            courtId,
            error: error instanceof Error ? error.message : String(error),
          })
        )
        .finally(() => {
          active.recorder.stop();
          this.finishing.delete(courtId);
          this.startWaiting();
        })
        .catch(() => {}); // nothing above throws; a future change must not crash the app
      this.finishing.set(courtId, done);
    } catch (error) {
      this.logger.warn("Could not stop match stats", {
        courtId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Backend match_state: the scored match now active on a court. Never throws. */
  public onMatchState(courtId: string, activeMatchId: string | null): void {
    try {
      this.activeMatch.set(courtId, { matchId: activeMatchId, seenAt: Date.now() });
      const active = this.readers.get(courtId);
      if (active && activeMatchId && activeMatchId !== this.previousMatchId.get(courtId)) {
        this.attachMatch(courtId, active.matchDir, activeMatchId);
      }
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
    for (const { runner, recorder, guard } of this.readers.values()) {
      clearTimeout(guard);
      recorder.stop();
      runner.requestStop();
    }
    this.readers.clear();
    this.waiting.clear();
  }

  private isStatsCourt(courtId: string): boolean {
    const courts = this.settings.courts;
    return courts.length === 0 || courts.includes(String(courtId).toLowerCase());
  }

  private startReader(info: MatchStartInfo, keyHash: string | null): void {
    const { courtId } = info;
    if (!this.isStatsCourt(courtId)) return; // header: DO NOT
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

    const open = this.resumable.get(courtId);
    if (open) this.resumable.delete(courtId);
    const sameBooking = !!open && (!keyHash || !open.keyHash || keyHash === open.keyHash);
    const resumed = !!open && sameBooking && Date.now() < open.deadline;
    // Close the old folder BEFORE choosing the match id (header: previous record).
    if (open && !resumed) this.close(courtId, open.matchDir, new Date(lastActivityMs(open.matchDir)));
    const wanted = info.matchId ?? this.freshMatchId(courtId);
    const matchId = wanted && wanted !== this.previousMatchId.get(courtId) ? wanted : null;
    let matchDir: string;
    if (open && resumed) {
      matchDir = open.matchDir;
      if (matchId) this.attachMatch(courtId, matchDir, matchId);
    } else {
      matchDir = this.newMatchDir(info, matchId, keyHash);
    }

    const runner = new LiveStatsRunner(courtId, matchDir, cameraUrl, this.readerSettings, this.logger);
    runner.start();
    const recorder = new MatchRecorder(courtId, matchDir, () => runner.pid(), this.timing, this.logger);
    recorder.start();
    const guard = setTimeout(() => {
      this.logger.warn("No stop event before the match time limit; finishing stats", {
        courtId,
        maxMatchMin: this.settings.maxMatchMin,
      });
      this.onStreamStopped(courtId);
    }, safetyDelayMs(matchDir, this.settings.maxMatchMin));
    guard.unref();
    this.readers.set(courtId, { runner, recorder, matchDir, keyHash, guard });

    this.logger.info("Match stats started", {
      courtId,
      resumed,
      matchDir,
      matchId,
      camera: maskCameraUrl(cameraUrl),
    });
  }

  // Retry the held-back starts; each re-checks the limits and may wait again.
  private startWaiting(): void {
    for (const [courtId, info] of [...this.waiting]) {
      this.waiting.delete(courtId);
      this.onStreamStarted(info);
    }
  }

  // Unfinished folders from the previous run: resume the recent ones, queue the
  // rest. Leftover readers are stopped first, all at once (header).
  private async sweepUnfinished(): Promise<void> {
    const unfinished: Array<{ dir: string; match: MatchRecord }> = [];
    for (const dir of this.outbox.listMatchDirs()) {
      // Done first: most folders are, now that they're kept after sending.
      if (fs.existsSync(path.join(dir, DONE_FILE))) continue;
      if (fs.existsSync(path.join(dir, PENDING_FILE))) continue;
      if (fs.existsSync(path.join(dir, REJECTED_FILE))) continue;
      const match = readJson<MatchRecord>(path.join(dir, MATCH_FILE));
      if (!match) {
        this.logger.warn("Not a match stats folder; leaving it alone", { dir });
        continue;
      }
      unfinished.push({ dir, match });
    }
    await Promise.all(unfinished.map(({ dir }) => killOrphanReader(dir)));

    for (const { dir, match } of unfinished) {
      try {
        const ended = readJson<{ endedAt?: string }>(path.join(dir, ENDED_FILE));
        const last = lastActivityMs(dir);
        if (ended) {
          // Stopped, but the app went down before the finish was queued.
          const at = ended.endedAt ? new Date(ended.endedAt) : new Date(last);
          this.notePrevious(match.courtId, dir);
          if (match.streamKeyHash) this.rememberEnded(match.courtId, match.streamKeyHash);
          this.closeFolder(dir, Number.isNaN(at.getTime()) ? new Date(last) : at);
        } else if (Date.now() - last < RESUME_DEADLINE_MS) {
          // Folders are oldest-first, so a newer one for the court wins.
          const older = this.resumable.get(match.courtId);
          if (older) {
            this.notePrevious(match.courtId, older.matchDir);
            this.closeFolder(older.matchDir, new Date(lastActivityMs(older.matchDir)));
          }
          this.resumable.set(match.courtId, {
            matchDir: dir,
            deadline: last + RESUME_DEADLINE_MS,
            keyHash: match.streamKeyHash ?? null,
          });
          this.logger.info("Unfinished match stats can resume", { courtId: match.courtId, matchDir: dir });
        } else {
          this.notePrevious(match.courtId, dir);
          this.closeFolder(dir, new Date(last));
        }
      } catch (error) {
        this.logger.warn("Could not tidy an unfinished match stats folder", {
          dir,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private queue(matchDir: string, capturedAt: Date): void {
    try {
      this.closeFolder(matchDir, capturedAt);
    } catch (error) {
      this.logger.warn("Could not queue match stats", {
        matchDir,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    void this.outbox.flush().catch(() => {}); // flush never rejects; belt and braces
  }

  // Queue the folder, then file its final snapshot + summary (after, so the
  // summary shows it queued). No send pass here: boot calls this too
  // (header: the first send pass waits for the timer).
  private closeFolder(matchDir: string, capturedAt: Date): void {
    this.outbox.enqueue(matchDir, capturedAt);
    finalizeMatchFolder(matchDir, capturedAt, this.logger, {
      sendEnabled: this.settings.sendEnabled,
    });
  }

  private closeExpiredResumable(): void {
    for (const [courtId, open] of this.resumable) {
      if (Date.now() >= open.deadline) {
        this.resumable.delete(courtId);
        this.close(courtId, open.matchDir, new Date(lastActivityMs(open.matchDir)));
      }
    }
  }

  // A folder that won't run again: remember its match id, then queue it.
  private close(courtId: string, matchDir: string, capturedAt: Date): void {
    this.notePrevious(courtId, matchDir);
    this.queue(matchDir, capturedAt);
  }

  private notePrevious(courtId: string, matchDir: string): void {
    const record = readJson<MatchRecord>(path.join(matchDir, MATCH_FILE));
    if (!record?.matchId || this.previousMatchId.get(courtId) === record.matchId) return;
    this.previousMatchId.set(courtId, record.matchId);
    this.saveCourtMemory(courtId);
  }

  private rememberEnded(courtId: string, keyHash: string): void {
    const list = this.endedKeys.get(courtId) ?? [];
    if (list.includes(keyHash)) return;
    list.push(keyHash);
    this.endedKeys.set(courtId, list.slice(-20)); // a day of bookings is plenty
    this.saveCourtMemory(courtId);
  }

  // header: court-memory.json survives restarts
  private loadCourtMemory(): void {
    for (const name of safeReaddir(this.rootDir)) {
      const memory = readJson<CourtMemory>(path.join(this.rootDir, name, COURT_MEMORY_FILE));
      if (!memory?.courtId) continue;
      if (memory.previousMatchId) this.previousMatchId.set(memory.courtId, memory.previousMatchId);
      if (Array.isArray(memory.endedKeys)) this.endedKeys.set(memory.courtId, memory.endedKeys.slice(-20));
    }
  }

  private saveCourtMemory(courtId: string): void {
    try {
      const dir = path.join(this.rootDir, safeSegment(courtId));
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const memory: CourtMemory = {
        courtId,
        previousMatchId: this.previousMatchId.get(courtId),
        endedKeys: this.endedKeys.get(courtId),
      };
      writeJsonAtomic(path.join(dir, COURT_MEMORY_FILE), memory);
    } catch {
      // Best effort: the in-memory copy still guards this run.
    }
  }

  private freshMatchId(courtId: string): string | null {
    const seen = this.activeMatch.get(courtId);
    if (!seen?.matchId || Date.now() - seen.seenAt > MATCH_STATE_FRESH_MS) return null;
    if (seen.matchId === this.previousMatchId.get(courtId)) return null;
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

  private newMatchDir(info: MatchStartInfo, matchId: string | null, keyHash: string | null): string {
    // Timestamp first, so folder names sort oldest-first.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = path.join(
      this.rootDir,
      safeSegment(info.courtId),
      `${stamp}-${safeSegment(info.streamId)}`
    );
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const record: MatchRecord = {
      groundId: this.groundId,
      courtId: info.courtId,
      matchId,
      streamId: info.streamId,
      streamKeyHash: keyHash,
      startedAt: new Date().toISOString(),
    };
    writeJsonAtomic(path.join(dir, MATCH_FILE), record);
    return dir;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// Enough of a hash to tell two bookings apart without keeping the key itself.
function hashKey(streamKey: string | undefined): string | null {
  if (!streamKey) return null;
  return crypto.createHash("sha256").update(streamKey).digest("hex").slice(0, 16);
}

// Time left before the safety stop, counted from the match's own start: a
// match resumed after an app restart must not get a fresh STATS_MAX_MATCH_MIN.
function safetyDelayMs(matchDir: string, maxMatchMin: number): number {
  const started = Date.parse(readJson<MatchRecord>(path.join(matchDir, MATCH_FILE))?.startedAt ?? "");
  const elapsed = Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0;
  return Math.max(60_000, maxMatchMin * 60_000 - elapsed);
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
