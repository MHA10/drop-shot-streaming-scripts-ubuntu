import * as os from "os";

/**
 * Samples whole-machine CPU + memory (and this process's RSS) at an interval,
 * so a caller can report the resource spike a piece of work caused.
 *
 * ── IN SIMPLE WORDS ──
 * Start it, do some heavy work, stop it — it tells you how busy the box's CPU
 * got, how much RAM was in use before vs at the peak, and the machine load.
 * Used to record, in the logs, exactly what building a highlight reel costs
 * the streamer box (extract + reframe + render are CPU-heavy).
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - CPU% is derived from `os.cpus()` cumulative times (deltas between ticks),
 *   the same source as /proc/stat — a whole-machine 0-100 figure independent of
 *   core count. Peak matters more than average for spotting contention.
 * - The interval timer is `unref()`d so it can NEVER keep the process alive; if
 *   stop() is somehow missed, the timer won't hold the event loop open.
 * - Zero dependencies and pure Node os/process — safe to run on every box.
 *
 * ── DO NOT ──
 * - Do NOT treat the numbers as per-process attribution: CPU% is the whole box
 *   (which is the point — it captures the live encoder + the reel subprocesses
 *   together). The baseline→peak memory delta is what the reel work added.
 */
export interface ResourceSummary {
  cores: number;
  samples: number;
  cpuBusyPctPeak: number;
  cpuBusyPctAvg: number;
  memUsedMbBaseline: number;
  memUsedMbPeak: number;
  memTotalMb: number;
  nodeRssMbPeak: number;
  load1: number;
}

export class ResourceSampler {
  private timer: NodeJS.Timeout | null = null;
  private prev: { idle: number; total: number } | null = null;
  private readonly cpu: number[] = [];
  private readonly memUsed: number[] = [];
  private readonly rss: number[] = [];

  public start(intervalMs = 1000): void {
    if (this.timer) return;
    this.prev = this.cpuTimes();
    this.timer = setInterval(() => this.tick(), intervalMs);
    // Never let sampling hold the process open.
    this.timer.unref?.();
  }

  public stop(): ResourceSummary {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const peak = (a: number[]) => (a.length ? Math.max(...a) : 0);
    const avg = (a: number[]) =>
      a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : 0;
    return {
      cores: os.cpus().length,
      samples: this.cpu.length,
      cpuBusyPctPeak: peak(this.cpu),
      cpuBusyPctAvg: avg(this.cpu),
      memUsedMbBaseline: this.memUsed[0] ?? this.usedMb(),
      memUsedMbPeak: peak(this.memUsed),
      memTotalMb: Math.round(os.totalmem() / 1048576),
      nodeRssMbPeak: peak(this.rss),
      load1: Math.round((os.loadavg()[0] ?? 0) * 100) / 100,
    };
  }

  private cpuTimes(): { idle: number; total: number } {
    let idle = 0;
    let total = 0;
    for (const c of os.cpus()) {
      const t = c.times;
      idle += t.idle;
      total += t.user + t.nice + t.sys + t.idle + t.irq;
    }
    return { idle, total };
  }

  private usedMb(): number {
    return Math.round((os.totalmem() - os.freemem()) / 1048576);
  }

  private tick(): void {
    const cur = this.cpuTimes();
    if (this.prev) {
      const didle = cur.idle - this.prev.idle;
      const dtot = cur.total - this.prev.total;
      if (dtot > 0) {
        const busy = Math.round(100 * (1 - didle / dtot));
        this.cpu.push(Math.max(0, Math.min(100, busy)));
      }
    }
    this.prev = cur;
    this.memUsed.push(this.usedMb());
    this.rss.push(Math.round(process.memoryUsage().rss / 1048576));
  }
}
