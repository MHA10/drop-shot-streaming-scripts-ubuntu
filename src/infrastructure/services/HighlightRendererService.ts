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
 * Stamps the two logos onto the highlight clip, keeps the court audio, and
 * writes the finished reel. The marks sit in the two bottom corners: DropShot
 * bottom-right as always, the venue's logo bottom-left, smaller and faded.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - It probes the clip's real dimensions and sizes logos from them, so the same
 *   code brands a 1920x1080 full-frame clip and a 608x1080 reel correctly.
 * - Only logos that actually exist on disk are overlaid; a missing client logo
 *   yields a clip with just the DropShot mark rather than a hard failure.
 * - Audio is mapped with "0:a?" and stream-copied: optional because a clip may
 *   legitimately have none, copied because the extractor already made it AAC.
 * - temp-file + atomic rename; fail-soft (returns null, logged) so a render
 *   problem never loses the underlying clip — the caller keeps the source.
 *
 * ── DO NOT ──
 * - Do NOT assume both logos exist; check each.
 * - Do NOT make the audio map mandatory ("0:a") — it turns a silent clip from
 *   a reel with no sound into no reel at all.
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
    private readonly logger: Logger,
    // Client mark size as a fraction of the DropShot mark, and its opacity.
    // Defaults keep it clearly secondary; both are env-tunable per venue in
    // case a client's artwork reads too faintly at these values.
    private readonly clientLogoScale: number = 0.55,
    private readonly clientLogoOpacity: number = 0.65
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

      const args = this.buildRenderArgs(sourceClip, width, height);
      if (!args) {
        this.logger.warn("Highlight render skipped: no logo files present", {
          courtId,
          dsLogoPath: this.dsLogoPath,
          clientLogoPath: this.clientLogoPath,
        });
        return null;
      }

      // Low CPU priority so logo compositing can't starve the live ffmpeg.
      const lp = withLowPriority("ffmpeg", args);
      await spawnToFile(lp.command, lp.args, outPath, this.renderTimeoutMs);
      this.logger.info("Highlight reel rendered", {
        courtId,
        outPath,
        width,
        height,
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

  /**
   * The full ffmpeg argument list for branding a clip of `width`x`height`, or
   * null when neither logo file is on disk.
   *
   * Pure and public so the overlay geometry can be asserted in tests without
   * running ffmpeg — the sizes and corners here are the reel's whole visual
   * identity, and a silent regression in them is invisible until a client
   * complains about the finished video.
   */
  public buildRenderArgs(
    sourceClip: string,
    width: number,
    height: number
  ): string[] | null {
    // Logo bounding box relative to canvas so it reads well at any aspect.
    // A portrait (reel) canvas is narrow, so the 16:9 fraction renders the
    // logos too small — give portrait a larger share of the width. Landscape
    // (the full-frame reel) keeps the original sizing, so that output is
    // unchanged.
    const portrait = height > width;
    const dsBoxW = Math.round(width * (portrait ? 0.4 : 0.26));
    const dsBoxH = Math.round(height * (portrait ? 0.18 : 0.13));

    // The client mark is a secondary credit, not a second brand: smaller and
    // semi-transparent, so the DropShot mark stays dominant. It used to be the
    // same size as DropShot's and pinned to the TOP-right, where on a vertical
    // reel it covered a serious share of the playing area.
    const clientBoxW = Math.round(dsBoxW * this.clientLogoScale);
    const clientBoxH = Math.round(dsBoxH * this.clientLogoScale);

    const marginX = Math.round(width * 0.02);
    const marginY = Math.round(height * 0.02);

    const hasDs = fs.existsSync(this.dsLogoPath);
    const hasClient = fs.existsSync(this.clientLogoPath);

    const logos: Array<{
      file: string;
      boxW: number;
      boxH: number;
      pos: string;
      alpha?: number;
    }> = [];
    // The two marks sit on the same bottom line, one in each corner: DropShot
    // keeps the bottom-RIGHT it has always had, and the client takes the
    // bottom-LEFT. Independent corners, so the client's size can be tuned
    // freely without ever moving the DropShot mark.
    if (hasDs) {
      logos.push({
        file: this.dsLogoPath,
        boxW: dsBoxW,
        boxH: dsBoxH,
        pos: `main_w-overlay_w-${marginX}:main_h-overlay_h-${marginY}`,
      });
    }
    if (hasClient) {
      logos.push({
        file: this.clientLogoPath,
        boxW: clientBoxW,
        boxH: clientBoxH,
        pos: `${marginX}:main_h-overlay_h-${marginY}`,
        alpha: this.clientLogoOpacity,
      });
    }
    if (logos.length === 0) return null;

    const args: string[] = ["-y", "-i", sourceClip];
    logos.forEach((l) => args.push("-i", l.file));

    const steps: string[] = [];
    let cur = "0:v";
    logos.forEach((l, i) => {
      const input = i + 1; // logo inputs follow the source at index 0
      // format=rgba before colorchannelmixer: a logo loaded from a flattened
      // PNG has no alpha plane, and the mixer can only scale a channel that
      // exists — without this the aa= term is a silent no-op.
      const fade =
        l.alpha !== undefined && l.alpha < 1
          ? `,format=rgba,colorchannelmixer=aa=${l.alpha}`
          : "";
      steps.push(
        `[${input}:v] scale=${l.boxW}:${l.boxH}:force_original_aspect_ratio=decrease${fade} [logo${i}];`
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
      // Carry the court audio into the finished reel. Optional map: a
      // silent-camera box, or a clip cut from a pre-audio buffer, has no
      // audio stream and must still render rather than fail. Stream-copied
      // because it is already AAC from the extractor — no second encode.
      "-map", "0:a?",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-c:a", "copy",
      // Web/social-safe output: broadly-compatible pixel format and a moved
      // moov atom so the reel starts playing before it's fully downloaded.
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart"
    );

    return args;
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
