#!/usr/bin/env python3
"""Empty-court picture for one match: the middle value of each pixel over ~40 moments.

usage: make_median.py <video|list.ffconcat> <out.png> [--size 1920x852] [--n 40]

Players move, the court does not, so the per-pixel middle value across moments
spread over the whole match is the court without people. The people finder uses
it to ignore figures that never move (a seated referee, a painted logo), and its
size sets the working size for every later step (--poly/--court are in its pixels).
"""
import argparse, subprocess, sys

import cv2
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("video")
ap.add_argument("out")
ap.add_argument("--size", default="1920x852")
ap.add_argument("--n", type=int, default=40)
a = ap.parse_args()
W, H = (int(v) for v in a.size.split("x"))
SRC = ["-f", "concat", "-safe", "0", "-i", a.video] if a.video.endswith(".ffconcat") else ["-i", a.video]
dur = float(subprocess.check_output(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", *SRC]).decode())
frames = []
for k in range(a.n):
    t = dur * (k + 0.5) / a.n
    raw = subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-threads", "2", "-ss", f"{t:.2f}", *SRC,
                          "-frames:v", "1", "-vf", f"scale={W}:{H}", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
                         capture_output=True).stdout
    if len(raw) == W * H * 3:
        frames.append(np.frombuffer(raw, np.uint8).reshape(H, W, 3))
if len(frames) < 5:
    sys.exit(f"only {len(frames)} pictures could be read from {a.video}")
cv2.imwrite(a.out, np.median(np.stack(frames), axis=0).astype(np.uint8))
print(f"empty-court picture from {len(frames)} moments over {dur / 60:.1f} min", flush=True)
