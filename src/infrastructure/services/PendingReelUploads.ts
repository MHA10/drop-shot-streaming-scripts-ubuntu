import * as fs from "fs";
import * as path from "path";
import { Logger } from "../../application/interfaces/Logger";
import { ReelUploadRequest } from "./YouTubeUploadService";

/**
 * Keeps retrying a reel's upload until it lands. There is no giving up.
 *
 * ── IN SIMPLE WORDS ──
 * A reel is queued the moment it exists, before the first upload is even
 * attempted, and the queue entry is only removed once YouTube confirms the
 * video. If the upload fails — a venue's internet blip, a backend hiccup, the
 * box being rebooted mid-transfer — the reel is retried every few minutes,
 * forever, until it goes up. No reel is ever left sitting on a box with
 * nothing coming for it.
 *
 * Observed at Hello Padel, 25 Oct 2026: heartbeat, SSE and the reel upload all
 * failed together in one ~30s window (that box's uplink — the other venue
 * logged nothing). The pipeline had reframed, restored audio and rendered
 * correctly; only the network leg failed, and the reel was stranded.
 *
 * ── BUSINESS RULES ──
 * - A reel is QUEUED BEFORE the first upload attempt, not after a failure.
 *   Queueing on failure leaves a window — process killed mid-transfer — where
 *   a finished reel exists on disk with nothing recording that it still owes
 *   an upload. Enqueue first and that window closes.
 * - A pending upload SURVIVES A RESTART. The queue entry is a file beside the
 *   reel, not memory, because the usual way a venue's connection recovers is
 *   overnight, long after the process that failed has been restarted.
 * - RETRIES NEVER STOP. There is deliberately no attempt limit and no age cap:
 *   a box that has been offline for a day must still upload its reels when the
 *   line comes back, and an operator must never have to hunt for footage that
 *   quietly gave up.
 * - One at a time, on a fixed interval. A backlog must not saturate the venue's
 *   uplink while a live stream is pushing to YouTube over the same connection.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - The entry holds the court's STREAM KEY, because the backend needs it to
 *   resolve the video's privacy and it cannot be recovered later: by the time
 *   a retry runs, that booking is usually over and the key is gone from
 *   memory. The file is written 0600 for that reason and removed as soon as
 *   the upload succeeds. It is never logged — see YouTubeUploadService's
 *   "DO NOT" list, which this inherits.
 * - Success is keyed on a real videoId, never on "we tried", exactly as the
 *   first-attempt path is. Anything else deletes footage that never arrived.
 * - A FIXED interval, not a doubling backoff. Backoff was the first design and
 *   it is wrong here: the longer a box is offline, the longer it would then
 *   wait after recovery, which is precisely backwards for the case this exists
 *   to serve.
 * - A reel with no queue entry is reported, not ignored. It cannot be uploaded
 *   (the stream key is unrecoverable), so the only honest thing is to make it
 *   visible rather than let it sit silently forever.
 *
 * ── DO NOT ──
 * - Do NOT add an attempt limit or an age cap. That is the bug this replaced.
 * - Do NOT log the stream key or an entry's full contents.
 * - Do NOT run retries in parallel, and do NOT remove the in-flight guard: the
 *   timer can fire again while a slow 6 MB upload is still going, and the
 *   backend would get the same reel twice.
 * - Do NOT delete the mp4 on a failed upload. The file is the only copy.
 */

/** What a queued upload needs to be retried later, as stored on disk. */
interface QueueEntry {
  filePath: string;
  courtId: string;
  streamKey: string;
  title: string;
  description?: string;
  preferShort?: boolean;
  queuedAtMs: number;
  lastAttemptAtMs: number;
  attempts: number;
}

/** Just the part of the uploader this needs, so tests need no network. */
export interface ReelUploader {
  upload(req: ReelUploadRequest): Promise<string | null>;
}

export const QUEUE_SUFFIX = ".upload.json";

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
    private readonly deleteAfterUpload: boolean,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Record that this reel owes an upload. Called BEFORE the first attempt, so
   * a reel is never on disk without something recording that it still has to
   * go up — including when the process dies mid-transfer.
   *
   * Re-queueing an already-queued reel keeps its original queue time, so the
   * "stranded for" figure in the logs stays honest.
   */
  public enqueue(req: ReelUploadRequest): void {
    const entryPath = req.filePath + QUEUE_SUFFIX;
    try {
      const existing = this.readEntry(entryPath);
      const entry: QueueEntry = {
        filePath: req.filePath,
        courtId: req.courtId,
        streamKey: req.streamKey,
        title: req.title,
        description: req.description,
        preferShort: req.preferShort,
        queuedAtMs: existing?.queuedAtMs ?? this.now(),
        lastAttemptAtMs: this.now(),
        attempts: existing?.attempts ?? 0,
      };
      // 0600: this holds the court's stream key (see the class note).
      fs.writeFileSync(entryPath, JSON.stringify(entry), { mode: 0o600 });
    } catch (error) {
      this.logger.warn("Could not queue reel upload for retry", {
        courtId: req.courtId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Drop the queue entry for a reel that uploaded successfully on its first
   * attempt. The caller handles deleting the mp4 in that path.
   */
  public resolve(filePath: string): void {
    this.remove(filePath + QUEUE_SUFFIX);
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
   * One pass: retry every queued reel that is due, then report any reel with
   * no queue entry at all. Serial by design — see DO NOT. Public so a test can
   * drive it without timers.
   */
  public async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (const entryPath of this.listEntries()) {
        await this.retryOne(entryPath);
      }
      this.reportOrphans();
    } catch (error) {
      this.logger.warn("Pending reel upload sweep failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.draining = false;
    }
  }

  private async retryOne(entryPath: string): Promise<void> {
    const entry = this.readEntry(entryPath);
    if (!entry) {
      // Unreadable or truncated (e.g. killed mid-write). Nothing can be done
      // with it, and keeping it means re-parsing it on every sweep forever.
      // The mp4 itself is untouched and will be reported as an orphan.
      this.remove(entryPath);
      return;
    }

    // The reel itself is the point; without it there is nothing to send.
    if (!fs.existsSync(entry.filePath)) {
      this.logger.info("Queued reel no longer on disk; dropping it", {
        courtId: entry.courtId,
        filePath: entry.filePath,
      });
      this.remove(entryPath);
      return;
    }

    // Fixed interval, forever. See WHY — a doubling backoff would make a long
    // outage take longest to recover from, which is backwards.
    if (this.now() < entry.lastAttemptAtMs + this.retrySec * 1000) return;

    const videoId = await this.uploader.upload({
      filePath: entry.filePath,
      courtId: entry.courtId,
      streamKey: entry.streamKey,
      title: entry.title,
      description: entry.description,
      preferShort: entry.preferShort,
    });

    if (!videoId) {
      entry.attempts += 1;
      entry.lastAttemptAtMs = this.now();
      try {
        fs.writeFileSync(entryPath, JSON.stringify(entry), { mode: 0o600 });
      } catch {
        /* next sweep tries again regardless */
      }
      // Say so periodically rather than on every attempt: a box that has been
      // offline overnight should leave a readable log, not 200 identical
      // warnings. Every 10th attempt is roughly hourly at the default interval.
      if (entry.attempts % 10 === 0) {
        this.logger.warn("Reel still waiting to upload", {
          courtId: entry.courtId,
          filePath: entry.filePath,
          attempts: entry.attempts,
          waitingForSec: Math.round((this.now() - entry.queuedAtMs) / 1000),
        });
      }
      return;
    }

    this.logger.info("Pending reel uploaded after retry", {
      courtId: entry.courtId,
      filePath: entry.filePath,
      videoId,
      attempts: entry.attempts + 1,
      waitingForSec: Math.round((this.now() - entry.queuedAtMs) / 1000),
    });
    this.remove(entryPath);
    if (this.deleteAfterUpload) {
      try {
        fs.unlinkSync(entry.filePath);
        this.logger.info("Local reel deleted after upload", {
          courtId: entry.courtId,
          filePath: entry.filePath,
          videoId,
        });
      } catch (error) {
        this.logger.warn("Could not delete reel after upload", {
          courtId: entry.courtId,
          filePath: entry.filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Reels with no queue entry. These predate the queue, or lost their entry to
   * a truncated write. They cannot be uploaded automatically — the stream key
   * is not recoverable once the booking has ended — so the only honest
   * handling is to name them rather than let them sit unexplained.
   */
  private reportOrphans(): void {
    const orphans: string[] = [];
    for (const dir of this.courtDirs()) {
      let files: string[];
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      const queued = new Set(
        files.filter((f) => f.endsWith(QUEUE_SUFFIX)).map((f) => f.slice(0, -QUEUE_SUFFIX.length))
      );
      for (const file of files) {
        if (file.endsWith(".mp4") && !queued.has(file)) {
          orphans.push(path.join(dir, file));
        }
      }
    }
    if (orphans.length === 0) return;
    this.logger.warn(
      "Reels on disk with no pending upload; they cannot be uploaded automatically (the court's stream key is gone) and need deleting or uploading by hand",
      { count: orphans.length, files: orphans.slice(0, 10) }
    );
  }

  /** Every queue entry under the output dir, oldest first by name. */
  private listEntries(): string[] {
    const found: string[] = [];
    for (const dir of this.courtDirs()) {
      try {
        for (const file of fs.readdirSync(dir)) {
          if (file.endsWith(QUEUE_SUFFIX)) found.push(path.join(dir, file));
        }
      } catch {
        /* unreadable court dir; skip it */
      }
    }
    return found.sort();
  }

  private courtDirs(): string[] {
    try {
      return fs
        .readdirSync(this.outputDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(this.outputDir, e.name));
    } catch {
      return []; // output dir not created yet — nothing has been captured
    }
  }

  private readEntry(entryPath: string): QueueEntry | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(entryPath, "utf8"));
      if (!parsed?.filePath || !parsed?.courtId) return null;
      return parsed as QueueEntry;
    } catch {
      return null;
    }
  }

  private remove(entryPath: string): void {
    try {
      fs.unlinkSync(entryPath);
    } catch {
      /* already gone */
    }
  }
}
