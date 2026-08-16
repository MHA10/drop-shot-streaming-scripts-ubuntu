import * as fs from "fs";
import * as path from "path";
import { Logger } from "../../application/interfaces/Logger";
import { ensureDirSync } from "../utils/paths";

/**
 * Durable, crash-safe queue of reel jobs, stored as one JSON object per line.
 *
 * ── IN SIMPLE WORDS ──
 * A to-do list for reels, kept in a plain text file. Each line is one job and
 * says what stage it reached: footage claimed, scored, cut, cropped, branded,
 * uploaded. When the box restarts — planned or after a power cut — we read the
 * file back and carry on from wherever each job got to. Nothing is lost and
 * nothing is done twice.
 *
 * ── BUSINESS RULES ──
 * - A job is created the instant a highlight is triggered (button or automatic
 *   detection), because the rolling buffer is a moving window: the footage is
 *   claimed immediately or it is gone forever.
 * - Manual (button) jobs outrank automatic candidates and are never dropped on
 *   ranking — a human asked for that one.
 * - Only COMPLETED steps are recorded. There is deliberately no "in progress"
 *   state; see the recovery note below.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - APPEND-ONLY. Rewriting a line in place risks a torn write destroying a
 *   NEIGHBOURING job's record — losing work we already paid CPU for. Appending
 *   can only ever damage the tail, which replay skips.
 * - Each record is a FULL SNAPSHOT, not a delta, so replay is "last line wins
 *   per id". Deltas would make a skipped torn line corrupt everything after it.
 * - A malformed final line is SKIPPED, not fatal. That is the exact signature
 *   of a power cut mid-write, and it must not stop the box from booting.
 * - Compaction writes a new file and renames over the old one. rename(2) is
 *   atomic, so a crash mid-compaction leaves either the old file or the new
 *   one — never a half-written queue.
 *
 * ── DO NOT ──
 * - Do NOT record an "in progress" state. Recovery would have to guess whether
 *   the step finished; instead every step is idempotent and simply re-runs.
 * - Do NOT mutate a record in place, or hold the parsed list as the source of
 *   truth across a restart — the FILE is the source of truth.
 * - Do NOT let a write throw into the caller. A queue failure must never take
 *   down the live stream; every path here logs and degrades.
 */

/** Completed milestones. Order matters: this is the pipeline sequence. */
export const REEL_STATES = [
  "RAW", // segments claimed on disk (hardlinked) — time-critical, done at trigger
  "SCORED", // quality score computed, BEFORE any encode so weak ones cost nothing
  "EXTRACTED", // window cut into a single clip
  "REFRAMED", // ball-tracked vertical crop applied
  "RENDERED", // logos burned in — the finished reel
  "UPLOADED", // YouTube returned a videoId
  "DONE", // local files cleaned up
] as const;

export type ReelState = (typeof REEL_STATES)[number] | "REJECTED" | "FAILED";

/** Terminal states — the worker never picks these up again. */
const TERMINAL: ReadonlySet<ReelState> = new Set<ReelState>([
  "DONE",
  "REJECTED",
  "FAILED",
]);

export interface ReelTask {
  /** Schema version, so a future format change can migrate rather than crash. */
  v: number;
  id: string;
  courtId: string;
  /** "manual" = button press; "auto" = detected. Manual is never rank-dropped. */
  source: "manual" | "auto";
  windowStartMs: number;
  windowEndMs: number;
  state: ReelState;
  /** When this record was written. */
  ts: number;
  /** Times the worker has picked this up; guards against a poison task. */
  attempts: number;
  /** Ranking score, once SCORED. Null until then. */
  score: number | null;
  /** Paths produced so far, keyed by the step that produced them. */
  artifacts: Partial<Record<"pinDir" | "clip" | "reframed" | "reel", string>> & {
    videoId?: string;
  };
  /** Last failure reason, for operators reading the file directly. */
  error?: string;
}

/** Rewrite the file once it exceeds this many lines, to stop unbounded growth. */
const COMPACT_AT_LINES = 500;

export class ReelTaskQueue {
  private readonly filePath: string;
  /** id -> latest record. Rebuilt from the file on construction. */
  private tasks = new Map<string, ReelTask>();
  private lineCount = 0;

  constructor(
    outputDir: string,
    private readonly logger: Logger
  ) {
    this.filePath = path.join(outputDir, "queue.jsonl");
    ensureDirSync(outputDir);
    this.replay();
  }

  /**
   * Rebuild in-memory state from the file. Last record per id wins.
   *
   * A line that will not parse is skipped, not fatal: a truncated final line is
   * what a power cut during append looks like, and the box must still boot.
   */
  private replay(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch {
      return; // no queue yet — first run
    }

    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    this.lineCount = lines.length;
    let skipped = 0;

    for (const line of lines) {
      try {
        const rec = JSON.parse(line) as ReelTask;
        if (rec && typeof rec.id === "string") this.tasks.set(rec.id, rec);
      } catch {
        skipped++;
      }
    }

    const live = [...this.tasks.values()].filter((t) => !TERMINAL.has(t.state));
    this.logger.info("Reel queue restored", {
      file: this.filePath,
      tasks: this.tasks.size,
      resumable: live.length,
      skippedMalformedLines: skipped,
    });
    if (live.length > 0) {
      this.logger.info("Reel tasks awaiting work", {
        tasks: live.map((t) => ({
          id: t.id,
          state: t.state,
          source: t.source,
          attempts: t.attempts,
        })),
      });
    }
  }

  /**
   * Append a full snapshot of `task`. This is the ONLY way state changes.
   *
   * Records are kept under 4KB so the append lands in a single write, which
   * O_APPEND makes atomic against other writers on Linux. Larger records could
   * interleave and produce a line that no longer parses.
   */
  private append(task: ReelTask): void {
    const line = `${JSON.stringify(task)}\n`;
    try {
      fs.appendFileSync(this.filePath, line);
      this.tasks.set(task.id, task);
      this.lineCount++;
      if (this.lineCount > COMPACT_AT_LINES) this.compact();
    } catch (error) {
      // In-memory state still advances so the current run makes progress; only
      // durability across a restart is lost. Never throw at the caller.
      this.tasks.set(task.id, task);
      this.logger.warn("Could not persist reel task (continuing in memory)", {
        id: task.id,
        state: task.state,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Rewrite the file with one line per live task, dropping finished ones.
   * Writes a temp file and renames over the original — rename(2) is atomic, so
   * a crash here leaves either the old queue or the new one intact.
   */
  private compact(): void {
    const keep = [...this.tasks.values()].filter((t) => !TERMINAL.has(t.state));
    const tmp = `${this.filePath}.tmp`;
    try {
      fs.writeFileSync(tmp, keep.map((t) => JSON.stringify(t)).join("\n") + "\n");
      fs.renameSync(tmp, this.filePath);
      this.tasks = new Map(keep.map((t) => [t.id, t]));
      this.lineCount = keep.length;
      this.logger.debug("Reel queue compacted", { remaining: keep.length });
    } catch (error) {
      fs.rm(tmp, { force: true }, () => {});
      this.logger.warn("Reel queue compaction failed (non-fatal)", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Create a job for a window whose segments have just been claimed. */
  public create(input: {
    id: string;
    courtId: string;
    source: "manual" | "auto";
    windowStartMs: number;
    windowEndMs: number;
    pinDir: string;
  }): ReelTask {
    const task: ReelTask = {
      v: 1,
      id: input.id,
      courtId: input.courtId,
      source: input.source,
      windowStartMs: input.windowStartMs,
      windowEndMs: input.windowEndMs,
      state: "RAW",
      ts: Date.now(),
      attempts: 0,
      score: null,
      artifacts: { pinDir: input.pinDir },
    };
    this.append(task);
    this.logger.info("Reel task queued", {
      id: task.id,
      courtId: task.courtId,
      source: task.source,
      windowSec: Math.round((task.windowEndMs - task.windowStartMs) / 1000),
    });
    return task;
  }

  /**
   * Record that a step FINISHED. Call this only after the step's output is
   * safely on disk (temp file renamed into place), never before.
   */
  public advance(
    id: string,
    state: ReelState,
    artifacts?: ReelTask["artifacts"],
    score?: number
  ): void {
    const prev = this.tasks.get(id);
    if (!prev) {
      this.logger.warn("Cannot advance unknown reel task", { id, state });
      return;
    }
    this.append({
      ...prev,
      state,
      ts: Date.now(),
      score: score ?? prev.score,
      artifacts: { ...prev.artifacts, ...artifacts },
    });
  }

  /**
   * Note that the worker is about to attempt this task. This is the one thing
   * recorded BEFORE work, and only so a task that crashes the process on every
   * attempt is eventually abandoned instead of putting the box in a boot loop.
   */
  public markAttempt(id: string, maxAttempts: number): boolean {
    const prev = this.tasks.get(id);
    if (!prev) return false;
    const attempts = prev.attempts + 1;
    if (attempts > maxAttempts) {
      this.append({
        ...prev,
        state: "FAILED",
        attempts,
        ts: Date.now(),
        error: `gave up after ${maxAttempts} attempts`,
      });
      this.logger.warn("Reel task abandoned after repeated failures", {
        id,
        attempts,
        lastState: prev.state,
      });
      return false;
    }
    this.append({ ...prev, attempts, ts: Date.now() });
    return true;
  }

  /** Record a non-fatal failure; the task stays at its last completed state. */
  public noteFailure(id: string, error: string): void {
    const prev = this.tasks.get(id);
    if (!prev) return;
    this.append({ ...prev, ts: Date.now(), error });
  }

  /**
   * The next job to work on, or null when there is nothing to do.
   * Manual jobs first (a human asked), then oldest first so the queue drains in
   * the order footage was captured rather than newest-wins.
   */
  public next(): ReelTask | null {
    const ready = [...this.tasks.values()].filter((t) => !TERMINAL.has(t.state));
    if (ready.length === 0) return null;
    ready.sort((a, b) => {
      if (a.source !== b.source) return a.source === "manual" ? -1 : 1;
      return a.windowStartMs - b.windowStartMs;
    });
    return ready[0];
  }

  /** Live (non-terminal) tasks, for quota accounting and operator visibility. */
  public pending(): ReelTask[] {
    return [...this.tasks.values()].filter((t) => !TERMINAL.has(t.state));
  }

  public get(id: string): ReelTask | undefined {
    return this.tasks.get(id);
  }
}
