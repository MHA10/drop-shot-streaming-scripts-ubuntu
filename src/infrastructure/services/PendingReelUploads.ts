import * as fs from "fs";
import * as path from "path";
import { Logger } from "../../application/interfaces/Logger";
import { ReelUploadRequest } from "./YouTubeUploadService";

/**
 * Retries reel uploads that failed, until the venue's internet comes back.
 *
 * ── IN SIMPLE WORDS ──
 * When a reel can't be uploaded the file stays on disk, but nothing ever picks
 * it up again — so a 30-second internet blip costs a highlight permanently and
 * leaves a 6 MB file behind forever. This parks a small note beside the reel
 * and re-tries it on a timer. The moment the connection is back the reel goes
 * up on its own, and the note and the file are cleaned up.
 *
 * Observed at Hello Padel, 25 Oct 2026: heartbeat, SSE and reel upload all
 * failed together in one ~30s window (the box's uplink, not the backend — the
 * other venue saw nothing). The pipeline had done everything right; only the
 * network leg failed, and the reel was stranded.
 *
 * ── BUSINESS RULES ──
 * - A pending upload SURVIVES A RESTART. The note is a file beside the reel,
 *   not memory, because the usual way a venue's connection recovers is
 *   overnight — long after the process that failed has been restarted.
 * - Retries back off. A box that is offline for an hour must not spend that
 *   hour re-POSTing a 6 MB file; each failure doubles the wait, capped.
 * - One at a time. A backlog of reels must never saturate the venue's uplink
 *   while a live stream is pushing to YouTube over the same connection.
 * - Giving up keeps the reel. After maxAgeHours the note is renamed, not
 *   deleted, and the mp4 is left alone — an operator can still find and upload
 *   it by hand. Nothing here ever destroys footage.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - The note holds the court's STREAM KEY, because the backend needs it to
 *   resolve the video's privacy and it cannot be recovered later: by the time
 *   the retry runs, that booking is usually over and the key is gone from
 *   memory. The file is written 0600 for that reason, and removed as soon as
 *   the upload succeeds. It is never logged — see YouTubeUploadService's
 *   "DO NOT" list, which this inherits.
 * - Success is keyed on a real videoId, never on "we tried", exactly as the
 *   first-attempt path is. Anything else deletes footage that never arrived.
 * - A note whose mp4 has vanished is dropped rather than retried forever; the
 *   reel may have been collected by hand, and there is nothing left to send.
 *
 * ── DO NOT ──
 * - Do NOT log the stream key or the note's full contents.
 * - Do NOT run retries in parallel, and do NOT remove the in-flight guard: the
 *   timer can fire again while a slow 6 MB upload is still going, and the
 *   backend would get the same reel twice.
 * - Do NOT delete the mp4 on a failed or abandoned upload. The file is the
 *   only remaining copy.
 */

/** What a parked upload needs to be retried later, as stored on disk. */
interface PendingNote {
  filePath: string;
  courtId: string;
  streamKey: string;
  title: string;
  description?: string;
  preferShort?: boolean;
  firstFailedAtMs: number;
  lastAttemptAtMs: number;
  attempts: number;
}

/** Just the part of the uploader this needs, so tests need no network. */
export interface ReelUploader {
  upload(req: ReelUploadRequest): Promise<string | null>;
}

export const NOTE_SUFFIX = ".upload.json";
export const ABANDONED_SUFFIX = ".upload.abandoned.json";

export class PendingReelUploads {
  private timer: NodeJS.Timeout | null = null;
  // Guards against the timer firing again mid-upload. A 6 MB reel on a venue's
  // uplink can easily outlast the retry interval.
  private draining = false;

  constructor(
    private readonly outputDir: string,
    private readonly uploader: ReelUploader,
    private readonly logger: Logger,
    private readonly retrySec: number,
    private readonly maxAgeHours: number,
    private readonly deleteAfterUpload: boolean,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Park a failed upload so it is retried later. Called on the first-attempt
   * failure path; safe to call for a reel that already has a note (the note is
   * rewritten, preserving the original failure time so the age cap still runs
   * from when the trouble started).
   */
  public park(req: ReelUploadRequest): void {
    const notePath = req.filePath + NOTE_SUFFIX;
    try {
      const existing = this.readNote(notePath);
      const note: PendingNote = {
        filePath: req.filePath,
        courtId: req.courtId,
        streamKey: req.streamKey,
        title: req.title,
        description: req.description,
        preferShort: req.preferShort,
        firstFailedAtMs: existing?.firstFailedAtMs ?? this.now(),
        lastAttemptAtMs: this.now(),
        attempts: (existing?.attempts ?? 0) + 1,
      };
      // 0600: this holds the court's stream key (see the class note).
      fs.writeFileSync(notePath, JSON.stringify(note), { mode: 0o600 });
      this.logger.info("Reel upload parked for retry", {
        courtId: req.courtId,
        filePath: req.filePath,
        attempts: note.attempts,
      });
    } catch (error) {
      this.logger.warn("Could not park reel upload for retry", {
        courtId: req.courtId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Begin retrying on a timer. Also sweeps immediately, which is what picks up
   * reels stranded by a PREVIOUS run of the process.
   */
  public start(): void {
    if (this.timer) return;
    this.logger.info("Pending reel upload retries enabled", {
      outputDir: this.outputDir,
      retrySec: this.retrySec,
      maxAgeHours: this.maxAgeHours,
    });
    void this.drain();
    this.timer = setInterval(() => void this.drain(), this.retrySec * 1000);
    // Never hold the process open for a retry timer.
    this.timer.unref?.();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One pass: retry every note that is due. Serial by design — see DO NOT.
   * Public so a test can drive it without timers.
   */
  public async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (const notePath of this.listNotes()) {
        await this.retryOne(notePath);
      }
    } catch (error) {
      this.logger.warn("Pending reel upload sweep failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.draining = false;
    }
  }

  private async retryOne(notePath: string): Promise<void> {
    const note = this.readNote(notePath);
    if (!note) {
      // Unreadable or truncated (e.g. killed mid-write). Nothing can be done
      // with it and leaving it means parsing it forever.
      this.remove(notePath);
      return;
    }

    // The reel itself is the point; without it there is nothing to send.
    if (!fs.existsSync(note.filePath)) {
      this.logger.info("Pending reel no longer on disk; dropping retry", {
        courtId: note.courtId,
        filePath: note.filePath,
      });
      this.remove(notePath);
      return;
    }

    const ageMs = this.now() - note.firstFailedAtMs;
    if (ageMs > this.maxAgeHours * 3_600_000) {
      // Keep the mp4 and keep a record; just stop trying. Renamed rather than
      // deleted so it is still findable by an operator.
      try {
        fs.renameSync(notePath, note.filePath + ABANDONED_SUFFIX);
      } catch {
        /* best effort */
      }
      this.logger.warn(
        "Giving up on a reel upload; the file is kept on disk for manual recovery",
        {
          courtId: note.courtId,
          filePath: note.filePath,
          attempts: note.attempts,
          ageHours: Math.round(ageMs / 3_600_000),
        }
      );
      return;
    }

    if (this.now() < this.nextAttemptAtMs(note)) return; // backing off

    const videoId = await this.uploader.upload({
      filePath: note.filePath,
      courtId: note.courtId,
      streamKey: note.streamKey,
      title: note.title,
      description: note.description,
      preferShort: note.preferShort,
    });

    if (!videoId) {
      // Still down. Record the attempt so the backoff widens.
      note.attempts += 1;
      note.lastAttemptAtMs = this.now();
      try {
        fs.writeFileSync(notePath, JSON.stringify(note), { mode: 0o600 });
      } catch {
        /* next sweep will try again regardless */
      }
      return;
    }

    this.logger.info("Pending reel uploaded after retry", {
      courtId: note.courtId,
      filePath: note.filePath,
      videoId,
      attempts: note.attempts + 1,
      strandedForSec: Math.round((this.now() - note.firstFailedAtMs) / 1000),
    });
    this.remove(notePath);
    if (this.deleteAfterUpload) {
      try {
        fs.unlinkSync(note.filePath);
        this.logger.info("Local reel deleted after upload", {
          courtId: note.courtId,
          filePath: note.filePath,
          videoId,
        });
      } catch (error) {
        this.logger.warn("Could not delete reel after upload", {
          courtId: note.courtId,
          filePath: note.filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * When this note may next be tried: the retry interval doubled per attempt,
   * capped at 30 minutes. An offline venue must not spend the outage pushing a
   * 6 MB file over and over.
   */
  private nextAttemptAtMs(note: PendingNote): number {
    const base = this.retrySec * 1000;
    const backoff = Math.min(base * 2 ** Math.max(0, note.attempts - 1), 1_800_000);
    return note.lastAttemptAtMs + backoff;
  }

  /** Every pending note under the output dir, oldest failure first. */
  private listNotes(): string[] {
    const found: string[] = [];
    let courts: fs.Dirent[];
    try {
      courts = fs.readdirSync(this.outputDir, { withFileTypes: true });
    } catch {
      return found; // output dir not created yet — nothing has been captured
    }
    for (const entry of courts) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.outputDir, entry.name);
      try {
        for (const file of fs.readdirSync(dir)) {
          // endsWith, not includes: ABANDONED_SUFFIX also ends in .json and
          // must never be picked back up.
          if (file.endsWith(NOTE_SUFFIX)) found.push(path.join(dir, file));
        }
      } catch {
        /* unreadable court dir; skip it */
      }
    }
    return found.sort();
  }

  private readNote(notePath: string): PendingNote | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(notePath, "utf8"));
      if (!parsed?.filePath || !parsed?.courtId) return null;
      return parsed as PendingNote;
    } catch {
      return null;
    }
  }

  private remove(notePath: string): void {
    try {
      fs.unlinkSync(notePath);
    } catch {
      /* already gone */
    }
  }
}
