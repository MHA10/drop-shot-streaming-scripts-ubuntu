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
 * ── DO NOT ──
 * - Do NOT assume success — callers must handle a null return.
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
    const dest = path.join(courtOut, `highlight-${stamp}.mp4`);

    try {
      ensureDirSync(courtOut);

      // concat demuxer list. Entries MUST be absolute: ffmpeg resolves relative
      // `file` paths against the LIST FILE's directory (not CWD), so with the
      // default relative bufferDir the segments would be looked up under the
      // output dir and never found. path.resolve makes this unambiguous.
      // Escape single quotes per ffmpeg's list syntax.
      const listBody = segments
        .map((s) => `file '${path.resolve(s.path).replace(/'/g, "'\\''")}'`)
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
            hint: "buffer segments likely carry the camera sub-stream's frame timing",
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
    }
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
