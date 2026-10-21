/**
 * Watches a live ffmpeg's stderr and says when the YOUTUBE output has died.
 *
 * ── IN SIMPLE WORDS ──
 * A live ffmpeg has two outputs: YouTube (RTMP, format "flv", output 0) and,
 * when highlights are on, the highlight-buffer recording (output 1). If
 * YouTube drops the connection, ffmpeg 6.1 (Ubuntu 24.04's version) closes
 * only that output and keeps running for the buffer. The process never exits
 * and its `time=` keeps moving, so the old stall check (frozen `time=`) never
 * fired and the court stayed off YouTube until pm2 was restarted by hand
 * (Padel Central, 21 Oct 2026).
 *
 * This watcher spots that two ways:
 *  1. ffmpeg reports a muxing/trailer error on the flv (YouTube) output.
 *  2. `frame=` stops increasing. On ffmpeg 6.1 `frame=` and `size=` follow
 *     output 0 (YouTube) — they froze when the RTMP side died, while `time=`
 *     kept moving with the buffer output. A frozen camera also freezes
 *     `frame=`, so the old "camera stalled" case is still caught.
 *
 * The caller kills ffmpeg on a verdict; the existing exit handler restarts
 * the stream with the same key.
 *
 * ── DO NOT ──
 * - Do NOT match errors from the buffer output (`out#1/segment`): the buffer
 *   is fail-soft by design and must never take the live stream down.
 */

export type YoutubeOutputVerdict =
  | { kind: "ok" }
  | { kind: "output-failed"; detail: string }
  | { kind: "stalled"; frame: number; repeats: number };

// "[out#0/flv @ 0x...] Error muxing a packet" / "... Error writing trailer: ..."
const FLV_OUTPUT_ERROR =
  /\[out#\d+\/flv @ [^\]]+\] (Error muxing a packet|Error writing trailer[^\r\n]*)/;
const FRAME = /frame=\s*(\d+)/g;

export class YoutubeOutputWatch {
  private lastFrame: number | null = null;
  private repeats = 0;

  /** @param maxRepeats consecutive progress reports with an unchanged frame count before "stalled" */
  constructor(private readonly maxRepeats = 10) {}

  /** Feed one stderr chunk; returns the verdict for this chunk. */
  public feed(chunk: string): YoutubeOutputVerdict {
    const err = chunk.match(FLV_OUTPUT_ERROR);
    if (err) {
      return { kind: "output-failed", detail: err[1].trim() };
    }

    // A chunk can hold several progress reports; judge each in order.
    for (const m of chunk.matchAll(FRAME)) {
      const frame = parseInt(m[1], 10);
      if (this.lastFrame !== null && frame === this.lastFrame) {
        this.repeats++;
        if (this.repeats >= this.maxRepeats) {
          const verdict: YoutubeOutputVerdict = { kind: "stalled", frame, repeats: this.repeats };
          this.repeats = 0;
          return verdict;
        }
      } else {
        this.repeats = 0;
        this.lastFrame = frame;
      }
    }
    return { kind: "ok" };
  }

  /** How many consecutive reports the frame count has been unchanged (for logging). */
  public get stalledReports(): number {
    return this.repeats;
  }
}
