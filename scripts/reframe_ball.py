#!/usr/bin/env python3
"""
reframe_ball.py — crop a padel highlight clip to a reel aspect that follows the
play, using classical CV (no ML model).

MODES (--mode)
  action  (default) — follow the PLAYERS. Background subtraction (MOG2) isolates
      the moving people; the crop centre is their area-weighted horizontal
      centre, so it sits on wherever the rally is. Robust: players are big,
      stable targets (unlike the tiny ball, which color/motion can't separate
      from yellow-green plants and orange paddles on this footage).
  ball — follow the BALL via an HSV colour gate ∩ motion ∩ small-round shape.
      Kept for footage where the ball is cleanly separable; unreliable on dim,
      cluttered courts (documented limitation).

SMOOTH PANNING (two passes)
  Detect a target x for every frame, then build ONE smoothed pan path
  (interpolate gaps → median filter → wide moving average → hard max-velocity
  clamp) and render the crop along it. Smoothness is prioritized.

DEBUG / DEMO
  --debug-overlay <path> writes a full-frame annotated video: detected boxes
  (green), the chosen crop-centre (red dot), and the crop window (yellow).

Off by default in the streamer; falls back to full frame on any failure.
"""

import argparse
import sys

try:
    import cv2
    import numpy as np
except Exception as exc:  # noqa: BLE001
    sys.stderr.write(f"reframe_ball: dependencies unavailable: {exc}\n")
    sys.exit(2)


def parse_aspect(aspect):
    try:
        w, h = aspect.split(":")
        r = float(w) / float(h)
        return r if r > 0 else 9 / 16
    except Exception:  # noqa: BLE001
        return 9 / 16


def parse_hsv(s, default):
    try:
        p = [int(v) for v in s.split(",")]
        return np.array(p[:3], np.uint8) if len(p) >= 3 else np.array(default, np.uint8)
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--aspect", default="9:16")
    ap.add_argument("--mode", choices=["action", "ball"], default="action")
    # action-mode (players)
    ap.add_argument("--min-player-frac", type=float, default=0.0015)
    ap.add_argument("--max-player-frac", type=float, default=0.20)
    # ball-mode
    ap.add_argument("--hsv-lower", default="20,70,120")
    ap.add_argument("--hsv-upper", default="45,255,255")
    ap.add_argument("--diff-thresh", type=int, default=18)
    ap.add_argument("--min-area-frac", type=float, default=0.000008)
    ap.add_argument("--max-area-frac", type=float, default=0.0006)
    ap.add_argument("--min-aspect", type=float, default=0.5)
    ap.add_argument("--max-jump-frac", type=float, default=0.30)
    # smoothing
    ap.add_argument("--median-sec", type=float, default=0.5)
    ap.add_argument("--smooth-sec", type=float, default=2.0)
    ap.add_argument("--max-vel-frac", type=float, default=0.004)
    # performance: detection runs on a downscaled, frame-skipped copy so the
    # reframe finishes well under timeout on low-power streamer boxes.
    ap.add_argument("--proc-width", type=int, default=640)
    ap.add_argument("--detect-fps", type=float, default=12.0)
    ap.add_argument("--debug-overlay", default="")
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
        cap.release()
        return 3

    ratio = parse_aspect(args.aspect)
    crop_w = min(src_w, int(round(src_h * ratio)))
    crop_w -= crop_w % 2
    crop_h = src_h - (src_h % 2)
    half = crop_w // 2

    # ── DETECTION runs downscaled + frame-skipped (perf) ──
    # MOG2 + contours on every full-res 1080p frame is far too slow on
    # low-power streamer boxes — it blew the reframe timeout and starved the
    # live encoder. We only need approximate player positions (the pan path is
    # heavily smoothed afterwards), so detect on a ~proc_width-wide frame, only
    # every `step` frames (~detect_fps), and scale results back to source
    # coordinates. Output resolution/quality is unchanged — only detection is
    # cheapened.
    proc_w = min(src_w, max(160, args.proc_width))
    det_scale = proc_w / float(src_w)            # <= 1.0
    det_w = proc_w
    det_h = max(2, int(round(src_h * det_scale)))
    det_area = float(det_w * det_h)
    inv_scale = src_w / float(det_w)             # det coords → source coords
    step = max(1, int(round(fps / max(1.0, args.detect_fps))))

    # detector state (all area/jump thresholds measured on the DOWNSCALED frame)
    lower = parse_hsv(args.hsv_lower, [20, 70, 120])
    upper = parse_hsv(args.hsv_upper, [45, 255, 255])
    min_area = det_area * args.min_area_frac
    max_area = det_area * args.max_area_frac
    max_jump = det_w * args.max_jump_frac
    min_player = det_area * args.min_player_frac
    max_player = det_area * args.max_player_frac
    bg = cv2.createBackgroundSubtractorMOG2(history=300, varThreshold=40, detectShadows=False) \
        if args.mode == "action" else None

    xs_raw, boxes_per_frame = [], []
    prev_gray = None
    last_x = det_w / 2.0
    idx = 0

    while True:
        # grab() advances the decoder without fully decoding; only retrieve()
        # (decode) the frames we actually analyse, so skipped frames are cheap.
        if not cap.grab():
            break
        found_x = np.nan
        frame_boxes = []

        if idx % step == 0:
            ok, frame = cap.retrieve()
            if not ok:
                break
            frame_s = cv2.resize(frame, (det_w, det_h), interpolation=cv2.INTER_AREA) \
                if det_scale < 1.0 else frame
            gray = cv2.cvtColor(frame_s, cv2.COLOR_BGR2GRAY)

            if args.mode == "action":
                fg = bg.apply(frame_s)
                _, fg = cv2.threshold(fg, 200, 255, cv2.THRESH_BINARY)  # drop shadows/soft
                fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
                # kernels sized for the downscaled frame (were 9x9 at full res)
                fg = cv2.dilate(fg, np.ones((5, 5), np.uint8), iterations=1)
                contours, _ = cv2.findContours(fg, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                wsum = 0.0
                xsum = 0.0
                for c in contours:
                    area = cv2.contourArea(c)
                    if area < min_player or area > max_player:
                        continue  # too small (noise/plants) or too big (light flash)
                    x, y, w, h = cv2.boundingRect(c)
                    # Reject only extreme horizontal streaks (reflections / banner
                    # glints). Keep near-square and wide blobs — two clustered
                    # players often merge into a wide box at the key rally moments,
                    # and dropping those was hurting tracking accuracy.
                    if w > h * 3:
                        continue
                    cx = x + w / 2.0
                    wsum += area
                    xsum += area * cx
                    frame_boxes.append((x, y, w, h))
                if wsum > 0:
                    found_x = xsum / wsum
            else:  # ball mode
                hsv = cv2.cvtColor(frame_s, cv2.COLOR_BGR2HSV)
                color = cv2.inRange(hsv, lower, upper)
                if prev_gray is not None:
                    diff = cv2.absdiff(prev_gray, gray)
                    _, motion = cv2.threshold(diff, args.diff_thresh, 255, cv2.THRESH_BINARY)
                    motion = cv2.dilate(motion, np.ones((7, 7), np.uint8), iterations=1)
                    mask = cv2.bitwise_and(color, motion)
                    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                    best = -1.0
                    for c in contours:
                        area = cv2.contourArea(c)
                        if area < min_area or area > max_area:
                            continue
                        x, y, w, h = cv2.boundingRect(c)
                        if w == 0 or h == 0 or min(w, h) / max(w, h) < args.min_aspect:
                            continue
                        cx = x + w / 2.0
                        dist = abs(cx - last_x)
                        if dist > max_jump:
                            continue
                        score = (min(w, h) / max(w, h)) - dist / det_w
                        if score > best:
                            best = score
                            found_x = cx
                            frame_boxes = [(x, y, w, h)]
                    if not np.isnan(found_x):
                        last_x = found_x
                prev_gray = gray

            # Map detection-space results up to source coordinates so all the
            # downstream path math stays in real (source) pixels.
            if not np.isnan(found_x):
                found_x *= inv_scale
            if inv_scale != 1.0 and frame_boxes:
                frame_boxes = [
                    (int(x * inv_scale), int(y * inv_scale),
                     int(w * inv_scale), int(h * inv_scale))
                    for (x, y, w, h) in frame_boxes
                ]

        xs_raw.append(found_x)
        boxes_per_frame.append(frame_boxes)
        idx += 1
    cap.release()

    n = len(xs_raw)
    if n == 0:
        sys.stderr.write("reframe_ball: no frames read\n")
        return 4
    xs = np.array(xs_raw, dtype=float)
    valid = ~np.isnan(xs)
    # hit_rate is over the frames we actually analysed (not skipped ones)
    processed = max(1, (n + step - 1) // step)
    hit_rate = valid.sum() / processed

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
            f"reframe_ball: mode={args.mode} frames={n} hit_rate={hit_rate:.2f} "
            f"max_step_px={vel.max():.0f} mean_step_px={vel.mean():.2f}\n"
        )

    cap = cv2.VideoCapture(args.input)
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(args.output, fourcc, fps, (crop_w, crop_h))
    if not writer.isOpened():
        sys.stderr.write("reframe_ball: cannot open output writer\n")
        cap.release()
        return 3
    ov_writer = cv2.VideoWriter(args.debug_overlay, fourcc, fps, (src_w, src_h)) \
        if args.debug_overlay else None

    i = written = 0
    try:
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
            if ov_writer is not None:
                ov = frame.copy()
                cv2.rectangle(ov, (x0, 0), (x0 + crop_w, crop_h), (0, 255, 255), 3)
                for (bx, by, bw, bh) in boxes_per_frame[min(i, n - 1)]:
                    cv2.rectangle(ov, (bx, by), (bx + bw, by + bh), (0, 255, 0), 2)
                cv2.circle(ov, (cx, crop_h // 2), 8, (0, 0, 255), -1)
                cv2.putText(ov, f"{args.mode} center x={cx}", (x0 + 8, 30),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
                ov_writer.write(ov)
            i += 1
    finally:
        # Always release so an error mid-render never leaks handles or leaves a
        # locked/partial file (the caller ffprobe-validates and falls back).
        cap.release()
        writer.release()
        if ov_writer is not None:
            ov_writer.release()

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
