#!/usr/bin/env python3
"""
match_sessions.py — split one recording into the separate matches it contains,
by noticing when the people on court change.

── IN SIMPLE WORDS ──
A stream titled as one match is often a whole evening: several matches, back to
back, with different players each time. Everything downstream of this assumes
one match with four fixed players, so feeding it a league session produces
confident nonsense.

This looks at what the players are WEARING at the start of every point. While
the same four people are playing, that set of kits stays the same. When it
changes and stays changed, a new match has started. The output is a list of
matches, each a run of points, which the later stages can then process one at a
time.

── BUSINESS RULES ──
- A session boundary is where the ROSTER changes, not where there is a long
  gap. On the reference league recording no gap in 86 minutes exceeded 40s, so
  gap-based splitting finds nothing at all.
- Boundaries are measured between points, so every match is a whole number of
  points and no point is split across two matches.
- A run shorter than `--min-points` is not a match; it is warmup, a knock-up, or
  a few stray detections between matches.

── WHY IT'S BUILT THIS WAY (change at your peril) ──
- **Sampled at point starts, not on a fixed clock.** At the start of a point all
  four players are on court, still, and in canonical positions. A fixed-interval
  sample lands half the time on an empty court between points, and an empty
  sample carries no roster information at all.
- **Kit signature is a histogram over a shared codebook, not a raw descriptor
  set.** Two points have different numbers of detected players and no
  correspondence between them, so their descriptors cannot be compared
  elementwise. Quantising to a shared codebook makes every point a fixed-length
  vector that can be.
- **A boundary needs the change to PERSIST.** The test compares a window of
  points before against a window after, rather than adjacent points. One
  mis-detected point changes a single sample; a new match changes every sample
  that follows, and only the second should split the file.

── DO NOT ──
- Do NOT run this to find set breaks or changeovers WITHIN a match. The roster
  does not change at a changeover, so it will correctly find nothing.
- Do NOT trust a boundary that falls where the court was nearly empty. Few
  players detected means a weak signature on both sides of the split; those are
  reported with a low `confidence`.
- Do NOT assume one recording is one match just because the title says so. That
  assumption is exactly what this stage exists to stop making — a league
  recording produced serve-end runs of 41 points and 12.57 points per game
  before it existed.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile

try:
    import cv2
    import numpy as np
except Exception as exc:  # noqa: BLE001
    sys.stderr.write(f"match_sessions: dependencies unavailable: {exc}\n")
    sys.exit(2)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from track_players import calibrate  # noqa: E402
from match_players import descriptor, frame_at  # noqa: E402


def roster_descriptors(video, court, poly, model, points, verbose):
    """Kit descriptors of everyone on court at the start of each point."""
    out = []
    for i, p in enumerate(points):
        t = p.get("rally_start", p["start"])
        im = frame_at(video, t)
        if im is None:
            out.append([])
            continue
        r = model.predict(im, classes=[0], conf=0.30, imgsz=1280,
                          device="mps" if sys.platform == "darwin" else None,
                          retina_masks=True, verbose=False)[0]
        descs = []
        if r.masks is not None:
            masks = r.masks.data.cpu().numpy()
            for k, bb in enumerate(r.boxes.xyxy.tolist()):
                foot = ((bb[0] + bb[2]) / 2.0, bb[3])
                if cv2.pointPolygonTest(poly, foot, False) < 0:
                    continue
                m = masks[k]
                if m.shape[:2] != im.shape[:2]:
                    m = cv2.resize(m.astype(np.float32), (im.shape[1], im.shape[0]))
                d = descriptor(im, m > 0.5)
                if d is not None:
                    descs.append(d)
        out.append(descs)
        if verbose and (i + 1) % 40 == 0:
            sys.stderr.write(f"match_sessions: sampled {i+1}/{len(points)} points\n")
    return out


def build_codebook(descs, k, seed=0):
    X = np.stack([d for row in descs for d in row]) if any(descs) else None
    if X is None or len(X) < k:
        return None
    rng = np.random.default_rng(seed)
    C = [X[rng.integers(len(X))]]
    for _ in range(k - 1):
        dist = np.min([((X - c) ** 2).sum(1) for c in C], axis=0)
        C.append(X[int(np.argmax(dist))])
    C = np.stack(C)
    for _ in range(25):
        lab = np.argmin(((X[:, None, :] - C[None]) ** 2).sum(2), axis=1)
        newC = np.stack([X[lab == j].mean(0) if (lab == j).any() else C[j]
                         for j in range(k)])
        if np.allclose(newC, C, atol=1e-6):
            break
        C = newC
    return C


def signatures(descs, C):
    """Each point -> a normalised histogram over the kit codebook."""
    sig = np.zeros((len(descs), len(C)), np.float32)
    for i, row in enumerate(descs):
        for d in row:
            j = int(np.argmin(((C - d) ** 2).sum(1)))
            sig[i, j] += 1.0
    s = sig.sum(1, keepdims=True)
    return sig / np.clip(s, 1e-6, None), s[:, 0]


def find_boundaries(sig, counts, win, thresh, min_points):
    """
    Split where the roster changes AND stays changed.

    Compares the mean signature of `win` points before against `win` after.
    Adjacent-point comparison was tried first and fires on any single
    mis-detection; a new match changes every following point, which is the
    property worth detecting.
    """
    n = len(sig)
    if n < 2 * win + 2:
        return [], np.zeros(n)
    score = np.zeros(n)
    for i in range(win, n - win):
        a = sig[i - win:i].mean(0)
        b = sig[i:i + win].mean(0)
        na, nb = np.linalg.norm(a), np.linalg.norm(b)
        if na < 1e-6 or nb < 1e-6:
            continue
        score[i] = 1.0 - float(a @ b / (na * nb))
    bounds = []
    order = np.argsort(-score)
    for i in order:
        if score[i] < thresh:
            break
        if any(abs(i - b) < min_points for b in bounds):
            continue
        if i < min_points or i > n - min_points:
            continue
        bounds.append(int(i))
    return sorted(bounds), score


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--input", required=True, help="letterbox-stripped recording")
    ap.add_argument("--points", required=True,
                    help="JSON from match_refine.py (or match_points.py)")
    ap.add_argument("--output", required=True)
    ap.add_argument("--seg-model", default="tools/reels/models/yolo11s-seg.pt")
    ap.add_argument("--codebook", type=int, default=10,
                    help="kit clusters; needs to exceed the number of distinct "
                         "kits in the whole recording, not in one match")
    ap.add_argument("--window", type=int, default=12,
                    help="points either side of a candidate boundary")
    ap.add_argument("--thresh", type=float, default=0.35,
                    help="cosine distance between the two windows")
    ap.add_argument("--min-points", type=int, default=15,
                    help="shorter runs are warmup or stray detections, not matches")
    ap.add_argument("--split-dir", default="",
                    help="write one points JSON per detected match here")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()

    data = json.load(open(args.points))
    points = data["points"]
    court, note = calibrate(args.input, [90, 40, 40], [130, 255, 255])
    if court is None:
        sys.stderr.write(f"match_sessions: calibration failed ({note})\n")
        return 3
    poly = court.polygon()
    from ultralytics import YOLO
    descs = roster_descriptors(args.input, court, poly, YOLO(args.seg_model),
                               points, args.debug)
    C = build_codebook(descs, args.codebook)
    if C is None:
        sys.stderr.write("match_sessions: not enough player detections\n")
        return 4
    sig, counts = signatures(descs, C)
    bounds, score = find_boundaries(sig, counts, args.window, args.thresh,
                                    args.min_points)

    edges = [0] + bounds + [len(points)]
    sessions = []
    for a, b in zip(edges, edges[1:]):
        if b - a < args.min_points:
            continue
        seg = points[a:b]
        mean_players = float(np.mean([len(d) for d in descs[a:b]])) if b > a else 0.0
        sessions.append({
            "match": len(sessions) + 1,
            "first_point": seg[0]["point"], "last_point": seg[-1]["point"],
            "point_index": [a, b],
            "start": round(seg[0]["start"], 2), "end": round(seg[-1]["end"], 2),
            "points": len(seg),
            "minutes": round((seg[-1]["end"] - seg[0]["start"]) / 60.0, 1),
            "mean_players_detected": round(mean_players, 2),
            "confidence": round(min(1.0, mean_players / 4.0), 2),
        })

    payload = {
        "input": args.input,
        "diagnostics": {
            "points_in": len(points),
            "boundaries": bounds,
            "matches_found": len(sessions),
            "max_change_score": round(float(score.max()), 3) if len(score) else 0.0,
        },
        "sessions": sessions,
    }
    json.dump(payload, open(args.output, "w"), indent=2)

    if args.split_dir:
        os.makedirs(args.split_dir, exist_ok=True)
        for s in sessions:
            a, b = s["point_index"]
            sub = dict(data)
            sub["points"] = points[a:b]
            sub["session"] = s
            with open(os.path.join(args.split_dir, f"match{s['match']:02d}.json"), "w") as fh:
                json.dump(sub, fh, indent=2)

    if args.debug:
        d = payload["diagnostics"]
        sys.stderr.write(
            f"match_sessions: {d['points_in']} points -> {d['matches_found']} matches "
            f"(max roster-change score {d['max_change_score']})\n")
        for s in sessions:
            sys.stderr.write(
                f"    match {s['match']}: points {s['first_point']}-{s['last_point']} "
                f"({s['points']} pts, {s['minutes']} min, "
                f"{s['mean_players_detected']} players/frame)\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"match_sessions: unexpected error: {exc}\n")
        sys.exit(1)
