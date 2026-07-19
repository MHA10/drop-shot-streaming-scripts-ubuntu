import * as fs from "fs";
import * as path from "path";
import { Logger } from "../../application/interfaces/Logger";

/**
 * Bookkeeping for one court's rolling highlight buffer: prunes aged segments
 * and answers "which segment files cover this time window?".
 *
 * ── IN SIMPLE WORDS ──
 * ffmpeg (the live process) writes short video chunks into a folder forever.
 * This class is the janitor + index for that folder: every few seconds it
 * deletes chunks older than the retention window (so the disk can't fill), and
 * on demand it can list the chunks that overlap a requested time span (used
 * later to cut a highlight clip). It runs NO process of its own — the recording
 * is a second output of the live ffmpeg; this is pure filesystem bookkeeping.
 *
 * ── BUSINESS RULES ──
 * - Retention: a chunk is kept only while newer than `retentionSec`. That value
 *   is sized (Config) to exceed the full highlight window (pre + post + lag),
 *   so pruning can never delete footage a pending extraction still needs.
 * - A chunk's start time is read from its filename: the ffmpeg segment muxer
 *   writes `seg-<runToken>-<epochSeconds>.ts` (`-strftime 1`, `%s`), so the
 *   manifest is reconstructable from disk alone — no separate state to persist
 *   or keep in sync, and it survives a restart.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - The sweep is best-effort and NEVER throws: a cleanup failure must not crash
 *   the app or disturb the live stream. Errors are logged and the next tick
 *   retries.
 * - Segment END time is start + `segmentSec`; retention/overlap compare against
 *   END so a chunk is only dropped once its last frame is older than retention.
 *
 * ── DO NOT ──
 * - Do NOT lower `retentionSec` below the extraction window, or a highlight
 *   fired near the retention edge will have its oldest needed chunk already
 *   deleted.
 * - Do NOT assume `getSegmentsInWindow` returns a value — it returns null when
 *   the buffer lacks the requested leading history (callers must handle it).
 */

export interface SegmentRecord {
  path: string;
  startMs: number;
  endMs: number;
}

// Cadence of the retention sweep. Frequent enough that on-disk data never
// exceeds retention by more than a few seconds; cheap (one readdir + a handful
// of unlinks over a ~tens-of-files directory).
const SWEEP_INTERVAL_MS = 5_000;

// Pull the epoch-seconds start time out of `seg-<runToken>-<epoch>.ts`. The
// trailing `-(digits).ts` is always the timestamp (runToken may itself contain
// digits, but the epoch is the final hyphen-delimited numeric group).
const SEGMENT_EPOCH_RE = /-(\d+)\.ts$/;

export class HighlightBufferManager {
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly courtId: string,
    private readonly bufferDir: string,
    private readonly segmentSec: number,
    private readonly retentionSec: number,
    private readonly logger: Logger
  ) {}

  /** Begin the periodic retention sweep. Idempotent. */
  public start(): void {
    if (this.sweepTimer) return;
    this.logger.info("Highlight buffer manager started", {
      courtId: this.courtId,
      bufferDir: this.bufferDir,
      retentionSec: this.retentionSec,
    });
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
  }

  /** Stop the sweep. Idempotent; safe from teardown/retry/shutdown. */
  public stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
      this.logger.info("Highlight buffer manager stopped", {
        courtId: this.courtId,
      });
    }
  }

  /**
   * Ordered segment records overlapping [startMs, endMs], or null when the
   * buffer lacks the leading history to cover the window (e.g. the highlight
   * fired before enough footage was recorded). "Covers the leading edge" means
   * some segment starts at or before startMs.
   */
  public getSegmentsInWindow(
    startMs: number,
    endMs: number
  ): SegmentRecord[] | null {
    const all = this.readSegments();
    if (all.length === 0) return null;

    const overlapping = all.filter(
      (s) => s.endMs > startMs && s.startMs < endMs
    );
    if (overlapping.length === 0) return null;

    // Leading edge must be present — we can never recover un-buffered past.
    if (overlapping[0].startMs > startMs) {
      this.logger.warn("Highlight window missing leading footage", {
        courtId: this.courtId,
        needFromMs: startMs,
        haveFromMs: overlapping[0].startMs,
      });
      return null;
    }

    // Trailing edge must be present — otherwise the clip would be silently
    // short (e.g. the post-roll segment hasn't flushed yet).
    const last = overlapping[overlapping.length - 1];
    if (last.endMs < endMs) {
      this.logger.warn("Highlight window missing trailing footage", {
        courtId: this.courtId,
        needToMs: endMs,
        haveToMs: last.endMs,
      });
      return null;
    }

    // Segments must be contiguous — a hole would shift all following content in
    // the concatenated timeline, so the extracted window would capture the
    // wrong moment. Tolerate sub-second rounding; flag any real gap.
    const maxJoinGapMs = 1000;
    for (let i = 1; i < overlapping.length; i++) {
      if (overlapping[i].startMs - overlapping[i - 1].endMs > maxJoinGapMs) {
        this.logger.warn("Highlight window has a segment gap; aborting", {
          courtId: this.courtId,
          gapAfterMs: overlapping[i - 1].endMs,
          nextStartMs: overlapping[i].startMs,
        });
        return null;
      }
    }

    return overlapping;
  }

  // Best-effort deletion of segments whose last frame is older than retention.
  // Async I/O so the 5s timer never blocks the event loop. Never throws
  // (fire-and-forget from setInterval).
  private async sweep(): Promise<void> {
    try {
      const cutoffMs = Date.now() - this.retentionSec * 1000;
      let files: string[];
      try {
        files = await fs.promises.readdir(this.bufferDir);
      } catch {
        return; // dir not created yet / transient
      }
      let removed = 0;
      for (const file of files) {
        const seg = this.parseSegmentFile(file);
        if (seg && seg.endMs < cutoffMs) {
          try {
            await fs.promises.unlink(seg.path);
            removed++;
          } catch {
            /* file may already be gone; ignore */
          }
        }
      }
      if (removed > 0) {
        this.logger.debug("Highlight buffer swept", {
          courtId: this.courtId,
          removed,
        });
      }
    } catch (error) {
      this.logger.warn("Highlight buffer sweep failed (non-fatal)", {
        courtId: this.courtId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Parse the buffer directory into sorted segment records from filenames.
  // Returns [] when the directory doesn't exist yet or has no valid segments.
  // Synchronous by design: called on-demand (window queries), not on a timer.
  private readSegments(): SegmentRecord[] {
    let files: string[];
    try {
      files = fs.readdirSync(this.bufferDir);
    } catch {
      return []; // dir not created yet / transient
    }

    const records: SegmentRecord[] = [];
    for (const file of files) {
      const seg = this.parseSegmentFile(file);
      if (seg) records.push(seg);
    }
    records.sort((a, b) => a.startMs - b.startMs);
    return records;
  }

  // Map a filename (`seg-<runToken>-<epoch>.ts`) to a record, or null if it
  // isn't a recognizable segment. Shared by readSegments and sweep.
  private parseSegmentFile(file: string): SegmentRecord | null {
    const match = file.match(SEGMENT_EPOCH_RE);
    if (!match) return null;
    const startMs = parseInt(match[1], 10) * 1000;
    if (!Number.isFinite(startMs)) return null;
    return {
      path: path.join(this.bufferDir, file),
      startMs,
      endMs: startMs + this.segmentSec * 1000,
    };
  }
}
