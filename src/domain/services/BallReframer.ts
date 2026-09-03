/**
 * Reframes a raw highlight clip to follow the ball, producing a
 * social-media-shaped (e.g. 9:16) video.
 *
 * ── IN SIMPLE WORDS ──
 * Takes the wide, full-court highlight clip and produces a cropped version that
 * pans/zooms to keep the action (the ball) in frame, in a vertical aspect good
 * for social posts. If it can't (feature off, or detection fails), it returns
 * null and the caller just uses the full-frame clip instead.
 *
 * ── BUSINESS RULES ──
 * - Off by default: the classical-CV implementation is unvalidated without real
 *   padel footage, so a bad detection day must never block a highlight — it
 *   falls back to the full frame.
 * - Reframing OWNS the crop/track (it writes the reframed video). Logo overlay
 *   is a separate, later step so it works identically on a reframed or a
 *   full-frame clip.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * Returning a produced VIDEO PATH (not a per-frame crop path) keeps the hard
 * per-frame cropping in OpenCV, which does it well, instead of forcing ffmpeg
 * to apply an arbitrary motion path via fragile filter expressions.
 *
 * ── DO NOT ──
 * - Do NOT throw: any failure must resolve to null (full-frame fallback).
 */
export interface BallReframer {
  /**
   * Produce a ball-following, reel-aspect video from `clipPath`. Returns the
   * output path, or null when reframing is disabled or fails (caller falls back
   * to the original clip). Never throws.
   */
  reframe(clipPath: string, courtId: string): Promise<string | null>;
}
