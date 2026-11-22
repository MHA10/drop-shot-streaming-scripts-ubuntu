#!/usr/bin/env python3
"""Find every person on court, several times a second, through a long recording.

usage: detect_people.py <video|list.ffconcat> <median_png> <out_dir> --poly=... --court=...
         [--fps 5] [--part-min 30] [--start-sec S] [--end-sec S] [--device cpu]

Box version (tournament 2026-11-22): the video can be an ffconcat list (a match
spread over the recorder's 10-minute files); every frame is scaled to the
background picture's size first, so --poly/--court are in that picture's pixels
(1920x852 for the Hello Padel cameras, whose own picture is 4256x1888).

Works in 30-minute parts (out_dir/part_000, part_001, ...). A part that
finished has a DONE file and is skipped on a re-run, so a Mac restart or a
stopped run only loses the part it was in.

Each part holds:
  dets.csv    one row per person kept: frame (global, at --fps), t_sec, box, conf
  crops.bin   that person's picture (JPEG, 80x160), back to back, same order
  crops.idx   int64 pairs (offset, length) into crops.bin, same order
The on-court rules are the stats code's own (scripts/track_players.py): feet
inside the court outline, a plausible size for that depth, not a figure that
sits still all day (found on the background picture), duplicate boxes merged.
"""
import argparse, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.environ.get("DS_MODELS", os.path.join(HERE, "models"))
sys.path.insert(0, HERE)
import cv2  # noqa: E402
import numpy as np  # noqa: E402
import track_players as tp  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("video")
ap.add_argument("median_png")
ap.add_argument("out_dir")
ap.add_argument("--poly", required=True, help="court outline 'x,y;x,y;...' (full-frame pixels)")
ap.add_argument("--court", required=True, help="mL,bL,mR,bR,y_top,y_bot,y_net for the size check")
ap.add_argument("--fps", type=float, default=5.0)
ap.add_argument("--part-min", type=float, default=30.0)
ap.add_argument("--start-sec", type=float, default=0.0)
ap.add_argument("--end-sec", type=float, default=0.0, help="0 = to the end of the video")
ap.add_argument("--imgsz", type=int, default=960)
ap.add_argument("--conf", type=float, default=0.25)
ap.add_argument("--batch", type=int, default=8)
ap.add_argument("--device", default="cpu")
a = ap.parse_args()

med = cv2.imread(a.median_png)
H, W = med.shape[:2]
poly = np.array([[float(v) for v in p.split(",")] for p in a.poly.split(";")], np.float32)
court = tp.CourtModel(*[float(v) for v in a.court.split(",")])

# Only the court area goes to the detector: same pixels, less to look at, so a
# far-end player stays larger at the detector's working size. The top margin
# keeps the heads of far-end players whose feet are on the far edge.
x0 = max(0, int(poly[:, 0].min()) - 40)
x1 = min(W, int(poly[:, 0].max()) + 40)
y0 = max(0, int(poly[:, 1].min()) - 120)
y1 = min(H, int(poly[:, 1].max()) + 20)
x0, x1, y0, y1 = x0 & ~1, x1 & ~1, y0 & ~1, y1 & ~1
CW, CH = x1 - x0, y1 - y0

# A match spread over several recordings comes as an ffconcat list.
SRC = ["-f", "concat", "-safe", "0", "-i", a.video] if a.video.endswith(".ffconcat") else ["-i", a.video]
dur = float(subprocess.check_output(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", *SRC]).decode())
end = min(dur, a.end_sec) if a.end_sec else dur

from ultralytics import YOLO  # noqa: E402
import torch  # noqa: E402
torch.set_num_threads(int(os.environ.get("DS_THREADS", "3")))
model = YOLO(os.path.join(MODELS, "yolo11s.pt"))
static = tp._static_people(med, model, a.imgsz, a.device)
print(f"crop {CW}x{CH}+{x0}+{y0}, {len(static)} still figures on the background picture, "
      f"{end:.0f} s to do", flush=True)


def crop_jpeg(img, box):
    """The person at a fixed 1:2 shape, 80x160, so every picture lines up."""
    bx1, by1, bx2, by2 = box
    cx, cy = (bx1 + bx2) / 2 - x0, (by1 + by2) / 2 - y0
    h = (by2 - by1) * 1.12
    w = h / 2
    xa, xb = int(max(0, cx - w / 2)), int(min(CW, cx + w / 2))
    ya, yb = int(max(0, cy - h / 2)), int(min(CH, cy + h / 2))
    c = img[ya:yb, xa:xb]
    if c.size == 0:
        c = np.zeros((160, 80, 3), np.uint8)
    c = cv2.resize(c, (80, 160), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", c, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return buf.tobytes()


def keep(r):
    dets = []
    for xyxy, c in zip(r.boxes.xyxy.tolist(), r.boxes.conf.tolist()):
        bx1, by1, bx2, by2 = xyxy[0] + x0, xyxy[1] + y0, xyxy[2] + x0, xyxy[3] + y0
        foot = ((bx1 + bx2) / 2.0, by2)
        if cv2.pointPolygonTest(poly, foot, False) < 0:
            continue
        d = {"box": (bx1, by1, bx2, by2), "foot": foot, "conf": c}
        if not tp._plausible_size(d, court, W, H):
            continue
        if any(tp._iou(d["box"], s) > 0.35 for s in static):
            continue
        dets.append(d)
    return tp._dedupe(dets)


def run_part(k, s, e, pdir):
    os.makedirs(pdir, exist_ok=True)
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-threads", "2", "-ss", f"{s:.3f}", *SRC, "-t", f"{e - s:.3f}",
           "-vf", f"fps={a.fps},scale={W}:{H},crop={CW}:{CH}:{x0}:{y0}", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=CW * CH * 3 * 4)
    first = int(round(s * a.fps))
    n_frames = n_dets = 0
    t0 = time.time()
    with open(os.path.join(pdir, "dets.csv"), "w") as fd, \
            open(os.path.join(pdir, "crops.bin"), "wb") as fb:
        fd.write("frame,t_sec,x1,y1,x2,y2,conf\n")
        idx, off = [], 0
        done = False
        while not done:
            batch = []
            while len(batch) < a.batch:
                raw = proc.stdout.read(CW * CH * 3)
                if len(raw) < CW * CH * 3:
                    done = True
                    break
                batch.append(np.frombuffer(raw, np.uint8).reshape(CH, CW, 3))
            if not batch:
                break
            res = model.predict(batch, classes=[0], conf=a.conf, imgsz=a.imgsz,
                                device=a.device, verbose=False)
            for img, r in zip(batch, res):
                f = first + n_frames
                for d in keep(r):
                    jb = crop_jpeg(img, d["box"])
                    fb.write(jb)
                    idx.append((off, len(jb)))
                    off += len(jb)
                    bx1, by1, bx2, by2 = d["box"]
                    fd.write(f"{f},{f / a.fps:.2f},{bx1:.1f},{by1:.1f},{bx2:.1f},{by2:.1f},{d['conf']:.3f}\n")
                    n_dets += 1
                n_frames += 1
            if n_frames % 1000 < a.batch:
                el = time.time() - t0
                print(f"  part {k}: {n_frames / a.fps / 60:.1f} of {(e - s) / 60:.0f} min, "
                      f"{n_frames / max(el, 1e-6):.1f} frames/s", flush=True)
    proc.wait()
    if proc.returncode != 0:
        sys.exit(f"ffmpeg failed on part {k} (exit {proc.returncode})")
    np.array(idx, np.int64).reshape(-1, 2).tofile(os.path.join(pdir, "crops.idx"))
    # write then rename: an empty DONE (stopped mid-write) would break the grouping step later
    with open(os.path.join(pdir, "DONE.tmp"), "w") as fdone:
        fdone.write(f"{s:.1f} {e:.1f} frames={n_frames} people={n_dets} secs={time.time() - t0:.0f}\n")
    os.replace(os.path.join(pdir, "DONE.tmp"), os.path.join(pdir, "DONE"))
    print(f"part {k} done: {n_frames} frames, {n_dets} people, {time.time() - t0:.0f} s", flush=True)


os.makedirs(a.out_dir, exist_ok=True)
step = a.part_min * 60
k, s = 0, a.start_sec
while s < end - 0.5:
    e = min(end, s + step)
    pdir = os.path.join(a.out_dir, f"part_{k:03d}")
    if os.path.exists(os.path.join(pdir, "DONE")):
        print(f"part {k} already done, skipping", flush=True)
    else:
        run_part(k, s, e, pdir)
    k, s = k + 1, e
print("all parts done", flush=True)
