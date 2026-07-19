import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { BallReframer } from "../../domain/services/BallReframer";
import { Logger } from "../../application/interfaces/Logger";

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
  private readonly timeoutMs = 120_000;
  private readonly scriptPath: string;

  constructor(
    private readonly reelAspect: string,
    private readonly logger: Logger,
    scriptPath?: string
  ) {
    // Resolved from CWD (the app runs from the repo root under PM2). scripts/
    // is not copied into dist/, so reference it at the repo root.
    this.scriptPath = scriptPath ?? path.resolve("scripts/reframe_ball.py");
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

    const dir = path.dirname(clipPath);
    const base = path.basename(clipPath, path.extname(clipPath));
    const out = path.join(dir, `reframed-${base}.mp4`);

    try {
      await this.runPython([
        this.scriptPath,
        "--input", clipPath,
        "--output", out,
        "--aspect", this.reelAspect,
      ]);
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

  private runPython(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn("python3", args, {
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
        if (code === 0) resolve();
        else reject(new Error(`python exited ${code}: ${stderr.slice(-200)}`));
      });
      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err); // e.g. python3 not installed
      });
    });
  }
}
