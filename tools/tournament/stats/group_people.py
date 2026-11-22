#!/usr/bin/env python3
"""Turn every on-court sighting into person numbers, with each number's stats for the whole stream.

usage: group_people.py <people_dir> <out_dir> --court=... [--fps 5] [--max-gap-min 5]
         [--strict-pct 1] [--margin 0.3] [--min-look-s 3]

<people_dir> is detect_people.py's output; each part needs DONE and looks.npz
(from looks.py). Parts without both are left out.

Step 1, pieces. A sighting is joined to the one in the previous frame when the
person moved a believable distance and nobody else was close enough to be
mixed up with them. When two people are close together (passing each other,
standing side by side at the net) both pieces simply end there.

Step 2, persons. Pieces are joined into one person number by how they look:
shirt and shorts colours plus a general picture model's description, both
measured on the person only. A join needs all of:
  - the two never on court at the same moment;
  - they look more alike than 99% of pairs of people who WERE on court
    together in this video (--strict-pct; that line is worked out from the
    video itself, so a venue with darker light or similar kits gets a
    stricter line automatically). At 99% (the first try) the whole 23 Oct
    final joined two white-shirt players across a change of players at 0:20;
    at 99.5% they stay apart, for ~4% more of the playing time left in
    numbers under 5 minutes;
  - nobody else on court around that moment looks nearly as alike (--margin);
  - for joins by look alone (not a moment-later, close-by continuation), each
    side has at least --min-look-s seconds of sightings, because a look
    measured on a few frames is mostly noise. Without this, people walking on
    and off one at a time between matches chained into one number.
Gaps longer than --max-gap-min are never joined: someone who leaves and comes
back later is a new number (agreed 2026-10-25; players merge them later).

Rule: when unsure, keep apart. A player split into two numbers costs one tap
to merge. Two players in one number mixes their stats, and nobody can fix that
by tapping.

Writes <out_dir>/people.json (numbers, the pieces each one is made of, and each
piece's stats in a form that adds up, so a merge on the review page just adds
the pieces), piece_of.npy (sighting -> piece), pieces.csv and group-report.txt.
"""
import argparse, csv, glob, heapq, json, os, sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402
from scipy.optimize import linear_sum_assignment  # noqa: E402
import track_players as tp  # noqa: E402
import player_stats as ps  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("people_dir")
ap.add_argument("out_dir")
ap.add_argument("--court", required=True)
ap.add_argument("--fps", type=float, default=5.0)
ap.add_argument("--max-gap-min", type=float, default=5.0)
ap.add_argument("--strict-pct", type=float, default=0.5)
ap.add_argument("--margin", type=float, default=0.3)
ap.add_argument("--min-look-s", type=float, default=3.0)
ap.add_argument("--near-factor", type=float, default=1.2,
                help="how much looser the line is for a moment-later, close-by continuation")
a = ap.parse_args()
os.makedirs(a.out_dir, exist_ok=True)
FPS = a.fps
court = tp.CourtModel(*[float(v) for v in a.court.split(",")])

# ── load every finished part ────────────────────────────────────────────────
parts = sorted(p for p in glob.glob(os.path.join(a.people_dir, "part_*"))
               if os.path.exists(os.path.join(p, "DONE")) and os.path.exists(os.path.join(p, "looks.npz")))
if not parts:
    sys.exit("no part has both DONE and looks.npz yet")
frame, box, conf, src, off, ln, look_c, look_m, look_ok = [], [], [], [], [], [], [], [], []
for k, p in enumerate(parts):
    rows = list(csv.DictReader(open(os.path.join(p, "dets.csv"))))
    idx = np.fromfile(os.path.join(p, "crops.idx"), np.int64).reshape(-1, 2)
    lk = np.load(os.path.join(p, "looks.npz"))
    assert len(idx) == len(rows) == len(lk["ok"]), p
    for r, (o, n) in zip(rows, idx):
        frame.append(int(r["frame"]))
        box.append([float(r[c]) for c in ("x1", "y1", "x2", "y2")])
        conf.append(float(r["conf"]))
        src.append(k)
        off.append(int(o))
        ln.append(int(n))
    look_c.append(lk["colour"].astype(np.float32))
    look_m.append(lk["model"].astype(np.float32))
    look_ok.append(lk["ok"])
frame, box, conf = np.array(frame), np.array(box), np.array(conf)
look_c, look_m, look_ok = np.concatenate(look_c), np.concatenate(look_m), np.concatenate(look_ok)
N = len(frame)
last_frame = max(float(open(os.path.join(p, "DONE")).read().split()[1]) for p in parts) * FPS
print(f"{len(parts)} parts, {N} sightings", flush=True)

# feet on the court, in metres (X across 0-10, Y along 0-20, net at 10)
fx, fy = (box[:, 0] + box[:, 2]) / 2, box[:, 3]
xl, xr = court.mL * fy + court.bL, court.mR * fy + court.bR
wid = np.maximum(1.0, xr - xl)
P = np.stack([10.0 * (fx - xl) / wid,
              10.0 * (court.s_top - 1.0 / wid) / (court.s_top - court.s_bot) / court.v_net], 1)

# ── step 1: pieces ──────────────────────────────────────────────────────────
VMAX, SLACK, AMBIG, MAXMISS = 8.0, 0.5, 0.5, 2   # m/s, m, m, frames
by_frame = defaultdict(list)
for i, f in enumerate(frame):
    by_frame[f].append(i)
pieces, active = [], []          # active: [piece id, last sighting, last frame]
for f in sorted(by_frame):
    cur = by_frame[f]
    active = [t for t in active if f - t[2] <= MAXMISS + 1]
    touch = set()
    for p_ in range(len(cur)):
        for q_ in range(p_ + 1, len(cur)):
            if tp._iou(box[cur[p_]], box[cur[q_]]) > 0.15:
                touch.update((p_, q_))
    link, closed = {}, set()
    if active and cur:
        C = np.full((len(active), len(cur)), 1e6)
        for r, (_, li, lf) in enumerate(active):
            d = np.hypot(*(P[cur] - P[li]).T)
            C[r] = np.where(d <= SLACK + VMAX * (f - lf) / FPS, d, 1e6)
        for r, c in zip(*linear_sum_assignment(C)):
            if C[r, c] >= 1e6:
                continue
            others = np.r_[np.delete(C[r], c), np.delete(C[:, c], r)]
            if c in touch or (others < C[r, c] + AMBIG).any():
                closed.add(r)          # could be either person: end it here
                continue
            link[c] = r
    for c, i in enumerate(cur):
        if c in link:
            t = active[link[c]]
            pieces[t[0]].append(i)
            t[1], t[2] = i, f
        else:
            pieces.append([i])
            active.append([len(pieces) - 1, i, f])
    active = [t for r, t in enumerate(active) if r not in closed]
NP = len(pieces)
piece_of = np.empty(N, np.int64)
for k, p in enumerate(pieces):
    piece_of[p] = k
np.save(os.path.join(a.out_dir, "piece_of.npy"), piece_of)
p_start = np.array([frame[p[0]] for p in pieces])
p_end = np.array([frame[p[-1]] for p in pieces])
p_len = np.array([len(p) for p in pieces])
print(f"step 1: {NP} pieces; half of all sightings are in pieces of "
      f"{np.median(np.repeat(p_len, p_len)) / FPS:.0f}+ s", flush=True)

# ── looks per piece (sums; a merge just adds them) ──────────────────────────
c_col = np.zeros((NP, look_c.shape[1]))
c_mod = np.zeros((NP, look_m.shape[1]))
c_ok = np.zeros(NP)
np.add.at(c_col, piece_of[look_ok], look_c[look_ok])
np.add.at(c_mod, piece_of[look_ok], look_m[look_ok])
np.add.at(c_ok, piece_of[look_ok], 1)


def raw_dist(A, B):
    if c_ok[A] == 0 or c_ok[B] == 0:
        return None
    nc = np.linalg.norm(c_col[A]) * np.linalg.norm(c_col[B])
    nm = np.linalg.norm(c_mod[A]) * np.linalg.norm(c_mod[B])
    return 1 - c_col[A] @ c_col[B] / nc, 1 - c_mod[A] @ c_mod[B] / nm


BUCKET = int(10 * FPS)
buckets = defaultdict(list)
for k in range(NP):
    for b in range(int(p_start[k]) // BUCKET, int(p_end[k]) // BUCKET + 1):
        buckets[b].append(k)


def on_court_near(f0, f1):
    """Pieces on court at some point between frames f0 and f1."""
    seen = set()
    for b in range(int(f0) // BUCKET, int(f1) // BUCKET + 1):
        seen.update(k for k in buckets.get(b, ()) if p_start[k] <= f1 and p_end[k] >= f0)
    return sorted(seen)


# The line between "same" and "different", from this video: pieces on court
# at the same moment are certainly different people.
MINLOOK = a.min_look_s * FPS
conc = []
for k in range(NP):
    if c_ok[k] < 25:
        continue
    for j in on_court_near(p_start[k], p_end[k]):
        if j > k and c_ok[j] >= 25:
            conc.append(raw_dist(k, j))
conc = np.array(conc)
if len(conc) < 20:
    sys.exit(f"only {len(conc)} pairs of people on court together: too little to set the line")
SC, SM = np.median(conc[:, 0]), np.median(conc[:, 1])
comb_conc = conc[:, 0] / SC + conc[:, 1] / SM          # a typical pair of different people scores 2
LINE = float(np.percentile(comb_conc, a.strict_pct))
print(f"same-person line {LINE:.2f} (from {len(conc)} pairs of people on court together; "
      f"typical different pair = 2.0)", flush=True)


def cdist(A, B):
    r = raw_dist(A, B)
    return 9.0 if r is None else r[0] / SC + r[1] / SM


# ── step 2: persons ─────────────────────────────────────────────────────────
parent = list(range(NP))
c_spans = {k: [(int(p_start[k]), int(p_end[k]))] for k in range(NP)}
c_ver = [0] * NP


def find(x):
    while parent[x] != x:
        parent[x] = parent[parent[x]]
        x = parent[x]
    return x


def overlaps(A, B):
    sa, sb = c_spans[A], c_spans[B]
    i = j = 0
    while i < len(sa) and j < len(sb):
        if sa[i][0] <= sb[j][1] and sb[j][0] <= sa[i][1]:
            return True
        if sa[i][1] < sb[j][1]:
            i += 1
        else:
            j += 1
    return False


def merge(A, B):
    parent[B] = A
    c_col[A] += c_col[B]
    c_mod[A] += c_mod[B]
    c_ok[A] += c_ok[B]
    s = sorted(c_spans[A] + c_spans.pop(B))
    m = [list(s[0])]
    for lo, hi in s[1:]:
        if lo <= m[-1][1] + 1:
            m[-1][1] = max(m[-1][1], hi)
        else:
            m.append([lo, hi])
    c_spans[A] = [tuple(x) for x in m]
    c_ver[A] += 1


# candidate joins: piece k ends, piece j starts later (within the gap limit)
order = np.argsort(p_start)
starts_sorted = p_start[order]
MAXGAP = int(a.max_gap_min * 60 * FPS)
WIN = int(30 * FPS)
cand = []
for k in range(NP):
    lo = np.searchsorted(starts_sorted, p_end[k] + 1, side="left")
    hi = np.searchsorted(starts_sorted, p_end[k] + MAXGAP, side="right")
    for j in order[lo:hi]:
        j = int(j)
        gap_s = (p_start[j] - p_end[k]) / FPS
        jump = float(np.hypot(*(P[pieces[j][0]] - P[pieces[k][-1]])))
        near = gap_s <= 2.0 and jump <= 1.0 + 6.0 * gap_s
        if near or (c_ok[j] >= 5 and c_ok[k] >= 5):
            cand.append((k, j, gap_s, near))

joined = 0
for rnd in range(6):
    before, refused_far, refused_unsure, too_little = joined, 0, 0, 0
    heap = []
    for k, j, gap_s, near in cand:
        A, B = find(k), find(j)
        if A != B:
            # moment-later close-by continuations first, then by how alike they look
            heapq.heappush(heap, (0 if near else 1, cdist(A, B) + 0.002 * gap_s, k, j, c_ver[A], c_ver[B]))
    while heap:
        tier, cost, k, j, vk, vj = heapq.heappop(heap)
        A, B = find(k), find(j)
        if A == B or overlaps(A, B):
            continue
        if (vk, vj) != (c_ver[A], c_ver[B]):  # one side grew since: re-score with its full look
            heapq.heappush(heap, (tier, cdist(A, B) + 0.002 * (p_start[j] - p_end[k]) / FPS,
                                  k, j, c_ver[A], c_ver[B]))
            continue
        if tier == 1 and min(c_ok[A], c_ok[B]) < MINLOOK:
            too_little += 1
            continue
        d = cdist(A, B)
        if d > (LINE * a.near_factor if tier == 0 else LINE):
            refused_far += 1
            continue
        # Someone else who could be the right answer instead -> unsure, keep apart.
        # "Someone else" must provably be another person: on court at the same
        # moment as B (so not B) yet free to be A's continuation, or on court
        # with A (so not A) yet free to be B's past. Other fragments of A or B
        # are not rivals: counting them refused nearly every join (453 numbers
        # for the first 30 minutes of the 23 Oct final).
        rivals = set()
        for x in on_court_near(p_start[j], p_start[j] + WIN):
            X_ = find(x)
            if X_ not in (A, B) and overlaps(B, X_) and not overlaps(A, X_):
                rivals.add(cdist(A, X_))
        for x in on_court_near(p_end[k] - WIN, p_end[k]):
            X_ = find(x)
            if X_ not in (A, B) and overlaps(A, X_) and not overlaps(B, X_):
                rivals.add(cdist(X_, B))
        if min(rivals or [99.0]) < d + (a.margin if tier == 1 else a.margin / 2):
            refused_unsure += 1
            continue
        merge(A, B)
        joined += 1
    print(f"  round {rnd + 1}: {joined - before} joins", flush=True)
    if joined == before:
        break

roots = sorted({find(k) for k in range(NP)})
print(f"step 2: {joined} joins -> {len(roots)} numbers", flush=True)


# ── stats per piece, in a form that adds up ─────────────────────────────────
def piece_stats(p):
    f0, f1 = frame[p[0]], frame[p[-1]]
    n = int(f1 - f0 + 1)
    track = [None] * n
    for i in p:
        track[frame[i] - f0] = {"foot": (fx[i], fy[i]), "solid": True}
    # far end = feet above the net line in the picture (the camera looks down the court from the near end)
    out = {"on_s": round(n / FPS, 1), "seen": len(p), "far": int((fy[p] < court.y_net).sum())}
    m = ps.metric_track(track, court, FPS) if len(p) >= 2 else None
    if m is None:
        return out
    Xm, Ym, solid, s0, s1 = m
    st = ps.player_stats(Xm, Ym, solid, (s0, s1), FPS)
    XF, YF = ps.own_side(Xm[s0:s1 + 1], Ym[s0:s1 + 1], FPS)
    sol = solid[s0:s1 + 1]
    Xs, Ys = XF[sol], YF[sol]
    gx = np.clip(Xs.astype(int), 0, 9)                 # 1 m squares on the player's own half
    gy = np.clip((Ys - 10).astype(int), 0, 9)
    cells = np.bincount(gy * 10 + gx, minlength=100)
    out.update({
        "dist_m": st["distance_m"], "lat_m": st["lateral_distance_m"], "sprints": st["sprints"],
        "top_ms": st["top_speed_ms"], "mean_ms": st["mean_speed_ms"],
        "net_s": st["time_at_net_s"], "back_s": st["time_at_back_s"],
        "n": int(sol.sum()), "sx": round(float(Xs.sum()), 1), "sy": round(float((Ys - 10).sum()), 1),
        "left": int((Xs < 5).sum()), "cells": {str(c): int(v) for c, v in enumerate(cells) if v},
    })
    return out


pstats = [piece_stats(p) for p in pieces]


def pick_pictures(members, n=8):
    """A few pictures spread over the number's time on court, the clearest of each stretch."""
    dets = sorted((i for k in members for i in pieces[k]), key=lambda i: frame[i])
    out, chunk = [], max(1, len(dets) // n)
    for s in range(0, len(dets), chunk):
        grp = dets[s:s + chunk]
        out.append(max(grp, key=lambda i: (box[i][3] - box[i][1]) * conf[i]))
    return out[:n]


members_of = defaultdict(list)
for k in range(NP):
    members_of[find(k)].append(k)
persons = []
for r in roots:
    members = sorted(members_of[r], key=lambda k: p_start[k])
    persons.append({"members": members, "on_s": sum(pstats[k]["on_s"] for k in members),
                    "start": int(p_start[members[0]]), "end": int(p_end[members[-1]])})
persons.sort(key=lambda q: q["start"])

for n, q in enumerate(persons, 1):
    q["id"] = n

out = {
    "fps": FPS, "frames_done": int(last_frame), "line": round(LINE, 3), "scales": [float(SC), float(SM)],
    "settings": {"max_gap_min": a.max_gap_min, "strict_pct": a.strict_pct, "margin": a.margin,
                 "min_look_s": a.min_look_s},
    "pieces": [{"id": k, "start": int(p_start[k]), "end": int(p_end[k]), **pstats[k]} for k in range(NP)],
    "persons": [{"id": q["id"], "pieces": q["members"], "on_s": round(q["on_s"], 1), "start": q["start"],
                 "end": q["end"], "pictures": [[int(src[i]), int(off[i]), int(ln[i]), int(frame[i])]
                                               for i in pick_pictures(q["members"])]}
                for q in persons],
    "parts": parts,
}
json.dump(out, open(os.path.join(a.out_dir, "people.json"), "w"))
pid = {k: q["id"] for q in persons for k in q["members"]}
with open(os.path.join(a.out_dir, "pieces.csv"), "w") as fo:
    fo.write("piece,person,start_s,end_s,sightings\n")
    for k in range(NP):
        fo.write(f"{k},{pid[k]},{p_start[k] / FPS:.1f},{p_end[k] / FPS:.1f},{p_len[k]}\n")

# ── report ──────────────────────────────────────────────────────────────────
on = np.array([q["on_s"] for q in persons])
total = on.sum()
lines = [f"{N} sightings -> {NP} pieces -> {len(persons)} person numbers ({joined} joins)",
         f"last round refused: looks too different {refused_far}, someone else nearly as alike {refused_unsure}, "
         f"too little seen to judge by look {too_little}",
         f"same-person line {LINE:.2f} (typical pair of different people = 2.0)"]
for lim in (60, 300, 900):
    sel = on >= lim
    lines.append(f"numbers on court {lim // 60}+ min: {sel.sum()} (they hold "
                 f"{100 * on[sel].sum() / max(total, 1):.0f}% of all on-court time)")
txt = "\n".join(lines)
print(txt)
open(os.path.join(a.out_dir, "group-report.txt"), "w").write(txt + "\n")
