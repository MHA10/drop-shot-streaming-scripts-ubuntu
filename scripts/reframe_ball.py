#!/usr/bin/env python3
"""
reframe_ball.py — crop a padel highlight clip to a reel aspect that follows the
ball, using classical CV (no ML model).

IN SIMPLE WORDS
    Reads the wide highlight clip, tries to find the fast-moving ball each frame,
    smoothly pans a tall (e.g. 9:16) crop window to keep it in view, and writes
    the cropped video. If it can't find the ball, it holds the last good
    position (and starts centered), so it always produces a watchable vertical
    clip rather than failing.

STATUS / DO NOT
    This is a BEST-EFFORT v1 and is UNVALIDATED on real padel footage. Detection
    thresholds (area range, diff threshold, smoothing) almost certainly need
    tuning against real clips before this is trusted in production — which is why
    the streamer keeps ball-tracking OFF by default and falls back to the full
    frame. Do NOT assume the crop is accurate until it's been tuned on real video.

Exit non-zero on any hard failure so the caller falls back to the full frame.
"""

import argparse
import sys

try:
    import cv2
    import numpy as np
except Exception as exc:  # noqa: BLE001 - missing dep is a hard, fail-soft error
    sys.stderr.write(f"reframe_ball: dependencies unavailable: {exc}\n")
    sys.exit(2)


def parse_aspect(aspect: str) -> float:
    """Return width/height ratio from an 'W:H' string (default 9/16)."""
    try:
        w, h = aspect.split(":")
        r = float(w) / float(h)
        return r if r > 0 else 9 / 16
    except Exception:  # noqa: BLE001
        return 9 / 16


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--aspect", default="9:16")
    args = ap.parse_args()

    cap = cv2.VideoCapture(args.input)
    if not cap.isOpened():
        sys.stderr.write("reframe_ball: cannot open input\n")
        return 3

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if src_w <= 0 or src_h <= 0:
        sys.stderr.write("reframe_ball: bad source dimensions\n")
        return 3

    # Target crop: keep full height, take a vertical slice of the reel aspect.
    # Force EVEN dimensions — H.264 / most encoders reject odd width/height, and
    # an odd size can make VideoWriter emit an unusable file.
    ratio = parse_aspect(args.aspect)
    crop_w = min(src_w, int(round(src_h * ratio)))
    crop_w -= crop_w % 2
    crop_h = src_h - (src_h % 2)
    half = crop_w // 2

    # Center of the crop window (x). Start centered; pan toward the ball with an
    # exponential moving average so the motion is smooth, not jittery.
    center_x = src_w / 2.0
    ema_alpha = 0.15  # lower = smoother/slower pan
    prev_gray = None
    frames_written = 0

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(args.output, fourcc, fps, (crop_w, crop_h))
    if not writer.isOpened():
        sys.stderr.write("reframe_ball: cannot open output writer\n")
        cap.release()
        return 3

    # Ball candidate area bounds (fraction of frame area). A padel ball is small
    # and fast; these are rough starting points and WILL need tuning.
    frame_area = float(src_w * src_h)
    min_area = frame_area * 0.00002
    max_area = frame_area * 0.01

    while True:
        ok, frame = cap.read()
        if not ok:
            break

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (5, 5), 0)

        detected_x = None
        if prev_gray is not None:
            diff = cv2.absdiff(prev_gray, gray)
            _, thresh = cv2.threshold(diff, 18, 255, cv2.THRESH_BINARY)
            thresh = cv2.dilate(thresh, None, iterations=2)
            contours, _ = cv2.findContours(
                thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
            )
            best = None
            best_score = 0.0
            for c in contours:
                area = cv2.contourArea(c)
                if area < min_area or area > max_area:
                    continue
                x, y, w, h = cv2.boundingRect(c)
                # Prefer compact, roughly-round blobs (ball-like) over long smears.
                aspect_pen = min(w, h) / max(w, h) if max(w, h) > 0 else 0
                score = area * (0.5 + aspect_pen)
                if score > best_score:
                    best_score = score
                    best = (x + w / 2.0, y + h / 2.0)
            if best is not None:
                detected_x = best[0]

        prev_gray = gray

        if detected_x is not None:
            center_x = (1 - ema_alpha) * center_x + ema_alpha * detected_x

        # Clamp so the crop stays fully inside the frame.
        cx = int(round(max(half, min(src_w - half, center_x))))
        x0 = cx - half
        crop = frame[0:crop_h, x0:x0 + crop_w]
        # Guard against off-by-one at the right edge.
        if crop.shape[1] != crop_w or crop.shape[0] != crop_h:
            crop = cv2.resize(crop, (crop_w, crop_h))
        writer.write(crop)
        frames_written += 1

    cap.release()
    writer.release()

    # No frames → the output is unusable; fail hard so the caller falls back to
    # the full-frame clip instead of shipping an empty reel.
    if frames_written == 0:
        sys.stderr.write("reframe_ball: no frames written\n")
        return 4
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"reframe_ball: unexpected error: {exc}\n")
        sys.exit(1)
