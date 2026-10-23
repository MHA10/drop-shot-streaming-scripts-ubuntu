#!/usr/bin/env python3
"""
kaggle_finetune_padel.py — self-contained Kaggle GPU pipeline: fine-tune the
tennis-pretrained TrackNet ball detector onto padel (PadelTracker100).

HOW TO RUN ON KAGGLE
  1. New Notebook -> Settings: Accelerator = GPU T4 x2 (or P100); Internet = ON.
  2. Upload this file (Add data / Utility script) OR paste it into one cell.
  3. Run:  !python kaggle_finetune_padel.py      (or %run kaggle_finetune_padel.py)
  4. Output: /kaggle/working/padel_tracknet_best.pt  (download it, then test on our footage).

WHAT IT DOES (no manual steps)
  - pulls PadelTracker100 (7GB videos + labels) from Zenodo + tennis base weights from a GitHub release
  - extracts frames at 640x360 (what the model sees; keeps disk ~5GB not ~200GB)
  - builds train(Men)/val(Women) manifests from the COCO ball boxes
  - sanity-overlays a few labels on real frames (writes PNGs so you can eyeball alignment)
  - transfer-learns from the tennis weights, saves the best model by val F1

CHANGE AT YOUR PERIL
  - Frames extracted sequentially => frame_000000.png == COCO frame index. The overlay
    cell PROVES this alignment; if the blobs miss the ball, the video is offset -> set FRAME_OFFSET.
  - GT is built at 1280x720 then resized to 640x360 (matches the tennis GT scale) so the
    pretrained features don't fight a mismatched target.
"""
import os, sys, json, csv, math, subprocess, urllib.request, glob, re
import numpy as np, cv2

WORK = "/kaggle/working"; DATA = "/kaggle/temp/pt100"; os.makedirs(DATA, exist_ok=True)
IN_W, IN_H, GT_W, GT_H, SRC_W, SRC_H = 640, 360, 1280, 720, 1920, 1080
FRAME_OFFSET = 0     # set if the overlay shows a constant frame misalignment
ZENODO_DATA = "https://zenodo.org/records/14653706/files/padel-data-labels.zip?download=1"
ZENODO_LABELS = "https://zenodo.org/records/17020011/files/labels.zip?download=1"
TENNIS_WEIGHTS = "https://github.com/rondo-labs/Padex/releases/download/v0.1.0/ball_detection_TrackNet.pt"
SPLITS = {"train_FinalM": "FinalM", "val_FinalF": "FinalF"}   # split -> video/label match token


def sh(cmd): print("+", cmd); subprocess.run(cmd, shell=True, check=True)


def fetch(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 1e6:
        print("have", dest); return
    print("downloading", url, "->", dest)
    sh(f'wget -q -c --tries=30 --retry-connrefused --waitretry=5 -O "{dest}" "{url}"')


# ---------------------------------------------------------------- 1. get everything
def setup():
    if not os.path.isdir(f"{DATA}/TrackNet"):
        sh(f"git clone --depth 1 https://github.com/yastrebksv/TrackNet {DATA}/TrackNet")
    fetch(TENNIS_WEIGHTS, f"{DATA}/tennis_tracknet.pt")
    fetch(ZENODO_LABELS, f"{DATA}/labels.zip");  sh(f'cd {DATA} && unzip -q -o labels.zip')
    fetch(ZENODO_DATA, f"{DATA}/data.zip");       sh(f'cd {DATA} && unzip -q -o data.zip')
    if os.path.exists(f"{DATA}/data.zip"): os.remove(f"{DATA}/data.zip")  # free 7GB; videos deleted after extraction


# ---------------------------------------------------------------- 2. extract frames @640x360
def find_video(token):
    vids = [v for v in glob.glob(f"{DATA}/**/*.mp4", recursive=True)
            if token in os.path.basename(v) and "sample" not in os.path.basename(v).lower()]
    if not vids:
        raise FileNotFoundError(f"no match video for {token}; found: {glob.glob(f'{DATA}/**/*.mp4', recursive=True)}")
    return sorted(vids)[0]


def extract_frames(split, token):
    out = f"{DATA}/images/{split}"; os.makedirs(out, exist_ok=True)
    if len(os.listdir(out)) > 1000:
        print("frames present for", split); return
    vp = find_video(token); print(split, "<-", vp)
    cap = cv2.VideoCapture(vp); i = 0
    while True:
        ok, fr = cap.read()
        if not ok:
            break
        cv2.imwrite(f"{out}/frame_{i:06d}.jpg", cv2.resize(fr, (IN_W, IN_H)), [cv2.IMWRITE_JPEG_QUALITY, 95])
        i += 1
        if i % 5000 == 0:
            print(f"  {split}: {i} frames")
    cap.release(); print(split, "extracted", i, "frames")
    os.remove(vp)  # free disk: the raw video is no longer needed


# ---------------------------------------------------------------- 3. COCO -> manifests
def find_label(token, suffix):
    hits = glob.glob(f"{DATA}/**/*{token}*{suffix}", recursive=True)
    return hits[0] if hits else None


def build_manifests():
    prep = f"{DATA}/prep"; os.makedirs(prep, exist_ok=True)
    for split, token in SPLITS.items():
        coco = json.load(open(find_label(token, "_ball.json")))
        imgs = {im["id"]: im["file_name"] for im in coco["images"]}
        ball = {}
        for a in coco["annotations"]:
            if a.get("category_id") == 1 and a.get("bbox"):
                x, y, w, h = a["bbox"]; ball[a["image_id"]] = (x + w / 2, y + h / 2)
        rows = []
        for iid in sorted(imgs, key=lambda i: imgs[i]):
            f = imgs[iid]
            cx, cy = ball.get(iid, (0, 0)); rows.append([f, int(iid in ball), round(cx, 2), round(cy, 2)])
        fnum = lambda n: int(re.search(r"(\d+)", n).group(1))
        man = []
        for i in range(2, len(rows)):
            r, p1, p2 = rows[i], rows[i - 1], rows[i - 2]
            if not (fnum(r[0]) == fnum(p1[0]) + 1 == fnum(p2[0]) + 2):
                continue
            jpg = lambda n: n.replace(".PNG", ".jpg").replace(".png", ".jpg")
            man.append([f"images/{split}/{jpg(r[0])}",
                        f"images/{split}/{jpg(p1[0])}",
                        f"images/{split}/{jpg(p2[0])}",
                        r[2], r[3], r[1]])
        out = "labels_train.csv" if split.startswith("train") else "labels_val.csv"
        with open(f"{prep}/{out}", "w", newline="") as fh:
            w = csv.writer(fh); w.writerow(["path","path_prev","path_preprev","x","y","vis"]); w.writerows(man)
        print(f"{out}: {len(man)} windows ({sum(m[5] for m in man)} with ball)")


# ---------------------------------------------------------------- 4. dataset + GT on the fly
import torch
from torch.utils.data import Dataset, DataLoader
sys.path.insert(0, f"{DATA}/TrackNet")


def gaussian_patch(size=20, variance=10):
    x, y = np.mgrid[-size:size + 1, -size:size + 1]
    g = np.exp(-(x ** 2 + y ** 2) / float(2 * variance)); g = g * 255 / g[size][size]
    return g.astype(np.uint8)


class PadelBall(Dataset):
    def __init__(self, manifest):
        self.rows = list(csv.DictReader(open(manifest))); self.g = gaussian_patch(); self.gs = self.g.shape[0] // 2

    def __len__(self): return len(self.rows)

    def _f(self, rel):
        p = f"{DATA}/{rel}"; img = cv2.imread(p)
        if img is None: raise FileNotFoundError(p)
        return cv2.resize(img, (IN_W, IN_H))

    def __getitem__(self, i):
        r = self.rows[i]
        imgs = np.concatenate([self._f(r["path"]), self._f(r["path_prev"]), self._f(r["path_preprev"])], 2).astype(np.float32) / 255.0
        inp = np.rollaxis(imgs, 2, 0); vis = int(r["vis"])
        xg = float(r["x"]) * GT_W / SRC_W; yg = float(r["y"]) * GT_H / SRC_H
        gt = np.zeros((GT_H, GT_W), np.uint8)
        if vis:
            cx, cy = int(xg), int(yg)
            x0, x1 = max(0, cx - self.gs), min(GT_W, cx + self.gs + 1)
            y0, y1 = max(0, cy - self.gs), min(GT_H, cy + self.gs + 1)
            gx0, gy0 = x0 - (cx - self.gs), y0 - (cy - self.gs)
            gt[y0:y1, x0:x1] = self.g[gy0:gy0 + (y1 - y0), gx0:gx0 + (x1 - x0)]
        gt = cv2.resize(gt, (IN_W, IN_H)).reshape(IN_W * IN_H).astype(np.int64)
        return inp, gt, xg, yg, vis


# ---------------------------------------------------------------- 5. sanity overlay
def sanity_overlay():
    import csv as _c
    rows = [r for r in _c.DictReader(open(f"{DATA}/prep/labels_val.csv")) if r["vis"] == "1"][:6]
    for k, r in enumerate(rows):
        img = cv2.imread(f"{DATA}/{r['path']}")
        x = int(float(r["x"]) * IN_W / SRC_W); y = int(float(r["y"]) * IN_H / SRC_H)
        cv2.circle(img, (x, y), 8, (0, 0, 255), 2)
        cv2.imwrite(f"{WORK}/overlay_{k}.png", img)
    print("wrote overlay_*.png to", WORK, "-- CHECK the red ring sits on the ball")


# ---------------------------------------------------------------- 6. fine-tune
def finetune(epochs=25, lr=0.5, batch=8, steps=400, val_every=2):
    from model import BallTrackerNet
    from general import train, validate
    dev = "cuda" if torch.cuda.is_available() else "cpu"; print("device", dev)
    tr = DataLoader(PadelBall(f"{DATA}/prep/labels_train.csv"), batch_size=batch, shuffle=True, num_workers=2, pin_memory=True)
    val_ds = PadelBall(f"{DATA}/prep/labels_val.csv")
    vidx = list(range(0, len(val_ds), max(1, len(val_ds) // 3000)))     # ~3k-window val subset (full 46k is too slow per check)
    va = DataLoader(torch.utils.data.Subset(val_ds, vidx), batch_size=batch, shuffle=False, num_workers=2, pin_memory=True)
    print(f"val subset: {len(vidx)} of {len(val_ds)} windows")
    model = BallTrackerNet().to(dev)
    sd = torch.load(f"{DATA}/tennis_tracknet.pt", map_location=dev)
    model.load_state_dict(sd["model_state_dict"] if isinstance(sd, dict) and "model_state_dict" in sd else sd)
    print("loaded tennis base weights")
    opt = torch.optim.Adadelta(model.parameters(), lr=lr); best = 0.0
    for ep in range(epochs):
        loss = train(model, tr, opt, dev, ep, steps); print(f"epoch {ep} train_loss {loss:.4f}")
        if ep > 0 and ep % val_every == 0:
            _, p, r, f1 = validate(model, va, dev, ep); print(f"epoch {ep} val P {p:.3f} R {r:.3f} F1 {f1:.3f}")
            torch.save(model.state_dict(), f"{WORK}/padel_tracknet_last.pt")
            if f1 > best:
                best = f1; torch.save(model.state_dict(), f"{WORK}/padel_tracknet_best.pt"); print("  new best", round(f1, 3))
    print("DONE best val F1 =", round(best, 3), "->", f"{WORK}/padel_tracknet_best.pt")


if __name__ == "__main__":
    setup()
    for s, t in SPLITS.items():
        extract_frames(s, t)
    build_manifests()
    sanity_overlay()
    finetune()
