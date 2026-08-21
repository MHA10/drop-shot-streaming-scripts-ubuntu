#!/usr/bin/env python3
"""
match_players.py — give the four players a stable identity across the whole
match, and name which one served each point.

── IN SIMPLE WORDS ──
The serve detector can say "the near end served, from that spot". It cannot say
"Ahmed served" — for that the same human has to be recognisable from one end of
the match to the other, through a changeover that swaps which side they stand on.

This recognises them by kit: what colour is the shirt, and what colour are the
shorts. On the reference match that is enough to tell four players apart —
black-and-white number jersey, plain white shirt, dark green shirt, and one
player in unmistakable orange shorts.

Then it leans on the fact that a padel court holds exactly four people, one of
each. So it never asks "which player is this?" in isolation; it asks "what is
the best way to hand out all four names in this frame at once?", which is a much
easier question and cannot produce two of the same player.

── BUSINESS RULES ──
- Exactly four identities, and every frame gets a one-to-one assignment of all
  four. Two players cannot share a name in the same instant.
- Teammates are always on the same side of the net, so the pair sharing a half
  is a team. Teams are fixed for the match; which END they occupy is not.
- Within a game the server never changes. Within a run of two games on one end,
  expect exactly TWO servers, one from each team, in two contiguous blocks —
  and the point where they change is the game boundary.

── WHY IT'S BUILT THIS WAY (change at your peril) ──
- **Shirt and shorts are separate features.** The first attempt averaged the
  whole torso box into one mean BGR and it failed outright: only 41% of
  four-player frames separated into four clusters. Averaging destroys the
  signal, because it is the COMBINATION that identifies a player (grey shirt +
  orange shorts vs grey shirt + dark shorts). Split the box and the pairs
  separate.
- **Hue is averaged as a vector, not a scalar.** Hue is circular: red sits at
  both 0 and 180 in OpenCV's scale, so a numeric mean puts a red shirt in the
  cyans. Averaged as cos/sin, weighted by saturation so grey pixels do not vote
  on hue at all.
- **Assignment is bijective per frame, not free clustering.** Free k-means has
  no idea that a frame contains one of each player, so it happily labels two
  players the same and leaves one identity unused — which is exactly how the
  41% failure looked. Forcing a permutation over all four uses the strongest
  constraint available and is cheap (24 orderings).
- **Sampled at the serve instant.** Players are near-stationary there, so the
  crop is not motion-blurred and the box is not half a lunging limb.

── DO NOT ──
- Do NOT use `team_side_consistency` to decide whether identity worked. It
  cannot detect the main failure. When the descriptor carries no information the
  assignment degenerates to labelling by position, which makes side-consistency
  read 1.00 — a perfect score for having no identity at all. Measured by
  ablation. Use `identity_end_swap` instead: it is the fraction of appearances
  at a player's minority end, ~0.45 when identity is real and 0.00 when the
  labels are just position.
- Do NOT assume identity survives a kit change or a match where all four wear
  the same kit. This keys on clothing. `identity_end_swap` is the canary.
- Do NOT trust the per-point server name over the per-game one. A single point
  can be misassigned; a game pools ~6 points and the rules say the server is
  constant within it, so `games[].server` is the number to quote.
- Do NOT read P1..P4 as team order. They are arbitrary labels from the
  clustering; `teams` in the output says who partners whom.
"""

import argparse
import itertools
import json
import os
import subprocess
import sys
import tempfile
from collections import Counter

try:
    import cv2
    import numpy as np
except Exception as exc:  # noqa: BLE001
    sys.stderr.write(f"match_players: dependencies unavailable: {exc}\n")
    sys.exit(2)

NAMES = ("P1", "P2", "P3", "P4")


HUE_BINS, VAL_BINS = 12, 5
# Explicit kit cues, weighted well above the histograms. The histograms alone
# confuse the two light-shirted players with each other and the two dark-shirted
# players with each other, because at the far end shirt brightness is most of
# what survives compression. These four numbers are close to a one-to-one map
# onto the four kits in the reference match (dark number-jersey with light
# shorts, plain white, dark green, light shirt with ORANGE shorts), and orange
# shorts in particular is the single most discriminative thing on the court.
CUE_WEIGHT = 3.0


ABLATE = ""


def descriptor(img, mask):
    """
    Kit signature from the player's OWN pixels: a saturation-weighted hue
    histogram plus a value histogram, computed separately for the shirt band and
    the shorts band of the segmentation mask.

    Histograms, not means. Two earlier attempts used summary statistics (mean
    hue/sat/val per region) and both failed: a region contains kit, skin, shadow
    and shoes, so the mean of orange shorts plus bare legs is not orange. The
    histogram keeps the orange as its own mode instead of averaging it away.

    Value is histogrammed rather than used raw because the two ends of the court
    are lit differently; a soft histogram tolerates that where a mean does not.
    """
    ys, xs = np.where(mask)
    if len(ys) < 40:
        return None
    y0, y1 = ys.min(), ys.max()
    h = y1 - y0 + 1
    if h < 16:
        return None
    feat = []
    for lo, hi in ((0.15, 0.48), (0.48, 0.78)):      # shirt, shorts
        band = (ys >= y0 + h * lo) & (ys < y0 + h * hi)
        if band.sum() < 25:
            return None
        px = img[ys[band], xs[band]].reshape(-1, 1, 3)
        hsv = cv2.cvtColor(px, cv2.COLOR_BGR2HSV).reshape(-1, 3)
        H = hsv[:, 0].astype(np.float32)
        S = hsv[:, 1].astype(np.float32) / 255.0
        V = hsv[:, 2].astype(np.float32) / 255.0
        hh, _ = np.histogram(H, bins=HUE_BINS, range=(0, 180), weights=S)
        vv, _ = np.histogram(V, bins=VAL_BINS, range=(0, 1))
        hh = hh / (hh.sum() + 1e-6)
        vv = vv / (vv.sum() + 1e-6)
        cues = np.array([
            float((((H < 22) | (H > 168)) & (S > 0.30)).mean()),   # orange/red
            float((V < 0.30).mean()),                              # near-black
            float(((H > 30) & (H < 90) & (S > 0.20)).mean()),       # green
            float(((V > 0.55) & (S < 0.35)).mean()),               # white/grey
        ], np.float32) * CUE_WEIGHT
        if ABLATE in ("cues", "all"):
            cues = cues * 0.0
        if ABLATE in ("hue", "all"):
            hh = hh * 0.0
        if ABLATE == "all":
            # Four identical kits: nothing but body/lighting noise is left.
            vv = vv * 0.0
        feat.append(np.concatenate([hh, vv, cues]))
    return np.concatenate(feat).astype(np.float32)


def frame_at(video, t):
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", f"{t:.3f}", "-i", video,
                        "-frames:v", "1", "-q:v", "2", f"{tmp}/f.jpg"], check=False)
        f = f"{tmp}/f.jpg"
        return cv2.imread(f) if os.path.exists(f) else None


def _iou(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0.0, x2 - x1), max(0.0, y2 - y1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    ua = (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - inter
    return inter / max(1e-6, ua)


def collect(video, serves, model, verbose):
    """Descriptors for the four players at every point that shows all four."""
    rows = []
    for i, p in enumerate(serves["points"]):
        if p.get("serve_frame_t") is None or len(p["players_at_serve"]) != 4:
            continue
        im = frame_at(video, p["serve_frame_t"])
        if im is None:
            continue
        r = model.predict(im, classes=[0], conf=0.25, imgsz=1280,
                          device="mps" if sys.platform == "darwin" else None,
                          retina_masks=True, verbose=False)[0]
        if r.masks is None:
            continue
        sboxes = r.boxes.xyxy.tolist()
        smasks = r.masks.data.cpu().numpy()
        entry = {"point": p["point"], "serve_side": p["serve_side"],
                 "players": [], "server_idx": None}
        srv_box = p["server"]["box"] if p.get("server") else None
        for q in p["players_at_serve"]:
            best, bi = 0.0, None
            for k, bb in enumerate(sboxes):
                v = _iou(q["box"], bb)
                if v > best:
                    best, bi = v, k
            d = None
            if bi is not None and best >= 0.5:
                m = smasks[bi]
                if m.shape[:2] != im.shape[:2]:
                    m = cv2.resize(m.astype(np.float32), (im.shape[1], im.shape[0]))
                d = descriptor(im, m > 0.5)
            if d is None:
                entry = None
                break
            if srv_box and abs(q["box"][0] - srv_box[0]) < 1 and abs(q["box"][1] - srv_box[1]) < 1:
                entry["server_idx"] = len(entry["players"])
            entry["players"].append({"desc": d, "u": q["u"], "v": q["v"]})
        if entry and len(entry["players"]) == 4:
            rows.append(entry)
        if verbose and (i + 1) % 25 == 0:
            sys.stderr.write(f"match_players: sampled {i+1}/{len(serves['points'])} points\n")
    return rows


def fit(rows, iters=30, seed=0):
    """
    Constrained clustering: four prototypes, one-to-one per frame.

    Init spreads the seeds by farthest-point rather than at random, because a
    random draw of four descriptors routinely lands two seeds on the same player
    and the bijective constraint then has to fight the initialisation for the
    whole run.
    """
    X = np.stack([q["desc"] for r in rows for q in r["players"]])
    rng = np.random.default_rng(seed)
    proto = [X[rng.integers(len(X))]]
    for _ in range(3):
        d = np.min([((X - c) ** 2).sum(1) for c in proto], axis=0)
        proto.append(X[int(np.argmax(d))])
    P = np.stack(proto)

    perms = list(itertools.permutations(range(4)))
    assign = None
    for _ in range(iters):
        assign = []
        for r in rows:
            D = np.stack([((P - q["desc"]) ** 2).sum(1) for q in r["players"]])  # 4x4
            best, bp = None, None
            for pm in perms:
                c = sum(D[k, pm[k]] for k in range(4))
                if best is None or c < best:
                    best, bp = c, pm
            assign.append(bp)
        newP = np.zeros_like(P)
        cnt = np.zeros(4)
        for r, pm in zip(rows, assign):
            for k in range(4):
                newP[pm[k]] += r["players"][k]["desc"]
                cnt[pm[k]] += 1
        for j in range(4):
            if cnt[j] > 0:
                newP[j] = newP[j] / cnt[j]
            else:
                newP[j] = P[j]
        if np.allclose(newP, P, atol=1e-6):
            P = newP
            break
        P = newP
    cost = float(np.mean([
        sum(((P[pm[k]] - r["players"][k]["desc"]) ** 2).sum() for k in range(4))
        for r, pm in zip(rows, assign)]))
    return P, assign, cost


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--input", required=True, help="letterbox-stripped match video")
    ap.add_argument("--serves", required=True, help="JSON from match_serves.py")
    ap.add_argument("--output", required=True)
    ap.add_argument("--ablate", default="",
                    help="drop part of the kit descriptor, to see what identity "
                         "does when kits stop being distinguishable: "
                         "'cues' (no explicit kit cues), 'hue' (no colour at all, "
                         "value only) or 'all' (simulate four identical kits)")
    ap.add_argument("--seg-model", default="tools/reels/models/yolo11s-seg.pt",
                    help="segmentation weights; kit colour must come from the "
                         "player's own pixels, not the bounding box (a standing "
                         "player is thin, so the box is mostly blue court)")
    ap.add_argument("--set-break", type=float, default=45.0,
                    help="quiet gap that marks a set break; serve order may reset there")
    ap.add_argument("--montage", default="", help="write a labelled crop sheet here")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()

    global ABLATE
    ABLATE = args.ablate
    if ABLATE:
        sys.stderr.write(f"match_players: ABLATION '{ABLATE}' - simulating kits that "
                         f"cannot be told apart\n")
    serves = json.load(open(args.serves))
    v_net = serves["court"]["v_net"]
    from ultralytics import YOLO
    rows = collect(args.input, serves, YOLO(args.seg_model), args.debug)
    if len(rows) < 8:
        sys.stderr.write(f"match_players: only {len(rows)} usable points; need more\n")
        return 4
    P, assign, cost = fit(rows)

    # ── the real identity check: does each name appear at BOTH ends? ──
    # Players swap ends at every changeover, so a genuine identity is seen at
    # both. If the descriptor carries no information the bijective assignment
    # degenerates to labelling by position in the detection list, which pins
    # each name to one end forever. Measured by ablating the kit descriptor to
    # zero: end-swap balance fell to 0.00 while team_side_consistency read 1.00
    # and serve-rotation consistency read 0.71 -- both of those are inflated by
    # position-derived labels and CANNOT detect this failure.
    ends = {j: [0, 0] for j in range(4)}
    for r, pm in zip(rows, assign):
        for k in range(4):
            ends[pm[k]][0 if r["players"][k]["v"] < v_net else 1] += 1
    swap = []
    for j in range(4):
        tot = sum(ends[j])
        swap.append(min(ends[j]) / tot if tot else 0.0)
    end_swap = float(np.mean(swap))

    # ── teams: the pair sharing a half of the court ──
    pair_votes = Counter()
    for r, pm in zip(rows, assign):
        far = tuple(sorted(pm[k] for k in range(4) if r["players"][k]["v"] < v_net))
        near = tuple(sorted(pm[k] for k in range(4) if r["players"][k]["v"] >= v_net))
        if len(far) == 2 and len(near) == 2:
            pair_votes[tuple(sorted((far, near)))] += 1
    teams = None
    if pair_votes:
        teams = pair_votes.most_common(1)[0][0]
    consistency = (pair_votes.most_common(1)[0][1] / sum(pair_votes.values())
                   if pair_votes else 0.0)

    # ── per-point server identity ──
    out_points = []
    for r, pm in zip(rows, assign):
        srv = None if r["server_idx"] is None else NAMES[pm[r["server_idx"]]]
        out_points.append({"point": r["point"], "serve_side": r["serve_side"],
                           "server_player": srv,
                           "players": {NAMES[pm[k]]: {"u": round(r["players"][k]["u"], 3),
                                                      "v": round(r["players"][k]["v"], 3)}
                                       for k in range(4)}})

    # ── games: within a serve-end run the server changes exactly once ──
    runs = []
    cur = [out_points[0]]
    for a, b in zip(out_points, out_points[1:]):
        if b["serve_side"] != a["serve_side"]:
            runs.append(cur)
            cur = [b]
        else:
            cur.append(b)
    runs.append(cur)

    games = []
    for run in runs:
        names = [q["server_player"] for q in run]
        # split the run at the point that best separates two contiguous servers
        best = (None, -1)
        for cut in range(1, len(run)):
            a = Counter(n for n in names[:cut] if n).most_common(1)
            b = Counter(n for n in names[cut:] if n).most_common(1)
            if not a or not b or a[0][0] == b[0][0]:
                continue
            score = a[0][1] + b[0][1]
            if score > best[1]:
                best = (cut, score)
        cut = best[0]
        blocks = [run] if cut is None else [run[:cut], run[cut:]]
        for blk in blocks:
            c = Counter(q["server_player"] for q in blk if q["server_player"])
            if not c:
                continue
            srv, n = c.most_common(1)[0]
            games.append({"points": [q["point"] for q in blk],
                          "serve_side": blk[0]["serve_side"],
                          "server": srv,
                          "agreement": round(n / len([q for q in blk if q["server_player"]]), 2)})

    # ── validate against padel's serve rotation ──
    # Teams alternate every game, and within a team the two players alternate
    # their service games. So the server sequence must look like
    # X1, Y1, X2, Y2, X1, Y1, ... for some pairing. Scoring the best pairing is
    # a far stronger check than the side-based one: it uses the rulebook rather
    # than a geometric guess, and it caught an identity swap that
    # team_side_consistency reported as 0.707 either way.
    # Scored PER SET, not across the whole match. At the start of a new set the
    # teams may choose their serve order afresh, so a global rotation check
    # penalises a correct identity assignment for a rule it does not break: on
    # the reference match, scoring globally gave 0.588 while the first ten games
    # were a flawless alternation.
    tstart = {p["point"]: p["start"] for p in serves["points"]}
    tend = {p["point"]: p["end"] for p in serves["points"]}
    segs, cur = [], []
    for g in games:
        if cur:
            gap = tstart[g["points"][0]] - tend[cur[-1]["points"][-1]]
            if gap >= args.set_break:
                segs.append(cur)
                cur = []
        cur.append(g)
    if cur:
        segs.append(cur)

    def best_pairing(seq):
        """Which two pairs best explain the whole match's serve order."""
        allp = sorted(set(seq))
        if len(allp) != 4:
            return None
        best, pairing = -1.0, None
        for a in itertools.combinations(allp, 2):
            b = tuple(x for x in allp if x not in a)
            sc, _ = score(seq, [list(a), list(b)])
            if sc > best:
                best, pairing = sc, [list(a), list(b)]
        return pairing

    def score(seq, pairing):
        """
        Fraction of games whose server matches the rotation, given a fixed team
        pairing. Free parameters are only which team starts and which member of
        each team starts, so a SHORT segment is scorable too -- the earlier
        version demanded four distinct servers and therefore scored every
        two-game set 0.0 regardless of how correct it was.
        """
        if not seq or pairing is None:
            return 0.0, None
        best, cfg = 0.0, None
        A, B = pairing
        for first in (0, 1):
            for ia in (0, 1):
                for ib in (0, 1):
                    exp = []
                    for k in range(len(seq)):
                        t_is_a = (k % 2 == 0) if first == 0 else (k % 2 == 1)
                        team, off = (A, ia) if t_is_a else (B, ib)
                        exp.append(team[(off + (k // 2)) % 2])
                    sc = float(np.mean([x == y for x, y in zip(seq, exp)]))
                    if sc > best:
                        best, cfg = sc, {"first_team": "A" if first == 0 else "B"}
        return best, cfg

    seq = [g["server"] for g in games]
    rot_pairing = best_pairing(seq)
    per_set = []
    for sg in segs:
        sc, cfg = score([g["server"] for g in sg], rot_pairing)
        per_set.append({"games": len(sg), "consistency": round(sc, 3), "config": cfg})
    rot_best = (float(np.average([x["consistency"] for x in per_set],
                                 weights=[x["games"] for x in per_set]))
                if per_set else 0.0)

    payload = {
        "input": args.input,
        "identities": {NAMES[j]: {
            "shirt_hue_hist": [round(float(x), 3) for x in P[j][:HUE_BINS]],
            "shorts_hue_hist": [round(float(x), 3)
                                for x in P[j][HUE_BINS+VAL_BINS:HUE_BINS*2+VAL_BINS]],
        } for j in range(4)},
        "teams": None if teams is None else [[NAMES[j] for j in teams[0]],
                                            [NAMES[j] for j in teams[1]]],
        "diagnostics": {
            "points_used": len(rows),
            "assign_cost": round(cost, 4),
            "team_side_consistency": round(consistency, 3),
            "games_found": len(games),
            "mean_game_agreement": round(float(np.mean([g["agreement"] for g in games])), 3)
            if games else 0.0,
            "serve_rotation_consistency": round(rot_best, 3),
            "identity_end_swap": round(end_swap, 3),
            "identity_ok": bool(end_swap >= 0.15),
            "distinct_servers": len(set(seq)),
        },
        "teams_from_serve_rotation": rot_pairing,
        "serve_rotation_per_set": per_set,
        "games": games,
        "points": out_points,
    }
    json.dump(payload, open(args.output, "w"), indent=2)

    if args.montage:
        _montage(args.input, serves, rows, assign, args.montage)

    if args.debug:
        d = payload["diagnostics"]
        sys.stderr.write(
            f"match_players: {d['points_used']} points, assign cost {d['assign_cost']}\n"
            f"match_players: teams {payload['teams']}  "
            f"side-consistency {d['team_side_consistency']}\n"
            f"match_players: identity end-swap {d['identity_end_swap']} "
            f"({'OK' if d['identity_ok'] else 'BROKEN - labels are position, not '
               'identity; kits are probably indistinguishable'})\n"
            f"match_players: {d['games_found']} games, mean server agreement "
            f"{d['mean_game_agreement']}\n"
            f"match_players: serve-rotation consistency {d['serve_rotation_consistency']} "
            f"(per-set: {[x['consistency'] for x in per_set]}); "
            f"teams by rotation {payload['teams_from_serve_rotation']}\n")
        for g in games:
            sys.stderr.write(f"    game {len(g['points']):>2} pts  {g['serve_side']:>4} end  "
                             f"server {g['server']}  agreement {g['agreement']}\n")
    return 0


def _montage(video, serves, rows, assign, path, n=12, cw=80, ch=150):
    """Crops grouped by assigned identity — the fastest way to spot a bad fit."""
    cols = {j: [] for j in range(4)}
    for r, pm in zip(rows, assign):
        p = next(q for q in serves["points"] if q["point"] == r["point"])
        im = frame_at(video, p["serve_frame_t"])
        if im is None:
            continue
        for k in range(4):
            if len(cols[pm[k]]) >= n:
                continue
            x1, y1, x2, y2 = [int(v) for v in p["players_at_serve"][k]["box"]]
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(im.shape[1], x2), min(im.shape[0], y2)
            c = im[y1:y2, x1:x2]
            if c.size:
                cols[pm[k]].append(cv2.resize(c, (cw, ch)))
        if all(len(v) >= n for v in cols.values()):
            break
    grid = np.zeros((n * ch + 24, 4 * cw, 3), np.uint8)
    for j in range(4):
        for i, c in enumerate(cols[j]):
            grid[24 + i*ch:24 + (i+1)*ch, j*cw:(j+1)*cw] = c
        cv2.putText(grid, NAMES[j], (j*cw + 6, 17), cv2.FONT_HERSHEY_DUPLEX, 0.5,
                    (0, 255, 255), 1, cv2.LINE_AA)
    cv2.imwrite(path, grid)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"match_players: unexpected error: {exc}\n")
        sys.exit(1)
