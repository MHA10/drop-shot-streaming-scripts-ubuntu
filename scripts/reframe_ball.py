#!/usr/bin/env python3
"""
reframe_ball.py — crop a padel highlight clip to a reel aspect that follows the
ball, using classical CV (no ML model).

DETECTION (COLOR + MOTION + SHAPE)
    A padel ball is small, round, bright optic-yellow, and moving; players and
    background are not all four. So each frame we intersect three cues:
      * COLOR  — an HSV range for the ball (rejects dark clothing / blue court).
      * MOTION — frame differencing (rejects STATIC yellow: lines, signage).
      * SHAPE/SIZE — small + round blob (rejects big/elongated player motion).
    Among survivors we pick the roundest nearest the last position and reject
    implausible cross-court jumps.

SMOOTH PANNING (two passes)
    Per-frame reaction is jittery, so we detect over the WHOLE clip, then build
    ONE smoothed pan path (interpolate gaps -> median filter -> wide moving
    average -> hard max-velocity clamp) and render the crop along it. Smoothness
    is prioritized over a tight ball-lock.

DEBUG / DEMO
    --debug-overlay <path> writes a FULL-FRAME annotated video showing, per
    frame: the detected ball box (green), the chosen ball centre (red dot), and
    the crop window (yellow). Use it to see/tune what the detector locks onto.

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


def parse_hsv(s: str, default):
    try:
        parts = [int(v) for v in s.split(",")]
        return np.array(parts[:3], dtype=np.uint8) if len(parts) >= 3 else np.array(default, np.uint8)
    except Exception:  # noqa: BLE001
        return np.array(default, np.uint8)


def moving_average(xs, win):
    if win < 2:
        return xs
    win = int(win) | 1
    pad = win // 2
    return np.convolve(np.pad(xs, pad, mode="edge"), np.ones(win) / win, mode="valid")


def median_filter(xs, win):
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
    # Colour gate (HSV, OpenCV H is 0-179). Default = optic yellow-green ball.
    ap.add_argument("--hsv-lower", default="20,70,120")
    ap.add_argument("--hsv-upper", default="45,255,255")
    # Motion + shape gates
    ap.add_argument("--diff-thresh", type=int, default=18)
    ap.add_argument("--motion-dilate", type=int, default=12)  # px halo around motion
    ap.add_argument("--min-area-frac", type=float, default=0.000008)
    ap.add_argument("--max-area-frac", type=float, default=0.0006)
    ap.add_argument("--min-aspect", type=float, default=0.5)
    ap.add_argument("--max-jump-frac", type=float, default=0.30)
    # Smoothing
    ap.add_argument("--median-sec", type=float, default=0.5)
    ap.add_argument("--smooth-sec", type=float, default=2.0)
    ap.add_argument("--max-vel-frac", type=float, default=0.004)
    ap.add_argument("--debug-overlay", default="")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()

    lower = parse_hsv(args.hsv_lower, [20, 70, 120])
    upper = parse_hsv(args.hsv_upper, [45, 255, 255])

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

    # ---- Pass 1: detect ball x + box per frame ----
    xs_raw = []          # x or NaN
    boxes = []           # (x,y,w,h) or None
    prev_gray = None
    last_x = src_w / 2.0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        color = cv2.inRange(hsv, lower, upper)
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

        found_x = np.nan
        found_box = None
        if prev_gray is not None:
            diff = cv2.absdiff(prev_gray, gray)
            _, motion = cv2.threshold(diff, args.diff_thresh, 255, cv2.THRESH_BINARY)
            if args.motion_dilate > 0:
                k = np.ones((args.motion_dilate, args.motion_dilate), np.uint8)
                motion = cv2.dilate(motion, k, iterations=1)
            mask = cv2.bitwise_and(color, motion)   # yellow AND moving
            contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
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
                    found_x = cx
                    found_box = (x, y, w, h)
            if found_box is not None:
                last_x = found_x
        prev_gray = gray
        xs_raw.append(found_x)
        boxes.append(found_box)
    cap.release()

    n = len(xs_raw)
    if n == 0:
        sys.stderr.write("reframe_ball: no frames read\n")
        return 4

    xs = np.array(xs_raw, dtype=float)
    valid = ~np.isnan(xs)
    hit_rate = valid.sum() / n

    if valid.sum() < max(5, n * 0.03):
        path = np.full(n, src_w / 2.0)
    else:
        idx = np.arange(n)
        xs[~valid] = np.interp(idx[~valid], idx[valid], xs[valid])
        xs = median_filter(xs, round(args.median_sec * fps))
        xs = moving_average(xs, round(args.smooth_sec * fps))
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

    # ---- Pass 2: render crop (+ optional debug overlay) ----
    cap = cv2.VideoCapture(args.input)
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(args.output, fourcc, fps, (crop_w, crop_h))
    if not writer.isOpened():
        sys.stderr.write("reframe_ball: cannot open output writer\n")
        cap.release()
        return 3
    overlay_writer = None
    if args.debug_overlay:
        overlay_writer = cv2.VideoWriter(args.debug_overlay, fourcc, fps, (src_w, src_h))

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

        if overlay_writer is not None:
            ov = frame.copy()
            # crop window (yellow)
            cv2.rectangle(ov, (x0, 0), (x0 + crop_w, crop_h), (0, 255, 255), 3)
            box = boxes[min(i, n - 1)]
            if box is not None:
                bx, by, bw, bh = box
                cv2.rectangle(ov, (bx, by), (bx + bw, by + bh), (0, 255, 0), 2)
                cv2.circle(ov, (bx + bw // 2, by + bh // 2), 6, (0, 0, 255), -1)
                cv2.putText(ov, f"ball x={bx + bw // 2} y={by + bh // 2}", (bx, max(0, by - 8)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)
            else:
                cv2.putText(ov, "ball: (none this frame)", (20, 40),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
            overlay_writer.write(ov)
        i += 1
    cap.release()
    writer.release()
    if overlay_writer is not None:
        overlay_writer.release()

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
