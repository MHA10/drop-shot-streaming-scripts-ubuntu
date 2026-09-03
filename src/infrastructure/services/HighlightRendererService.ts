import * as fs from "fs";
import { spawn } from "child_process";
import { Logger } from "../../application/interfaces/Logger";
import { spawnToFile } from "../utils/spawnToFile";
import { withLowPriority } from "../utils/lowPriority";

/**
 * Overlays the DropShot + client logos onto a highlight clip, producing the
 * final reel. Works on either a full-frame (16:9) clip or a reframed (e.g. 9:16)
 * one — logo sizes/positions are derived from the actual canvas dimensions.
 *
 * ── IN SIMPLE WORDS ──
 * Stamps the two logos onto the highlight clip and writes the finished reel.
 * Logos are sized relative to the video so they look right whether the clip is
 * wide or vertical.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - It probes the clip's real dimensions and sizes logos from them, so the same
 *   code brands a 1920x1080 full-frame clip and a 608x1080 reel correctly.
 * - Only logos that actually exist on disk are overlaid; a missing client logo
 *   yields a clip with just the DropShot mark rather than a hard failure.
 * - temp-file + atomic rename; fail-soft (returns null, logged) so a render
 *   problem never loses the underlying clip — the caller keeps the source.
 *
 * ── DO NOT ──
 * - Do NOT assume both logos exist; check each.
 * - Do NOT assume success — callers must handle a null return (fall back to the
 *   un-branded source clip).
 */
export class HighlightRendererService {
  // Generous: runs at low priority (see withLowPriority), so it may take
  // longer under load — better slow than killed. Live stream is protected.
  private readonly renderTimeoutMs = 120_000;

  constructor(
    private readonly dsLogoPath: string,
    private readonly clientLogoPath: string,
    private readonly logger: Logger
  ) {}

  /**
   * Overlay logos from `sourceClip` into `outPath`. Returns outPath on success,
   * or null on any failure (caller should fall back to the source clip).
   */
  public async render(
    sourceClip: string,
    outPath: string,
    courtId: string
  ): Promise<string | null> {
    try {
      const dims = await this.probeDimensions(sourceClip);
      if (!dims) {
        this.logger.warn("Highlight render skipped: could not probe clip", {
          courtId,
          sourceClip,
        });
        return null;
      }
      const { width, height } = dims;

      // Logos present on disk (top-right = client, bottom-right = DropShot),
      // matching the live-stream corners. Skip any that are missing.
      const logos: Array<{ file: string; pos: string }> = [];
      if (fs.existsSync(this.dsLogoPath)) {
        logos.push({
          file: this.dsLogoPath,
          pos: `main_w-overlay_w-${Math.round(width * 0.02)}:main_h-overlay_h-${Math.round(height * 0.02)}`,
        });
      }
      if (fs.existsSync(this.clientLogoPath)) {
        logos.push({
          file: this.clientLogoPath,
          pos: `main_w-overlay_w-${Math.round(width * 0.02)}:${Math.round(height * 0.02)}`,
        });
      }
      if (logos.length === 0) {
        this.logger.warn("Highlight render skipped: no logo files present", {
          courtId,
          dsLogoPath: this.dsLogoPath,
          clientLogoPath: this.clientLogoPath,
        });
        return null;
      }

      // Logo bounding box relative to canvas so it reads well at any aspect.
      // A portrait (reel) canvas is narrow, so the 16:9 fraction renders the
      // logos too small — give portrait a larger share of the width. Landscape
      // (the full-frame reel) keeps the original sizing, so that output is
      // unchanged.
      const portrait = height > width;
      const boxW = Math.round(width * (portrait ? 0.4 : 0.26));
      const boxH = Math.round(height * (portrait ? 0.18 : 0.13));

      const args: string[] = ["-y", "-i", sourceClip];
      logos.forEach((l) => args.push("-i", l.file));

      const steps: string[] = [];
      let cur = "0:v";
      logos.forEach((l, i) => {
        const input = i + 1; // logo inputs follow the source at index 0
        steps.push(
          `[${input}:v] scale=${boxW}:${boxH}:force_original_aspect_ratio=decrease [logo${i}];`
        );
        const next = i === logos.length - 1 ? "vout" : `v${i}`;
        steps.push(`[${cur}][logo${i}] overlay=${l.pos} [${next}];`);
        cur = next;
      });
      // Drop the trailing ';' on the final step.
      const filter = steps.join(" ").replace(/;\s*$/, "");

      args.push(
        "-filter_complex", filter,
        "-map", "[vout]",
        "-c:v", "libx264",
        "-preset", "veryfast",
        // Web/social-safe output: broadly-compatible pixel format and a moved
        // moov atom so the reel starts playing before it's fully downloaded.
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "-an"
      );

      // Low CPU priority so logo compositing can't starve the live ffmpeg.
      const lp = withLowPriority("ffmpeg", args);
      await spawnToFile(lp.command, lp.args, outPath, this.renderTimeoutMs);
      this.logger.info("Highlight reel rendered", {
        courtId,
        outPath,
        width,
        height,
        logos: logos.length,
      });
      return outPath;
    } catch (error) {
      this.logger.warn("Highlight render failed", {
        courtId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private probeDimensions(
    clip: string
  ): Promise<{ width: number; height: number } | null> {
    return new Promise((resolve) => {
      const proc = spawn("ffprobe", [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height",
        "-of", "csv=p=0",
        clip,
      ]);
      let out = "";
      proc.stdout?.on("data", (d) => {
        out += d.toString();
      });
      proc.on("exit", (code) => {
        if (code !== 0) return resolve(null);
        const m = out.trim().match(/(\d+)\s*,\s*(\d+)/);
        if (!m) return resolve(null);
        resolve({ width: parseInt(m[1], 10), height: parseInt(m[2], 10) });
      });
      proc.on("error", () => resolve(null));
    });
  }
}
