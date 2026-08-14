import { HighlightBufferManager } from "./HighlightBufferManager";

/**
 * Tracks the live HighlightBufferManager per court so its retention sweep is
 * started on stream start and reliably stopped on stop / retry / shutdown —
 * mirroring AdRotationRegistry. Without this, a leaked sweep timer would keep
 * pruning a directory for a stream that no longer exists.
 *
 * ── DO NOT ──
 * - Do NOT leak: every code path that ends a stream (stop use-case, retry,
 *   killAll/shutdown) must call stop(courtId) or stopAll().
 */
export class HighlightBufferRegistry {
  private readonly managers = new Map<string, HighlightBufferManager>();

  /** Register a court's manager, replacing (and stopping) any prior one. */
  set(courtId: string, manager: HighlightBufferManager): void {
    this.stop(courtId);
    this.managers.set(courtId, manager);
  }

  /** Look up a court's manager (e.g. for window queries during extraction). */
  get(courtId: string): HighlightBufferManager | undefined {
    return this.managers.get(courtId);
  }

  /** Stop and deregister one court's manager. Idempotent. */
  stop(courtId: string): void {
    const manager = this.managers.get(courtId);
    if (manager) {
      manager.stop();
      this.managers.delete(courtId);
    }
  }

  /** Stop and deregister all managers (shutdown / killAll). */
  stopAll(): void {
    for (const manager of this.managers.values()) {
      manager.stop();
    }
    this.managers.clear();
  }
}
