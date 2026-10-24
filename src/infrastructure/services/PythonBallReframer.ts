import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { BallReframer } from "../../domain/services/BallReframer";
import { Logger } from "../../application/interfaces/Logger";
import { withLowPriority } from "../utils/lowPriority";
import { pickCourtRoi } from "../utils/courtRoi";

/**
 * BallReframer backed by a one-shot Python/OpenCV script (scripts/reframe_ball.py).
 *
 * ── IN SIMPLE WORDS ──
 * Hands the raw clip to a small Python program that watches the ball and writes
 * a cropped, vertical version. If Python isn't installed, the script errors, or
 * it takes too long, we just return null and the full-frame clip is used.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * Same one-shot-subprocess pattern as the ffmpeg calls: spawn, wait with a
 * timeout, read back the produced file. It is fail-soft by construction — a
 * missing interpreter, a crash, a timeout, or a missing output file all resolve
 * to null. A highlight must never be lost because tracking misbehaved.
 *
 * ── DO NOT ──
 * - Do NOT let this throw; every error path returns null.
 * - Do NOT enable in production before the CV script is tuned on real padel
 *   footage — until then the crop quality is unproven (hence default OFF).
 */
export class PythonBallReframer implements BallReframer {
  // The reframe is the heaviest highlight stage (two-pass OpenCV). It runs at
  // low CPU priority (see withLowPriority), so on a weak box it can take a
  // while — give it a generous ceiling rather than killing a nearly-done pass.
  // Detection is downscaled + frame-skipped (reframe_ball.py) to keep it well
  // under this in practice.
  private readonly timeoutMs = 240_000;
  private readonly scriptPath: string;

  constructor(
    private readonly reelAspect: string,
    private readonly logger: Logger,
    scriptPath?: string,
    // Court boundary (see utils/courtRoi.ts). "" / {} = no boundary.
    private readonly courtRoi: string = "",
    private readonly courtRoiByCourt: Record<string, string> = {}
  ) {
    // The app ships as an npm package run via `npx` — so the script must be
    // found INSIDE the package (the build copies scripts/ into dist/), not from
    // the CWD. Resolve relative to this compiled module (dist/scripts) first,
    // then fall back to a repo-root checkout (dev / git deploy). __dirname here
    // is <pkg>/dist/src/infrastructure/services, so ../../../scripts = dist/scripts.
    const candidates = [
      path.join(__dirname, "..", "..", "..", "scripts", "reframe_ball.py"),
      path.resolve("scripts/reframe_ball.py"),
    ];
    this.scriptPath =
      scriptPath ?? candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
  }

  public async reframe(
    clipPath: string,
    courtId: string
  ): Promise<string | null> {
    if (!fs.existsSync(this.scriptPath)) {
      this.logger.warn("Ball reframer script missing; using full frame", {
        courtId,
        scriptPath: this.scriptPath,
      });
      return null;
    }

    // Nothing to crop → nothing to track. The reframer takes a window as WIDE
    // as `aspect` allows out of a full-height source, so when the target is as
    // wide as (or wider than) the source there is no horizontal room to pan and
    // the pass would be a pure re-encode: ~40s of CPU on a streamer box for a
    // frame-identical result. Skip it and let the caller use the raw clip.
    //
    // This is the normal case for the default 16:9 target on a 16:9 camera.
    const srcDims = await this.probeDimensions(clipPath);
    if (srcDims) {
      const target = this.parseAspect(this.reelAspect);
      const source = srcDims.width / srcDims.height;
      if (target !== null && target >= source - 0.001) {
        this.logger.info(
          "Ball reframe skipped: target aspect is not narrower than the source, nothing to crop",
          { courtId, aspect: this.reelAspect, source: `${srcDims.width}x${srcDims.height}` }
        );
        return null; // caller falls back to the full-frame clip — the desired result
      }
    }

    const dir = path.dirname(clipPath);
    const base = path.basename(clipPath, path.extname(clipPath));
    const out = path.join(dir, `reframed-${base}.mp4`);

    try {
      // --debug makes the script print a one-line detector summary to stderr
      // (frames / hit_rate / motion); we log it so staging can SEE whether
      // tracking actually locked onto players, not just that the script ran.
      const roi = pickCourtRoi(this.courtRoi, this.courtRoiByCourt, courtId);
      const stderr = await this.runPython(this.buildArgs(clipPath, out, roi));
      // The script ignores an invalid boundary rather than failing — surface
      // that, or a typo in .env would silently switch the boundary off.
      const roiWarning = stderr
        .split("\n")
        .find((l) => l.includes("ignoring invalid --roi"));
      if (roiWarning) {
        this.logger.warn("Court boundary invalid; tracked without it", {
          courtId,
          detail: roiWarning.trim(),
        });
      }
      const summary = stderr
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("reframe_ball:"))
        .pop();
      if (summary) {
        this.logger.info("Ball reframe stats", { courtId, summary });
      }
      if (!fs.existsSync(out)) {
        this.logger.warn("Ball reframer produced no output; using full frame", {
          courtId,
        });
        return null;
      }
      // Existence isn't enough — a 0-byte / corrupt file would then be trusted
      // over the good raw clip. Require a probeable, non-zero-duration video.
      if (!(await this.isPlayable(out))) {
        this.logger.warn("Ball reframer output invalid; using full frame", {
          courtId,
          out,
        });
        fs.unlink(out, () => {}); // don't leave the bad file to be picked up
        return null;
      }
      // OpenCV's VideoWriter has no concept of audio, so `out` is video-only
      // no matter what the source carried. Copy the original clip's audio back
      // on, or the reframe silently undoes the audio work done upstream — this
      // is the one stage where enabling ball tracking would cost you the sound.
      // Fail-soft: a failed mux keeps the silent reframe, which is still a
      // usable reel.
      await this.muxAudioFrom(clipPath, out, courtId);
      this.logger.info("Ball reframe complete", { courtId, out });
      return out;
    } catch (error) {
      this.logger.warn("Ball reframe failed; using full frame", {
        courtId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** Script arguments; --roi only when this court has a boundary configured. */
  public buildArgs(clipPath: string, out: string, roi: string): string[] {
    const args = [
      this.scriptPath,
      "--input", clipPath,
      "--output", out,
      "--aspect", this.reelAspect,
      "--debug",
    ];
    if (roi) args.push("--roi", roi);
    return args;
  }

  /**
   * Copy the audio track from `source` onto the video in `target`, in place.
   *
   * Both streams are copied, not re-encoded, so this is a remux costing ~no
   * CPU. Writes to a temp file and renames over `target` only on success, so
   * a failure here can never corrupt the reframed clip the caller is about to
   * return. Silently does nothing when `source` has no audio.
   */
  private async muxAudioFrom(
    source: string,
    target: string,
    courtId: string
  ): Promise<void> {
    try {
      if (!(await this.hasAudioStream(source))) return;
      const tmp = `${target}.audio.mp4`;
      const lp = withLowPriority("ffmpeg", [
        "-y",
        "-i", target,   // reframed video (no audio)
        "-i", source,   // original clip (audio, possibly different length)
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c", "copy",
        // The reframe can land a frame or two short of the source; without
        // -shortest the muxer pads to the longer audio and the reel ends on a
        // frozen frame.
        "-shortest",
        "-movflags", "+faststart",
        tmp,
      ]);
      const ok = await this.runFFmpeg(lp.command, lp.args);
      if (!ok || !fs.existsSync(tmp)) {
        fs.unlink(tmp, () => {});
        this.logger.warn("Reframed clip kept without audio: mux failed", {
          courtId,
          target,
        });
        return;
      }
      fs.renameSync(tmp, target);
      this.logger.info("Reframed clip audio restored", { courtId, target });
    } catch (error) {
      this.logger.warn("Reframed clip kept without audio: mux error", {
        courtId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // True when ffprobe finds at least one audio stream. False on any failure.
  private hasAudioStream(file: string): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn("ffprobe", [
        "-v", "error",
        "-select_streams", "a",
        "-show_entries", "stream=index",
        "-of", "csv=p=0",
        file,
      ]);
      let out = "";
      proc.stdout?.on("data", (d) => (out += d.toString()));
      proc.on("exit", (code) => resolve(code === 0 && out.trim().length > 0));
      proc.on("error", () => resolve(false));
    });
  }

  // Runs ffmpeg to completion; resolves true on exit 0. Never throws, and is
  // bounded by the same timeout budget as the reframe itself.
  private runFFmpeg(command: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn(command, args, { stdio: "ignore" });
      const timeout = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve(false);
      }, this.timeoutMs);
      proc.on("exit", (code) => {
        clearTimeout(timeout);
        resolve(code === 0);
      });
      proc.on("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
  }

  /** "16:9" -> 1.777…; null when unparseable (caller then just runs the pass). */
  private parseAspect(aspect: string): number | null {
    const m = aspect.match(/^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/);
    if (!m) return null;
    const w = parseFloat(m[1]);
    const h = parseFloat(m[2]);
    return h > 0 && w > 0 ? w / h : null;
  }

  // Width/height of `file`, or null on any probe failure (never throws).
  private probeDimensions(
    file: string
  ): Promise<{ width: number; height: number } | null> {
    return new Promise((resolve) => {
      const proc = spawn("ffprobe", [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height",
        "-of", "csv=p=0",
        file,
      ]);
      let out = "";
      proc.stdout?.on("data", (d) => (out += d.toString()));
      proc.on("exit", (code) => {
        if (code !== 0) return resolve(null);
        const m = out.trim().match(/(\d+)\s*,\s*(\d+)/);
        resolve(m ? { width: parseInt(m[1], 10), height: parseInt(m[2], 10) } : null);
      });
      proc.on("error", () => resolve(null));
    });
  }

  // True when ffprobe reports a positive duration for `file` (i.e. a real,
  // non-empty video). Resolves false on any probe failure — never throws.
  private isPlayable(file: string): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1",
        file,
      ]);
      let out = "";
      proc.stdout?.on("data", (d) => {
        out += d.toString();
      });
      proc.on("exit", (code) => {
        const dur = parseFloat(out.trim());
        resolve(code === 0 && Number.isFinite(dur) && dur > 0);
      });
      proc.on("error", () => resolve(false));
    });
  }

  // Resolves with the process's stderr (used for the --debug summary line);
  // rejects on non-zero exit, spawn error, or timeout.
  private runPython(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      // Low CPU priority so the OpenCV passes can't starve the live ffmpeg.
      const lp = withLowPriority("python3", args);
      const proc = spawn(lp.command, lp.args, {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      proc.stderr?.on("data", (d) => {
        stderr += d.toString();
      });
      const timeout = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error("python reframe timed out"));
      }, this.timeoutMs);
      proc.on("exit", (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve(stderr);
        else reject(new Error(`python exited ${code}: ${stderr.slice(-200)}`));
      });
      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err); // e.g. python3 not installed
      });
    });
  }
}
