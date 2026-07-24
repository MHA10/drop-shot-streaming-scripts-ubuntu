import * as fs from "fs";
import * as path from "path";
import { Config } from "../../infrastructure/config/Config";
import { HighlightBufferRegistry } from "../../infrastructure/services/HighlightBufferRegistry";
import { HighlightExtractorService } from "../../infrastructure/services/HighlightExtractorService";
import { HighlightRendererService } from "../../infrastructure/services/HighlightRendererService";
import { BallReframer } from "../../domain/services/BallReframer";
import { ResourceSampler } from "../../infrastructure/utils/ResourceSampler";
import { Logger } from "../interfaces/Logger";

export interface CaptureHighlightRequest {
  courtId: string;
  receivedAtMs: number;
}

/**
 * Turns a highlight signal into a clip cut from that court's rolling buffer.
 *
 * ── IN SIMPLE WORDS ──
 * Someone pressed the highlight button. The exciting moment already happened a
 * moment ago, so we look back into the continuously-recorded buffer, wait just
 * long enough for the few seconds AFTER the moment to also be recorded, then
 * cut out the window around it as a clip.
 *
 * ── BUSINESS RULES ──
 * - The signal arrives LATE (mesh/transport delay), so the true moment is
 *   estimated as receipt time minus `lagMarginSec`. The window is
 *   [event - preRollSec, event + postRollSec] (mostly before the press, since
 *   people react after seeing the moment).
 * - We must wait until the post-roll footage physically exists in the buffer
 *   (the trailing segment has rolled over and flushed) before extracting.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - Every failure path (no buffer for court, insufficient history, extraction
 *   failure) is logged and returns quietly — a missed highlight must never
 *   throw into or disrupt the live stream or the signal source.
 *
 * ── DO NOT ──
 * - Do NOT extract before the flush wait, or the trailing segment may be
 *   missing/partial and the clip will be short.
 */
export class CaptureHighlightUseCase {
  private readonly config = Config.getInstance().get();

  constructor(
    private readonly highlightBufferRegistry: HighlightBufferRegistry,
    private readonly extractor: HighlightExtractorService,
    private readonly reframer: BallReframer,
    private readonly renderer: HighlightRendererService,
    private readonly logger: Logger
  ) {}

  public async execute(request: CaptureHighlightRequest): Promise<void> {
    const { preRollSec, postRollSec, lagMarginSec } = this.config.highlight;

    const estimatedEventMs = request.receivedAtMs - lagMarginSec * 1000;
    const windowStartMs = estimatedEventMs - preRollSec * 1000;
    const windowEndMs = estimatedEventMs + postRollSec * 1000;

    this.logger.info("Highlight capture starting", {
      courtId: request.courtId,
      receivedAtMs: request.receivedAtMs,
      estimatedEventMs,
      windowStartMs,
      windowEndMs,
    });

    // Sample box CPU/memory across the whole capture so every reel logs what it
    // cost the streamer (extract + reframe + render are CPU-heavy). Logged in
    // the finally below so the stats appear even on an abort/failure path.
    const sampler = new ResourceSampler();
    sampler.start();
    try {
      await this.runCapture(request, windowStartMs, windowEndMs);
    } finally {
      const usage = sampler.stop();
      this.logger.info("Highlight resource usage", {
        courtId: request.courtId,
        ...usage,
      });
    }
  }

  private async runCapture(
    request: CaptureHighlightRequest,
    windowStartMs: number,
    windowEndMs: number
  ): Promise<void> {
    const { bufferSegmentSec } = this.config.highlight;

    // Wait until the post-roll footage exists: the segment containing windowEnd
    // is only finalized once the muxer rolls to the next one (~bufferSegmentSec
    // later), so wait to windowEnd + one segment + a small margin.
    const flushSafetyMs = (bufferSegmentSec + 1) * 1000;
    const waitMs = windowEndMs + flushSafetyMs - Date.now();
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    const manager = this.highlightBufferRegistry.get(request.courtId);
    if (!manager) {
      this.logger.warn("Highlight capture aborted: no active buffer for court", {
        courtId: request.courtId,
      });
      return;
    }

    const segments = manager.getSegmentsInWindow(windowStartMs, windowEndMs);
    if (!segments) {
      this.logger.warn(
        "Highlight capture aborted: insufficient buffer history for window",
        { courtId: request.courtId, windowStartMs, windowEndMs }
      );
      return;
    }

    const rawClipPath = await this.extractor.extractWindow(
      segments,
      windowStartMs,
      windowEndMs,
      request.courtId
    );
    if (!rawClipPath) {
      this.logger.warn("Highlight capture failed: extraction produced no clip", {
        courtId: request.courtId,
      });
      return;
    }

    // Ball-tracking reframe (off by default → null → full frame). Any failure
    // falls back to the raw full-frame clip so a highlight is never lost.
    const reframed = await this.reframer.reframe(rawClipPath, request.courtId);
    const source = reframed ?? rawClipPath;

    // Overlay logos → final reel.
    const dir = path.dirname(rawClipPath);
    const base = path.basename(rawClipPath, path.extname(rawClipPath));
    const reelPath = path.join(dir, `reel-${base}.mp4`);
    const rendered = await this.renderer.render(source, reelPath, request.courtId);

    // On render failure fall back to the RAW full-frame clip (always valid via
    // the extractor's atomic write), not to `source` — if the logo overlay
    // failed on the reframed clip, the reframed clip is the less-trusted input.
    const finalPath = rendered ?? rawClipPath;

    // Clean up intermediates that aren't the deliverable, so the output dir
    // doesn't accumulate raw/reframed files alongside every reel.
    for (const intermediate of [rawClipPath, reframed]) {
      if (intermediate && intermediate !== finalPath && fs.existsSync(intermediate)) {
        fs.unlink(intermediate, () => {});
      }
    }

    this.logger.info("Highlight captured", {
      courtId: request.courtId,
      finalPath,
      reframed: reframed !== null,
      branded: rendered !== null,
      windowStartMs,
      windowEndMs,
    });
  }
}
