import * as fs from "fs";
import { Logger } from "../../application/interfaces/Logger";
import { NormalizedAd } from "./AdDownloaderService";

export interface AdRotatorOptions {
  defaultDurationSec: number;
  minDurationSec: number;
  maxDurationSec: number;
}

interface SlotState {
  poolIndex: number;
  timer: NodeJS.Timeout | null;
}

/**
 * Rotates a pool of N normalized still ads through two on-screen slots
 * (left/right) while the stream stays live. Each slot advances independently on
 * its own timer; the two slots never show the same ad at once; the pool is
 * reshuffled each time it is fully consumed.
 *
 * Mechanism: the running ffmpeg reads two fixed PNG files (the slot files) via
 * `-f image2 -loop 1`, re-reading them on every loop. To change a slot we simply
 * overwrite its file (atomically, via temp + rename). The ffmpeg process never
 * restarts.
 */
export class AdRotator {
  private queue: number[] = [];
  private cursor = 0;
  private readonly left: SlotState = { poolIndex: -1, timer: null };
  private readonly right: SlotState = { poolIndex: -1, timer: null };
  private stopped = false;

  constructor(
    private readonly courtId: string,
    private readonly pool: NormalizedAd[],
    private readonly slotLeftPath: string,
    private readonly slotRightPath: string,
    private readonly options: AdRotatorOptions,
    private readonly logger: Logger
  ) {}

  /**
   * Seed the initial slot files. MUST run before ffmpeg starts so the slot
   * inputs exist. Clears any stale slot files first, so an empty pool leaves no
   * slot files behind (ffmpeg then adds no ad inputs).
   */
  public prepare(): void {
    this.removeSlotFiles();

    if (this.pool.length === 0) {
      return;
    }

    this.reshuffle();
    this.cursor = 0;

    this.left.poolIndex = this.next(-1);
    this.writeSlot(this.slotLeftPath, this.pool[this.left.poolIndex]);

    if (this.pool.length >= 2) {
      this.right.poolIndex = this.next(this.left.poolIndex);
      this.writeSlot(this.slotRightPath, this.pool[this.right.poolIndex]);
    }
  }

  /**
   * Begin rotation. Call after ffmpeg has started. With fewer than two ads there
   * is nothing to rotate, so the seeded slot(s) simply stay put.
   */
  public start(): void {
    if (this.stopped || this.pool.length < 2) {
      return;
    }

    this.logger.info("Starting ad rotation", {
      courtId: this.courtId,
      poolSize: this.pool.length,
    });

    // Left rotates after a full duration; right is offset by half its duration
    // so the two slots never swap on the same tick.
    this.scheduleSlot(this.left, this.slotLeftPath, this.right);
    this.right.timer = setTimeout(() => {
      if (this.stopped) return;
      this.right.poolIndex = this.next(this.left.poolIndex);
      this.writeSlot(this.slotRightPath, this.pool[this.right.poolIndex]);
      this.scheduleSlot(this.right, this.slotRightPath, this.left);
    }, Math.floor(this.durationMs(this.right.poolIndex) / 2));
  }

  /** Stop all timers. Idempotent. Safe to call from teardown/retry/shutdown. */
  public stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.left.timer) clearTimeout(this.left.timer);
    if (this.right.timer) clearTimeout(this.right.timer);
    this.left.timer = null;
    this.right.timer = null;
    this.logger.info("Stopped ad rotation", { courtId: this.courtId });
  }

  private scheduleSlot(
    slot: SlotState,
    slotPath: string,
    otherSlot: SlotState
  ): void {
    if (this.stopped) return;
    slot.timer = setTimeout(() => {
      if (this.stopped) return;
      slot.poolIndex = this.next(otherSlot.poolIndex);
      this.writeSlot(slotPath, this.pool[slot.poolIndex]);
      this.scheduleSlot(slot, slotPath, otherSlot);
    }, this.durationMs(slot.poolIndex));
  }

  // Advance the cursor and return the next pool index, skipping the ad currently
  // shown in the other slot (so both slots never show the same ad). Reshuffles
  // when a full cycle has been consumed.
  private next(skipPoolIndex: number): number {
    const maxAttempts = this.queue.length + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (this.cursor >= this.queue.length) {
        this.reshuffle();
        this.cursor = 0;
      }
      const idx = this.queue[this.cursor++];
      // With a pool of <2 the skip cannot be honoured; allow the duplicate.
      if (idx !== skipPoolIndex || this.pool.length < 2) {
        return idx;
      }
    }
    return (this.queue.find((i) => i !== skipPoolIndex) ?? this.queue[0]) ?? 0;
  }

  // Resolve the slot duration: payload value when valid, else the configured
  // default, clamped to [min, max] to avoid file-swap thrash / runaway values.
  private durationMs(poolIndex: number): number {
    const raw = this.pool[poolIndex]?.durationSec;
    let sec =
      typeof raw === "number" && isFinite(raw) && raw > 0
        ? raw
        : this.options.defaultDurationSec;
    sec = Math.max(
      this.options.minDurationSec,
      Math.min(this.options.maxDurationSec, sec)
    );
    return sec * 1000;
  }

  // Atomically replace a slot file so ffmpeg never reads a half-written PNG.
  private writeSlot(slotPath: string, ad: NormalizedAd): void {
    try {
      const tmp = `${slotPath}.tmp`;
      fs.copyFileSync(ad.pngPath, tmp);
      fs.renameSync(tmp, slotPath);
    } catch (error) {
      this.logger.warn("Failed to write ad slot", {
        courtId: this.courtId,
        slotPath,
        source: ad.pngPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private removeSlotFiles(): void {
    for (const p of [this.slotLeftPath, this.slotRightPath]) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        // ignore — a stale slot file we can't remove will simply be overwritten
      }
    }
  }

  // Fisher–Yates shuffle of [0..pool.length-1].
  private reshuffle(): void {
    const arr = Array.from({ length: this.pool.length }, (_, i) => i);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    this.queue = arr;
  }
}

/**
 * Tracks the live AdRotator per court so its timers can be torn down when the
 * stream stops, retries, fails, or the app shuts down. A leaked rotator would
 * keep overwriting slot files for a dead stream.
 */
export class AdRotationRegistry {
  private readonly rotators = new Map<string, AdRotator>();

  set(courtId: string, rotator: AdRotator): void {
    this.stop(courtId);
    this.rotators.set(courtId, rotator);
  }

  stop(courtId: string): void {
    const rotator = this.rotators.get(courtId);
    if (rotator) {
      rotator.stop();
      this.rotators.delete(courtId);
    }
  }

  stopAll(): void {
    for (const rotator of this.rotators.values()) {
      rotator.stop();
    }
    this.rotators.clear();
  }
}
