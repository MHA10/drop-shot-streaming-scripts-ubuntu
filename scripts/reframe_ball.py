#!/usr/bin/env python3
"""
reframe_ball.py — crop a padel highlight clip to a reel aspect that follows the
ball, using classical CV (no ML model).

IN SIMPLE WORDS
    Reads the wide highlight clip, estimates where the ball/action is over the
    whole clip, then pans a tall (e.g. 9:16) crop window along a HEAVILY
    SMOOTHED path so the motion is gentle and cinematic — never jittery. If it
    can't find the ball it holds/centres, so it always produces a watchable
    vertical clip.

WHY TWO PASSES (smoothness first)
    Per-frame reaction looks jittery: detection hops between the ball and
    players and the crop snaps around. Because this runs offline we can afford
    two passes:
      Pass 1 — detect a ball-like x for every frame (small, round, moving blob;
               players rejected by area + roundness; cross-court jumps rejected).
      Post   — build ONE smooth trajectory from those noisy points:
               interpolate gaps → median filter (kill spikes) → wide moving
               average (smooth) → clamp max pan velocity (no sudden shifts).
      Pass 2 — render the crop along that smooth path.
    The priority is SMOOTH PANNING over tight ball-locking; a locked "ball cam"
    on a wide dim multi-player court really needs a detection model.

STATUS / DO NOT
    Off by default in the streamer; falls back to full frame on any failure.

Exit non-zero on any hard failure so the caller falls back to the full frame.
"""

import argparse
import sys

try:
    import cv2
    import numpy as np
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


def moving_average(xs, win):
    """Edge-padded moving average (no darkening/pull-in at the ends)."""
    if win < 2:
        return xs
    win = int(win) | 1  # odd
    pad = win // 2
    padded = np.pad(xs, pad, mode="edge")
    kernel = np.ones(win) / win
    return np.convolve(padded, kernel, mode="valid")


def median_filter(xs, win):
    """Simple sliding-window median to remove spikes."""
    if win < 3:
        return xs
    win = int(win) | 1
    pad = win // 2
    padded = np.pad(xs, pad, mode="edge")
    out = np.empty_like(xs)
    for i in range(len(xs)):
        out[i] = np.median(padded[i:i + win])
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--aspect", default="9:16")
    # Detection knobs
    ap.add_argument("--diff-thresh", type=int, default=25)
    ap.add_argument("--min-area-frac", type=float, default=0.00002)
    ap.add_argument("--max-area-frac", type=float, default=0.0006)
    ap.add_argument("--min-aspect", type=float, default=0.45)
    ap.add_argument("--max-jump-frac", type=float, default=0.25)
    # Smoothing knobs (in seconds / fraction) — tuned for gentle motion
    ap.add_argument("--median-sec", type=float, default=0.5)   # spike removal
    ap.add_argument("--smooth-sec", type=float, default=2.0)   # main smoothing
    ap.add_argument("--max-vel-frac", type=float, default=0.004)  # px/frame / width
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

    ratio = parse_aspect(args.aspect)
    crop_w = min(src_w, int(round(src_h * ratio)))
    crop_w -= crop_w % 2
    crop_h = src_h - (src_h % 2)
    half = crop_w // 2

    frame_area = float(src_w * src_h)
    min_area = frame_area * args.min_area_frac
    max_area = frame_area * args.max_area_frac
    max_jump = src_w * args.max_jump_frac

    # ---- Pass 1: raw per-frame ball x (NaN when not found) ----
    raw = []
    prev_gray = None
    last_x = src_w / 2.0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        gray = cv2.GaussianBlur(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (5, 5), 0)
        found = np.nan
        if prev_gray is not None:
            diff = cv2.absdiff(prev_gray, gray)
            _, th = cv2.threshold(diff, args.diff_thresh, 255, cv2.THRESH_BINARY)
            th = cv2.dilate(th, None, iterations=1)
            contours, _ = cv2.findContours(th, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            best = None
            best_score = -1.0
            for c in contours:
                area = cv2.contourArea(c)
                if area < min_area or area > max_area:
                    continue
                x, y, w, h = cv2.boundingRect(c)
                if w == 0 or h == 0:
                    continue
                aspect = min(w, h) / float(max(w, h))
                if aspect < args.min_aspect:
                    continue
                cx = x + w / 2.0
                dist = abs(cx - last_x)
                if dist > max_jump:
                    continue
                score = aspect - (dist / src_w)
                if score > best_score:
                    best_score = score
                    best = cx
            if best is not None:
                found = best
                last_x = best
        prev_gray = gray
        raw.append(found)
    cap.release()

    n = len(raw)
    if n == 0:
        sys.stderr.write("reframe_ball: no frames read\n")
        return 4

    xs = np.array(raw, dtype=float)
    valid = ~np.isnan(xs)
    hit_rate = valid.sum() / n

    # ---- Build one smooth trajectory ----
    if valid.sum() < max(5, n * 0.05):
        # Too few detections to trust — hold a static centre (still smooth).
        path = np.full(n, src_w / 2.0)
    else:
        idx = np.arange(n)
        xs[~valid] = np.interp(idx[~valid], idx[valid], xs[valid])  # fill gaps
        xs = median_filter(xs, round(args.median_sec * fps))        # kill spikes
        xs = moving_average(xs, round(args.smooth_sec * fps))       # smooth
        # Hard velocity clamp — guarantees no sudden shifts frame-to-frame.
        max_vel = max(1.0, src_w * args.max_vel_frac)
        path = np.empty(n)
        path[0] = xs[0]
        for i in range(1, n):
            dx = np.clip(xs[i] - path[i - 1], -max_vel, max_vel)
            path[i] = path[i - 1] + dx

    path = np.clip(np.round(path), half, src_w - half).astype(int)

    if args.debug:
        vel = np.abs(np.diff(path)) if n > 1 else np.array([0])
        sys.stderr.write(
            f"reframe_ball: frames={n} hit_rate={hit_rate:.2f} "
            f"max_step_px={vel.max():.0f} mean_step_px={vel.mean():.2f}\n"
        )

    # ---- Pass 2: render crop along the smooth path ----
    cap = cv2.VideoCapture(args.input)
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(args.output, fourcc, fps, (crop_w, crop_h))
    if not writer.isOpened():
        sys.stderr.write("reframe_ball: cannot open output writer\n")
        cap.release()
        return 3
    i = 0
    written = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        cx = int(path[min(i, n - 1)])
        x0 = cx - half
        crop = frame[0:crop_h, x0:x0 + crop_w]
        if crop.shape[1] != crop_w or crop.shape[0] != crop_h:
            crop = cv2.resize(crop, (crop_w, crop_h))
        writer.write(crop)
        written += 1
        i += 1
    cap.release()
    writer.release()

    if written == 0:
        sys.stderr.write("reframe_ball: no frames written\n")
        return 4
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"reframe_ball: unexpected error: {exc}\n")
        sys.exit(1)
