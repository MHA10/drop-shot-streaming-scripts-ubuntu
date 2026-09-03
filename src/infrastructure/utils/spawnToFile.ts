import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";

/**
 * Run a one-shot process whose output is a single file, safely.
 *
 * ── IN SIMPLE WORDS ──
 * Runs a command (e.g. ffmpeg) that produces one output file, writing to a
 * temp file first and renaming it into place only on success — so a crash,
 * timeout, or non-zero exit never leaves a half-written/corrupt file at the
 * real path.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - The temp name PRESERVES dest's extension (`x.tmp.mp4`, not `x.mp4.tmp`)
 *   because ffmpeg picks the output muxer from the extension.
 * - The caller passes all args EXCEPT the final output path; this appends the
 *   temp path as the last arg.
 *
 * ── DO NOT ──
 * - Do NOT pass the output path in `args` — it's appended here.
 */
export function spawnToFile(
  command: string,
  args: string[],
  dest: string,
  timeoutMs: number
): Promise<void> {
  const ext = path.extname(dest);
  const tmp = ext ? `${dest.slice(0, -ext.length)}.tmp${ext}` : `${dest}.tmp`;
  return new Promise((resolve, reject) => {
    const proc = spawn(command, [...args, tmp], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    proc.stderr?.on("data", (d) => {
      stderr += d.toString();
    });

    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      fs.unlink(tmp, () => {});
      reject(new Error(`${command} timed out`));
    }, timeoutMs);

    proc.on("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0 && fs.existsSync(tmp)) {
        try {
          fs.renameSync(tmp, dest);
          resolve();
        } catch (err) {
          fs.unlink(tmp, () => {});
          reject(err);
        }
      } else {
        fs.unlink(tmp, () => {});
        reject(new Error(`${command} failed (code ${code}): ${stderr.slice(-200)}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      fs.unlink(tmp, () => {});
      reject(err);
    });
  });
}
