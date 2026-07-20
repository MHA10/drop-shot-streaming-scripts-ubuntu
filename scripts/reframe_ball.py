#!/usr/bin/env python3
"""
reframe_ball.py — crop a padel highlight clip to a reel aspect that follows the
ball, using classical CV (no ML model).

IN SIMPLE WORDS
    Reads the wide highlight clip, tries to find the fast-moving ball each frame,
    smoothly pans a tall (e.g. 9:16) crop window to keep it in view, and writes
    the cropped video. If it can't find the ball it holds the last good position
    (and starts centered), so it always produces a watchable vertical clip.

HOW IT ISOLATES THE BALL (vs. the much bigger players)
    Motion is found by frame differencing. Player blobs are rejected two ways:
      * AREA band — the ball is small; blobs bigger than `--max-area-frac` of the
        frame (torsos) or smaller than `--min-area-frac` (noise) are dropped.
      * SHAPE gate — the ball is compact/round; blobs thinner than `--min-aspect`
        (limbs, net lines, motion smears) are dropped.
    Among survivors it prefers the roundest one nearest the current crop centre,
    and rejects implausible cross-court jumps (`--max-jump-frac`) so it won't
    teleport onto a player on the far side.

STATUS / DO NOT
    Classical CV on a wide, dim, multi-player court is a hard case; the defaults
    below are tuned against real footage but are still approximate. The streamer
    keeps ball-tracking OFF by default and falls back to the full frame on any
    failure. A tightly-locked "ball cam" may ultimately need a small model.

Exit non-zero on any hard failure so the caller falls back to the full frame.
"""

import argparse
import sys

try:
    import cv2
    import numpy as np  # noqa: F401 (kept for potential future use / parity)
except Exception as exc:  # noqa: BLE001
    sys.stderr.write(f"reframe_ball: dependencies unavailable: {exc}\n")
    sys.exit(2)


def parse_aspect(aspect: str) -> float:
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
    # Tuning knobs (defaults tuned on real footage; overridable for iteration).
    ap.add_argument("--diff-thresh", type=int, default=25)
    ap.add_argument("--min-area-frac", type=float, default=0.00002)
    ap.add_argument("--max-area-frac", type=float, default=0.0006)
    ap.add_argument("--min-aspect", type=float, default=0.45)
    ap.add_argument("--alpha", type=float, default=0.30)      # pan responsiveness
    ap.add_argument("--max-jump-frac", type=float, default=0.25)
    ap.add_argument("--debug", action="store_true")
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

    # Even crop dims (H.264 needs them); a vertical slice of the reel aspect.
    ratio = parse_aspect(args.aspect)
    crop_w = min(src_w, int(round(src_h * ratio)))
    crop_w -= crop_w % 2
    crop_h = src_h - (src_h % 2)
    half = crop_w // 2

    frame_area = float(src_w * src_h)
    min_area = frame_area * args.min_area_frac
    max_area = frame_area * args.max_area_frac
    max_jump = src_w * args.max_jump_frac

    center_x = src_w / 2.0
    prev_gray = None
    frames_written = 0
    hits = 0

    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(args.output, fourcc, fps, (crop_w, crop_h))
    if not writer.isOpened():
        sys.stderr.write("reframe_ball: cannot open output writer\n")
        cap.release()
        return 3

    while True:
        ok, frame = cap.read()
        if not ok:
            break

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (5, 5), 0)

        detected_x = None
        if prev_gray is not None:
            diff = cv2.absdiff(prev_gray, gray)
            _, thresh = cv2.threshold(diff, args.diff_thresh, 255, cv2.THRESH_BINARY)
            thresh = cv2.dilate(thresh, None, iterations=1)
            contours, _ = cv2.findContours(
                thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
            )
            best = None
            best_score = -1.0
            for c in contours:
                area = cv2.contourArea(c)
                if area < min_area or area > max_area:
                    continue  # too big (player) or too small (noise)
                x, y, w, h = cv2.boundingRect(c)
                if w == 0 or h == 0:
                    continue
                aspect = min(w, h) / float(max(w, h))
                if aspect < args.min_aspect:
                    continue  # elongated smear (limb / line), not the ball
                cx = x + w / 2.0
                dist = abs(cx - center_x)
                if dist > max_jump:
                    continue  # implausible cross-court jump → not our ball
                # Prefer round + near the current crop centre.
                score = aspect - (dist / src_w)
                if score > best_score:
                    best_score = score
                    best = cx
            detected_x = best

        prev_gray = gray

        if detected_x is not None:
            center_x = (1 - args.alpha) * center_x + args.alpha * detected_x
            hits += 1

        cx = int(round(max(half, min(src_w - half, center_x))))
        x0 = cx - half
        crop = frame[0:crop_h, x0:x0 + crop_w]
        if crop.shape[1] != crop_w or crop.shape[0] != crop_h:
            crop = cv2.resize(crop, (crop_w, crop_h))
        writer.write(crop)
        frames_written += 1

    cap.release()
    writer.release()

    if args.debug:
        sys.stderr.write(
            f"reframe_ball: frames={frames_written} ball_hits={hits} "
            f"hit_rate={(hits / frames_written if frames_written else 0):.2f}\n"
        )

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
