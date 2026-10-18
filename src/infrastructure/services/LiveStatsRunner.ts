import * as fs from "fs";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";
import { Logger } from "../../application/interfaces/Logger";
import { withLowPriority } from "../utils/lowPriority";
import { maskCameraUrl } from "../utils/cameraSubstream";

/**
 * Runs the Python stats reader (scripts/live_stats.py) for ONE court's match.
 *
 * ── IN SIMPLE WORDS ──
 * While a court is live, a separate Python program watches that court's
 * low-res camera feed and keeps a numbers file (stats.json) and a picture
 * (heatmap.png) up to date in the match's folder. This class starts that
 * program, restarts it if it crashes, and when the match ends asks it to
 * finish politely so it writes its final numbers before exiting.
 *
 * ── BUSINESS RULES ──
 * - v1 near-live stats (decision 2026-10-09, docs/v1-stats-spec.md §6): the
 *   reader works off the camera, not a recording — the box keeps none.
 * - Dials default to the ds-box speed result (docs/live-stats-staging.md §6):
 *   3 looks/sec, image size 960, 2 detector threads.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - It runs under `nice -n 19` (lowest CPU priority). The stats may fall
 *   behind; the live broadcast may not. Without it the reader competes with
 *   the encode at equal priority and the stream can stutter.
 * - Stopping is SIGTERM-then-wait, not a kill. live_stats.py writes its final
 *   stats.json/heatmap.png on the way out; a straight SIGKILL loses up to the
 *   last chunk and leaves its camera-slicing ffmpeg orphaned, still holding a
 *   camera connection. After the grace period we SIGKILL and sweep that ffmpeg
 *   by its unique output path.
 * - The camera URL goes in the CAMERA_URL env var, not argv, so the password
 *   doesn't show in this process's `ps` line or our logs. The child gets a
 *   minimal env — it has no use for the box's API keys.
 * - Its pid is written to reader.pid so a node crash that orphans the reader
 *   can be cleaned up at the next boot (killOrphanReader), instead of two
 *   readers fighting over one court after the restart.
 *
 * ── DO NOT ──
 * - Do NOT raise the thread count to "go faster" — every core it takes is a
 *   core the live encode may need.
 * - Do NOT pass --fresh. A new match always gets a NEW folder (so there is
 *   nothing stale to ignore), and a restart into the same folder must resume
 *   the master file, not wipe it.
 */

export interface LiveStatsReaderSettings {
  pythonPath: string;
  scriptPath: string;
  modelPath: string;
  logoPath: string;
  targetFps: number;
  imgsz: number;
  threads: number;
  clipSec: number;
  // Must exceed the caller's resume deadline, or a resumed folder's master is
  // treated as a previous match and the first part of the match is dropped.
  resumeWindowSec: number;
}

const MAX_QUICK_RESTARTS = 5;
// A run that lasted this long was healthy; a crash after it resets the count.
const HEALTHY_RUN_MS = 5 * 60_000;

export class LiveStatsRunner {
  private proc: ChildProcess | null = null;
  private finishing = false;
  private quickRestarts = 0;
  private restartTimer?: NodeJS.Timeout;
  private exitWaiters: Array<() => void> = [];

  constructor(
    private readonly courtId: string,
    private readonly matchDir: string,
    private readonly cameraUrl: string,
    private readonly settings: LiveStatsReaderSettings,
    private readonly logger: Logger
  ) {}

  public start(): void {
    this.spawnReader();
  }

  public isRunning(): boolean {
    return this.proc !== null;
  }

  /**
   * App shutdown: ask the reader to stop without waiting or escalating. It
   * saves its progress on the way out, which the next boot resumes from.
   */
  public requestStop(): void {
    this.finishing = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.proc?.kill("SIGTERM");
  }

  /**
   * Ask the reader to write its final numbers and exit; SIGKILL after
   * `graceMs`. Resolves once it's gone. Never throws.
   */
  public async finish(graceMs: number): Promise<void> {
    this.finishing = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    const proc = this.proc;
    if (!proc) return;

    const exited = new Promise<void>((resolve) => this.exitWaiters.push(resolve));
    proc.kill("SIGTERM");
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), graceMs)),
    ]);
    if (timedOut && this.proc) {
      this.logger.warn("Stats reader did not stop in time; killing it", {
        courtId: this.courtId,
        graceMs,
      });
      this.proc.kill("SIGKILL");
      await exited;
      await killStraySegmenter(this.matchDir);
    }
  }

  private spawnReader(): void {
    const s = this.settings;
    const args = [
      s.scriptPath,
      "--source", "camera",
      "--out-dir", this.matchDir,
      "--clip-sec", String(s.clipSec),
      "--target-fps", String(s.targetFps),
      "--imgsz", String(s.imgsz),
      "--threads", String(s.threads),
      "--model", s.modelPath,
      "--logo", s.logoPath,
      "--resume-window", String(s.resumeWindowSec),
    ];
    const lp = withLowPriority(s.pythonPath, args);
    const startedAt = Date.now();

    const env: NodeJS.ProcessEnv = {
      CAMERA_URL: this.cameraUrl,
      PYTHONUNBUFFERED: "1",
    };
    for (const key of ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR"]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }

    const proc = spawn(lp.command, lp.args, {
      cwd: this.matchDir,
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.proc = proc;

    // `nice` execs python, so this pid IS the reader's pid.
    if (proc.pid) {
      try {
        fs.writeFileSync(path.join(this.matchDir, "reader.pid"), String(proc.pid));
      } catch {
        // Only boot-time orphan cleanup depends on it; never fail the start.
      }
    }

    const logFile = fs.createWriteStream(path.join(this.matchDir, "reader.log"), {
      flags: "a",
    });
    logFile.on("error", () => {}); // a full disk must not crash the app
    let partial = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      logFile.write(text);
      const lines = (partial + text).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) this.forwardLine(line);
    });

    let settled = false;
    const onGone = (code: number | null, signal: string | null, error?: Error) => {
      if (settled) return;
      settled = true;
      logFile.end();
      if (this.proc === proc) this.proc = null;
      const waiters = this.exitWaiters;
      this.exitWaiters = [];
      waiters.forEach((resolve) => resolve());
      if (this.finishing) {
        this.logger.info("Stats reader finished", { courtId: this.courtId, code, signal });
        return;
      }
      this.scheduleRestart(Date.now() - startedAt, code, signal, error);
    };
    // "close", not "exit": it fires after stderr is drained, so the last lines
    // (the reader's "done." summary) reach the log before we end it.
    proc.on("close", (code, signal) => onGone(code, signal));
    proc.on("error", (error) => onGone(null, null, error));

    this.logger.info("Stats reader started", {
      courtId: this.courtId,
      pid: proc.pid,
      matchDir: this.matchDir,
    });
  }

  private scheduleRestart(
    ranMs: number,
    code: number | null,
    signal: string | null,
    error?: Error
  ): void {
    if (ranMs >= HEALTHY_RUN_MS) this.quickRestarts = 0;
    this.quickRestarts++;
    if (this.quickRestarts > MAX_QUICK_RESTARTS) {
      this.logger.error("Stats reader keeps crashing; giving up for this match", {
        courtId: this.courtId,
        code,
        signal,
        error: error?.message,
        log: path.join(this.matchDir, "reader.log"),
      });
      return;
    }
    const delayMs = Math.min(60_000, 5_000 * 2 ** (this.quickRestarts - 1));
    this.logger.warn("Stats reader exited unexpectedly; restarting", {
      courtId: this.courtId,
      code,
      signal,
      error: error?.message,
      attempt: this.quickRestarts,
      delayMs,
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (!this.finishing) this.spawnReader();
    }, delayMs);
  }

  // The reader logs one line per chunk; surface problems loudly, routine
  // progress quietly. Masked: ffmpeg errors can echo the camera URL.
  private forwardLine(raw: string): void {
    const line = maskCameraUrl(raw.trim());
    if (!line) return;
    const meta = { courtId: this.courtId, line };
    if (/WARNING|FATAL|Traceback|Error|failed/.test(line)) {
      this.logger.warn("Stats reader", meta);
    } else if (/calibrated|resumed|new match|done\.|reached/.test(line)) {
      this.logger.info("Stats reader", meta);
    } else {
      this.logger.debug("Stats reader", meta);
    }
  }
}

/**
 * Stop a reader left running by a previous app process (e.g. the app crashed
 * and the child outlived it). Only kills a pid that is still a live_stats.py
 * for THIS folder — a recycled pid belonging to anything else is left alone.
 */
export async function killOrphanReader(matchDir: string): Promise<void> {
  const pidFile = path.join(matchDir, "reader.pid");
  let pid: number;
  try {
    pid = parseInt(fs.readFileSync(pidFile, "utf8"), 10);
  } catch {
    return;
  }
  if (!Number.isFinite(pid) || pid <= 0) return;

  const command = await psCommand(pid);
  if (command && command.includes("live_stats.py") && command.includes(matchDir)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
    for (let i = 0; i < 30 && (await psCommand(pid)); i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (await psCommand(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  await killStraySegmenter(matchDir);
}

// The reader's own camera-slicing ffmpeg writes into <matchDir>/segments, so
// that path appears in its command line and nowhere else.
function killStraySegmenter(matchDir: string): Promise<void> {
  const pattern = path
    .join(matchDir, "segments", "clip_")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new Promise((resolve) => {
    const proc = spawn("pkill", ["-KILL", "-f", pattern], { stdio: "ignore" });
    proc.on("exit", () => resolve());
    proc.on("error", () => resolve());
  });
}

// The command line of `pid`, or null if no such process.
function psCommand(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("ps", ["-p", String(pid), "-o", "command="]);
    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString()));
    proc.on("exit", (code) => resolve(code === 0 && out.trim() ? out.trim() : null));
    proc.on("error", () => resolve(null));
  });
}
