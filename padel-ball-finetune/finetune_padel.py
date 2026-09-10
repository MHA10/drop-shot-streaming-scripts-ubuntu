#!/usr/bin/env python3
"""
finetune_padel.py — transfer-learn the (tennis-pretrained) TrackNet ball detector
onto padel, using the PadelTracker100 dataset.

── IN SIMPLE WORDS ──
We already have a ball-finder trained on tennis. It half-works on padel. This
takes that tennis model as a starting point and keeps training it on 100k
labelled padel frames so it learns padel's ball, court colour, camera angle and
lighting. Output: a padel ball detector we can actually rely on.

── BUSINESS RULES ──
- Train = 2022 WPT Men's final (53,884 windows), Val = Women's final (45,932) —
  the dataset's own split (ball.yaml). Never mix the two, or val is a lie.
- Starts from the tennis weights (transfer learning), NOT from scratch — that is
  the whole point and is why a few epochs suffice instead of hundreds.
- Ground truth is a Gaussian blob at the labelled ball centre, built on the fly
  (no 100k precomputed files). Coord bookkeeping mirrors the base repo exactly:
  model works at 640x360; the "canonical" coord space is 1280x720 (=640x360 x2,
  the scale postprocess() returns), so labels are scaled 1920x1080 -> x2/3.

── WHY IT'S BUILT THIS WAY (change at your peril) ──
- **GT is generated at 1280x720 then resized to 640x360**, exactly as the base
  gt_gen.py did, so the blob size the fine-tune sees matches the blob the tennis
  weights were trained on. Generate it straight at 640x360 with a guessed sigma
  and the pretrained features fight the new target and training stalls.
- **Lower LR than the base (0.5 vs 1.0 Adadelta).** We are nudging good weights,
  not learning from zero; too high wipes the tennis features on the first steps.

── DO NOT ──
- Do NOT point --frames-root at anything but a tree where the manifest's
  `images/<split>/frame_XXXXXX.PNG` paths resolve. A silent path miss = cv2 reads
  None = a black frame = the model quietly learns garbage.
- Do NOT trust a val f1 computed before the frames are verified to pair with the
  labels (run the overlay check first).
"""
import argparse, os, sys, csv, math
import numpy as np, cv2, torch
import torch.optim as optim
from torch.utils.data import Dataset, DataLoader

TN_DIR = os.path.join(os.path.dirname(__file__), "..", "TrackNet")
sys.path.insert(0, os.path.abspath(TN_DIR))
from model import BallTrackerNet          # noqa: E402
from general import train, validate       # noqa: E402  (reuse the base train/val loops)

IN_W, IN_H = 640, 360                      # model input
GT_W, GT_H = 1280, 720                     # GT canvas (matches base gt_gen), then resized to IN
SRC_W, SRC_H = 1920, 1080                  # PadelTracker100 source resolution


def gaussian_patch(size=20, variance=10):
    x, y = np.mgrid[-size:size + 1, -size:size + 1]
    g = np.exp(-(x ** 2 + y ** 2) / float(2 * variance))
    g = g * 255 / g[size][size]
    return g.astype(np.uint8)


class PadelBallDataset(Dataset):
    def __init__(self, manifest, frames_root):
        self.rows = list(csv.DictReader(open(manifest)))
        self.root = frames_root
        self.g = gaussian_patch()
        self.gs = self.g.shape[0] // 2

    def __len__(self):
        return len(self.rows)

    def _frame(self, rel):
        img = cv2.imread(os.path.join(self.root, rel))
        if img is None:
            raise FileNotFoundError(os.path.join(self.root, rel))
        return cv2.resize(img, (IN_W, IN_H))

    def __getitem__(self, i):
        r = self.rows[i]
        imgs = np.concatenate([self._frame(r["path"]), self._frame(r["path_prev"]),
                               self._frame(r["path_preprev"])], axis=2).astype(np.float32) / 255.0
        inp = np.rollaxis(imgs, 2, 0)                         # (9, IN_H, IN_W)
        vis = int(r["visibility"])
        # canonical coords (1280x720) — the scale postprocess() returns
        xg = float(r["x-coordinate"]) * GT_W / SRC_W
        yg = float(r["y-coordinate"]) * GT_H / SRC_H
        gt = np.zeros((GT_H, GT_W), np.uint8)
        if vis:
            cx, cy = int(xg), int(yg)
            x0, x1 = max(0, cx - self.gs), min(GT_W, cx + self.gs + 1)
            y0, y1 = max(0, cy - self.gs), min(GT_H, cy + self.gs + 1)
            gx0, gy0 = x0 - (cx - self.gs), y0 - (cy - self.gs)
            gt[y0:y1, x0:x1] = self.g[gy0:gy0 + (y1 - y0), gx0:gx0 + (x1 - x0)]
        gt = cv2.resize(gt, (IN_W, IN_H)).reshape(IN_W * IN_H).astype(np.int64)
        return inp, gt, xg, yg, vis


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--prep", default=os.path.join(os.path.dirname(__file__), "prep"))
    ap.add_argument("--frames-root", required=True, help="dir where manifest image paths resolve")
    ap.add_argument("--pretrained", required=True, help="tennis TrackNet weights to start from")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "exps", "padel"))
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--lr", type=float, default=0.5)         # gentler than base 1.0 (fine-tune)
    ap.add_argument("--batch-size", type=int, default=2)
    ap.add_argument("--steps-per-epoch", type=int, default=400)
    ap.add_argument("--val-interval", type=int, default=2)
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()

    dev = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
    os.makedirs(args.out, exist_ok=True)

    tr = DataLoader(PadelBallDataset(os.path.join(args.prep, "labels_train.csv"), args.frames_root),
                    batch_size=args.batch_size, shuffle=True, num_workers=args.workers, pin_memory=True)
    va = DataLoader(PadelBallDataset(os.path.join(args.prep, "labels_val.csv"), args.frames_root),
                    batch_size=args.batch_size, shuffle=False, num_workers=args.workers, pin_memory=True)

    model = BallTrackerNet().to(dev)
    sd = torch.load(args.pretrained, map_location=dev)
    if isinstance(sd, dict) and "model_state_dict" in sd:
        sd = sd["model_state_dict"]
    model.load_state_dict(sd)                                # transfer from tennis
    print(f"loaded tennis weights from {args.pretrained}; device={dev}")

    opt = optim.Adadelta(model.parameters(), lr=args.lr)
    best_f1 = 0.0
    for epoch in range(args.epochs):
        loss = train(model, tr, opt, dev, epoch, args.steps_per_epoch)
        print(f"epoch {epoch}: train loss {loss:.5f}")
        if epoch > 0 and epoch % args.val_interval == 0:
            _, prec, rec, f1 = validate(model, va, dev, epoch)
            print(f"epoch {epoch}: val precision {prec:.3f} recall {rec:.3f} f1 {f1:.3f}")
            torch.save(model.state_dict(), os.path.join(args.out, "padel_tracknet_last.pt"))
            if f1 > best_f1:
                best_f1 = f1
                torch.save(model.state_dict(), os.path.join(args.out, "padel_tracknet_best.pt"))
                print(f"  new best f1 {f1:.3f} -> padel_tracknet_best.pt")
    print(f"done. best val f1 = {best_f1:.3f}")


if __name__ == "__main__":
    main()
