import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { Logger } from "../../application/interfaces/Logger";
import { SegmentRecord } from "./HighlightBufferManager";
import { ensureDirSync, safeSegment } from "../utils/paths";
import { spawnToFile } from "../utils/spawnToFile";
import { withLowPriority } from "../utils/lowPriority";

/**
 * Cuts a highlight clip out of the rolling buffer's segment files.
 *
 * ── IN SIMPLE WORDS ──
 * Given the buffered video chunks that overlap a time window, this stitches
 * them together and trims to exactly the window, producing one clip file. It
 * runs a one-shot ffmpeg, completely separate from the live stream.
 *
 * ── BUSINESS RULES ──
 * - The clip spans [windowStart, windowEnd]; the trim offset is measured from
 *   the FIRST overlapping segment's start (which sits at or before windowStart,
 *   guaranteed by the buffer manifest's leading-edge check).
 * - The extracted clip is RAW (no logos/crop). Ball-tracking reframe + logo
 *   overlay (Phase 5) run on this clip afterwards; here we only get the window
 *   right.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - Output-side `-ss`/`-t` (after `-i`) + a real re-encode gives a
 *   frame-accurate cut. Stream-copy would snap to the nearest keyframe (up to
 *   `bufferSegmentSec` off) — unacceptable for a tight highlight window.
 * - temp-file + atomic rename: a killed/failed ffmpeg never leaves a corrupt
 *   clip at the final path. Fail-soft: any error returns null (logged), never
 *   throws into the caller — a failed highlight must not disrupt anything.
 *
 * - Segments are HARDLINKED into a private dir before ffmpeg reads them. The
 *   retention sweeper runs every 5s and this re-encode takes ~30s, so without
 *   pinning the sweeper deletes segments ffmpeg hasn't reached yet — and
 *   ffmpeg then TRUNCATES THE OUTPUT AND EXITS 0. That silent success turned a
 *   30s window into a 9.12s clip while every log line reported normal.
 *
 * ── DO NOT ──
 * - Do NOT assume success — callers must handle a null return.
 * - Do NOT put the buffer dir and the output dir on different filesystems.
 *   Hardlinks cannot cross a filesystem boundary, so pinning silently degrades
 *   to the racy behaviour above (it is logged, but the reels get short again).
 * - Do NOT treat a zero exit from ffmpeg as "the clip is complete" — compare
 *   the probed duration against the requested window, which is what the
 *   shortfall warning below does.
 */
export class HighlightExtractorService {
  // Generous: runs at low priority (see withLowPriority), so it may take
  // longer under load — better slow than killed. Live stream is protected.
  private readonly extractTimeoutMs = 120_000;

  constructor(
    private readonly outputDir: string,
    private readonly logger: Logger
  ) {}

  /**
   * Concat the overlapping segments and trim to [windowStartMs, windowEndMs].
   * Returns the written clip path, or null on any failure.
   */
  public async extractWindow(
    segments: SegmentRecord[],
    windowStartMs: number,
    windowEndMs: number,
    courtId: string
  ): Promise<string | null> {
    if (segments.length === 0) return null;

    const stamp = windowStartMs; // stable, sortable id for the clip
    const courtOut = path.join(this.outputDir, safeSegment(courtId));
    const listPath = path.join(courtOut, `.concat-${stamp}.txt`);
    const pinDir = path.join(courtOut, `.pin-${stamp}`);
    const dest = path.join(courtOut, `highlight-${stamp}.mp4`);

    try {
      ensureDirSync(courtOut);

      // PIN THE SEGMENTS BEFORE READING THEM.
      //
      // The retention sweeper deletes buffer segments on a 5s timer, and this
      // re-encode takes ~30s at nice 19 on a loaded box. Without pinning, the
      // sweeper unlinks segments this ffmpeg has NOT REACHED YET, ffmpeg hits
      // "Error during demuxing: No such file or directory" — and then EXITS 0
      // with a truncated file. That silent success is what made this so hard
      // to see: a 30s window came out at 9.12s and every log line said fine.
      //
      // A hardlink is a second name for the same inode. Once we hold one, the
      // sweeper's unlink only removes ITS name; the data stays alive until we
      // drop ours in the finally below. No locks, no coordination with the
      // sweeper, and no copy — this is a directory entry, not the video.
      const pinned = this.pinSegments(segments, pinDir, courtId);
      if (pinned.length === 0) return null;

      // concat demuxer list. Entries MUST be absolute: ffmpeg resolves relative
      // `file` paths against the LIST FILE's directory (not CWD), so with the
      // default relative bufferDir the segments would be looked up under the
      // output dir and never found. path.resolve makes this unambiguous.
      // Escape single quotes per ffmpeg's list syntax.
      const listBody = pinned
        .map((p) => `file '${path.resolve(p).replace(/'/g, "'\\''")}'`)
        .join("\n");
      fs.writeFileSync(listPath, `${listBody}\n`);

      const offsetSec = Math.max(0, (windowStartMs - segments[0].startMs) / 1000);
      const durationSec = Math.max(0, (windowEndMs - windowStartMs) / 1000);
      if (durationSec <= 0) {
        this.logger.warn("Highlight extraction skipped: non-positive window", {
          courtId,
          windowStartMs,
          windowEndMs,
        });
        return null;
      }

      // Low CPU priority so this re-encode can't starve the live ffmpeg.
      const { command, args } = withLowPriority("ffmpeg", [
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", listPath,
        // output-side seek/duration → frame-accurate cut of the window
        "-ss", String(offsetSec),
        "-t", String(durationSec),
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-an",
      ]);
      await spawnToFile(command, args, dest, this.extractTimeoutMs);

      // Log the ACTUAL duration alongside the requested one. Logging only the
      // request hid a real bug: the buffer's segments carry the camera
      // sub-stream's timing, so a 30s window can extract to a far shorter clip
      // and nothing in the logs said so. A mismatch here means the reel is
      // time-compressed and every downstream step inherits it.
      const actualSec = await this.probeDurationSec(dest);
      const shortfall =
        actualSec !== null && durationSec > 0
          ? 1 - actualSec / durationSec
          : 0;
      this.logger.info("Highlight clip extracted", {
        courtId,
        dest,
        segments: segments.length,
        offsetSec,
        requestedSec: durationSec,
        actualSec: actualSec !== null ? +actualSec.toFixed(2) : undefined,
      });
      // >10% short is not rounding — it means duration is being lost upstream.
      if (shortfall > 0.1) {
        this.logger.warn(
          "Highlight clip is much shorter than the requested window — the reel will look sped up",
          {
            courtId,
            requestedSec: durationSec,
            actualSec: actualSec !== null ? +actualSec.toFixed(2) : undefined,
            lostPct: Math.round(shortfall * 100),
            hint: "segments went missing mid-read (ffmpeg truncates and still exits 0) — check the pinning warning above",
          }
        );
      }
      return dest;
    } catch (error) {
      this.logger.warn("Highlight extraction failed", {
        courtId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      fs.unlink(listPath, () => {}); // best-effort cleanup of the list file
      // Drop our hardlinks. For segments the sweeper already unlinked, this is
      // the last reference and the disk space is reclaimed here.
      fs.rm(pinDir, { recursive: true, force: true }, () => {});
    }
  }

  /**
   * Hardlink each segment into `pinDir` so the retention sweeper cannot delete
   * the data out from under ffmpeg. Returns the pinned paths, in order.
   *
   * A segment that is ALREADY gone is skipped rather than passed through: the
   * concat demuxer aborts the whole remaining list on a missing file, so
   * skipping one costs a small jump while passing it through costs everything
   * after it.
   */
  private pinSegments(
    segments: SegmentRecord[],
    pinDir: string,
    courtId: string
  ): string[] {
    ensureDirSync(pinDir);
    const pinned: string[] = [];
    let missing = 0;
    let unlinkable = 0;

    for (const seg of segments) {
      const src = path.resolve(seg.path);
      const dst = path.join(pinDir, path.basename(src));
      try {
        fs.linkSync(src, dst);
        pinned.push(dst);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          missing++; // swept between the manifest query and now
          continue;
        }
        // EXDEV (different filesystem) or EPERM: we cannot pin, but the file is
        // there right now. Use it directly and accept the original race rather
        // than dropping footage we can still read.
        unlinkable++;
        pinned.push(src);
      }
    }

    if (missing > 0 || unlinkable > 0) {
      this.logger.warn("Some highlight segments could not be pinned", {
        courtId,
        missing,
        unlinkable,
        pinned: pinned.length,
        of: segments.length,
        hint:
          unlinkable > 0
            ? "buffer and output dirs are on different filesystems — put them on one volume so segments can be hardlinked"
            : "segments were swept before pinning; raise HIGHLIGHT_BUFFER_RETENTION_SEC",
      });
    }
    return pinned;
  }

  /** Actual duration of `file` in seconds, or null if it can't be probed. */
  private probeDurationSec(file: string): Promise<number | null> {
    return new Promise((resolve) => {
      const proc = spawn("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1",
        file,
      ]);
      let out = "";
      proc.stdout?.on("data", (d) => (out += d.toString()));
      proc.on("exit", (code) => {
        const dur = parseFloat(out.trim());
        resolve(code === 0 && Number.isFinite(dur) && dur > 0 ? dur : null);
      });
      proc.on("error", () => resolve(null));
    });
  }

}
