#!/usr/bin/env python3
"""Describe what every sighting looks like, once, and save it next to the part.

usage: looks.py <people_dir> <median_png> --poly=... [--device mps]

For each finished part without looks.npz, writes part_xxx/looks.npz:
  colour  (n x 84, float16)  shirt and shorts colours, measured on the person only
  model   (n x 1024, float16) a general picture model's description (ResNet-50,
          ImageNet weights from PyTorch), averaged over the person only
  ok      (n, bool)          enough of the person showed to measure
"Only the person": the empty-court background picture is subtracted, so the
blue floor and the back wall behind a player don't count as their clothes.
Both vectors are unit length, so 1 - (a . b) is how different two looks are.
"""
import argparse, csv, glob, os, sys
import cv2, numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("people_dir")
ap.add_argument("median_png")
ap.add_argument("--poly", required=True)
ap.add_argument("--device", default="cpu")
ap.add_argument("--batch", type=int, default=128)
a = ap.parse_args()
HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("TORCH_HOME", os.path.join(os.environ.get("DS_MODELS", os.path.join(HERE, "models")), "torch"))
import torch, torchvision  # noqa: E402
torch.set_num_threads(int(os.environ.get("DS_THREADS", "3")))

med = cv2.imread(a.median_png)
H, W = med.shape[:2]
poly = np.array([[float(v) for v in p.split(",")] for p in a.poly.split(";")], np.float32)
# same crop area as detect_people.py (the pictures were cut relative to it)
x0 = max(0, int(poly[:, 0].min()) - 40) & ~1
x1 = min(W, int(poly[:, 0].max()) + 40) & ~1
y0 = max(0, int(poly[:, 1].min()) - 120) & ~1
y1 = min(H, int(poly[:, 1].max()) + 20) & ~1
CW, CH = x1 - x0, y1 - y0
medc = med[y0:y1, x0:x1]
TORSO, SHORTS = (0.20, 0.48), (0.50, 0.64)


def person_mask(b, im):
    bx1, by1, bx2, by2 = b
    cx, cy = (bx1 + bx2) / 2 - x0, (by1 + by2) / 2 - y0
    h = (by2 - by1) * 1.12
    w = h / 2
    xa, xb = int(max(0, cx - w / 2)), int(min(CW, cx + w / 2))
    ya, yb = int(max(0, cy - h / 2)), int(min(CH, cy + h / 2))
    if xb - xa < 4 or yb - ya < 8:
        return np.zeros((160, 80), bool)
    bg = cv2.resize(medc[ya:yb, xa:xb], (80, 160), interpolation=cv2.INTER_AREA)
    fg = np.abs(im.astype(int) - bg.astype(int)).sum(2) > 60
    return cv2.morphologyEx(fg.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)).astype(bool)


def hist42(px):
    """Coloured pixels by hue and strength (36), grey/black/white pixels by brightness (6)."""
    hsv = cv2.cvtColor(px.reshape(-1, 1, 3), cv2.COLOR_BGR2HSV).reshape(-1, 3).astype(int)
    h, s, v = hsv[:, 0], hsv[:, 1], hsv[:, 2]
    chrom = (s >= 60) & (v >= 50)
    out = np.zeros(42)
    np.add.at(out, (h[chrom] * 18 // 180) * 2 + (s[chrom] >= 160), 1)
    np.add.at(out, 36 + np.minimum(5, v[~chrom] * 6 // 256), 1)
    return out / max(1, out.sum())


def colour_vec(im, fg):
    parts = []
    for lo, hi in (TORSO, SHORTS):
        r0, r1 = int(lo * 160), int(hi * 160)
        m = fg[r0:r1]
        if m.sum() < 40:
            return None
        parts.append(hist42(im[r0:r1][m]))
    # square roots, so the dot product of two of these is how much the colours overlap
    v = np.r_[np.sqrt(parts[0]) * np.sqrt(0.65), np.sqrt(parts[1]) * np.sqrt(0.35)]
    return v / np.linalg.norm(v)


dev = a.device
rn = torchvision.models.resnet50(weights="IMAGENET1K_V2").eval().to(dev)
feat = {}
rn.layer3.register_forward_hook(lambda m, i, o: feat.__setitem__("l3", o))
MEAN = torch.tensor([0.485, 0.456, 0.406], device=dev).view(1, 3, 1, 1)
STD = torch.tensor([0.229, 0.224, 0.225], device=dev).view(1, 3, 1, 1)


@torch.no_grad()
def model_vecs(ims, masks):
    x = np.stack([cv2.resize(im, (128, 256))[:, :, ::-1] for im in ims]).astype(np.float32) / 255
    t = (torch.from_numpy(x).permute(0, 3, 1, 2).to(dev) - MEAN) / STD
    rn.layer4 = torch.nn.Identity()  # only layer3 is used; skip the rest of the work
    rn.avgpool, rn.fc = torch.nn.Identity(), torch.nn.Identity()
    rn(t)
    f = feat["l3"]                                    # n x 1024 x 16 x 8
    m = np.stack([cv2.resize(k.astype(np.float32), (8, 16), interpolation=cv2.INTER_AREA) for k in masks])
    m = torch.from_numpy(m).to(dev)[:, None]
    v = (f * m).sum((2, 3)) / m.sum((2, 3)).clamp(min=1e-3)
    return torch.nn.functional.normalize(v, dim=1).cpu().numpy()


for p in sorted(glob.glob(os.path.join(a.people_dir, "part_*"))):
    out = os.path.join(p, "looks.npz")
    if not os.path.exists(os.path.join(p, "DONE")) or os.path.exists(out):
        continue
    rows = list(csv.DictReader(open(os.path.join(p, "dets.csv"))))
    idx = np.fromfile(os.path.join(p, "crops.idx"), np.int64).reshape(-1, 2)
    blob = np.memmap(os.path.join(p, "crops.bin"), np.uint8, "r")
    n = len(rows)
    colour = np.zeros((n, 84), np.float16)
    model = np.zeros((n, 1024), np.float16)
    ok = np.zeros(n, bool)
    for s in range(0, n, a.batch):
        ims, masks, which = [], [], []
        for i in range(s, min(n, s + a.batch)):
            o, ln = idx[i]
            im = cv2.imdecode(np.asarray(blob[o:o + ln]), cv2.IMREAD_COLOR)
            b = [float(rows[i][c]) for c in ("x1", "y1", "x2", "y2")]
            fg = person_mask(b, im)
            cv = colour_vec(im, fg)
            if cv is None:
                continue
            colour[i], ok[i] = cv, True
            ims.append(im)
            masks.append(fg)
            which.append(i)
        if ims:
            model[which] = model_vecs(ims, masks)
    # write then rename: a stop mid-write must not leave a half file that later runs skip (review 2026-11-22)
    tmp = out[:-4] + ".tmp.npz"
    np.savez(tmp, colour=colour, model=model, ok=ok)
    os.replace(tmp, out)
    print(f"{os.path.basename(p)}: {n} sightings, {ok.mean() * 100:.0f}% measurable", flush=True)
