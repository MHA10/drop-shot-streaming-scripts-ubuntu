#!/usr/bin/env python3
"""Suggest which person numbers are probably the same player, for the review page to show side by side.

usage: suggest_groups.py <group_dir> --court=... [--min-s 20] [--pct 5]

Reads people.json, piece_of.npy, tags.json and the parts' dets.csv, looks.npz and crops.idx; writes
<group_dir>/suggest.json: [{"ids": [310, 373, ...], "links": [[a, b, score, why], ...]}, ...]
<group_dir>/flags.json: {"2091": [{"t": seconds, "half": "near", "before": [pictures], "after": [...]}, ...]}
  = cards that stayed on one half through a change of ends: two people, or not a player.

These are SUGGESTIONS for a person to confirm, not joins: the automatic
joining (group_people.py) stays strict, this is allowed to be looser.

  - Each number gets two looks: one from its sightings on the near half (the
    camera's side of the net) and one from the far half. A player seen from
    the far half (small, from the front) and from the near half (bigger, from
    the back) looks very different to the computer: red #7 on the 23 Oct
    final scored 1.03 against himself across halves, where two different
    people typically score 2.0, but 0.04 against himself on the same half.
    So looks are compared half to half where possible.
  - Each kind of comparison (same half / across halves) gets its own line,
    set from this video: the --pct percentile of pairs of numbers that were
    on court at the same moment (certainly different people).
  - Change of ends: when a number on one half stops and a number on the other
    half starts within 2 minutes, that's the pattern of a player changing
    ends, and it counts in favour (score x0.8).
  - Took turns: a near-half and a far-half number that hand over to each
    other (one stops, the other starts on the other half within 2 minutes),
    and play the same side (left or right), are joined after the grouping by
    look. See "Took turns" below.
  - Stayed put: a card seen on the same half just before and just after a
    change of ends is flagged (flags.json) and kept out of every group. See
    "Two people on one card" below.
  - Two numbers on court at the same moment are never suggested together, and
    every two cards in a group must be a believable match on their own
    (look score under 1.3, shirt colour mix differing by 0.4 or less, not one
    clearly dark-haired and the other clearly in a white cap or shaved), not
    only the group as a whole.
  - Side played: a card that clearly plays the left side (65%+ of its time, on
    the player's own half) is never grouped with one that clearly plays the
    right. Partners split left and right and keep their side all match; on the
    23 Oct final this split boxes that mixed squad-mates in the same kit (the
    "DAR" white shirt, right side, with a bearded white shirt, left side).
    Turn it off with --no-side to see the groups without it.
"""
import argparse, csv, json, os

import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("group_dir")
ap.add_argument("--court", required=True)
ap.add_argument("--min-s", type=float, default=20.0)
ap.add_argument("--pct", type=float, default=5.0)
ap.add_argument("--no-side", action="store_true", help="allow cards that clearly play opposite sides in one group")
ap.add_argument("--across", choices=["loose", "strict"], default="loose",
                help="near-half card against far-half card in a group that can also be compared half to half")
a = ap.parse_args()
Y_NET = float(a.court.split(",")[6])

P = json.load(open(os.path.join(a.group_dir, "people.json")))
FPS = P["fps"]
piece_of = np.load(os.path.join(a.group_dir, "piece_of.npy"))
foot_y, frame_of, crop_at, lc, lm, ok = [], [], [], [], [], []
for n, p in enumerate(P["parts"]):
    for r in csv.DictReader(open(os.path.join(p, "dets.csv"))):
        foot_y.append(float(r["y2"]))
        frame_of.append(int(r["frame"]))
    crop_at += [(n, int(o), int(ln)) for o, ln in np.fromfile(os.path.join(p, "crops.idx"), np.int64).reshape(-1, 2)]
    lk = np.load(os.path.join(p, "looks.npz"))
    lc.append(lk["colour"].astype(np.float32))
    lm.append(lk["model"].astype(np.float32))
    ok.append(lk["ok"])
foot_y, frame_of = np.array(foot_y), np.array(frame_of)
lc, lm, ok = np.concatenate(lc), np.concatenate(lm), np.concatenate(ok)
far = foot_y < Y_NET
SC, SM = P["scales"]
pieces = {p["id"]: p for p in P["pieces"]}

nums = [q for q in P["persons"] if q["on_s"] >= a.min_s]
person_of_piece = {k: q["id"] for q in nums for k in q["pieces"]}
pp = np.array([person_of_piece.get(int(k), -1) for k in piece_of])

# Per number and half: summed looks and how many sightings, so a group's look
# is just the sum of its members'.
sums, spans, half, first, last = {}, {}, {}, {}, {}
for q in nums:
    i = q["id"]
    d = np.where((pp == i) & ok)[0]
    sums[i] = {"n": len(d)}
    for name, sel in (("near", ~far[d]), ("far", far[d])):
        sd = d[sel]
        sums[i][name] = (lc[sd].sum(0), lm[sd].sum(0), len(sd))
    spans[i] = sorted((pieces[k]["start"], pieces[k]["end"]) for k in q["pieces"])
    f = np.mean(far[pp == i])
    half[i] = "far" if f >= 0.9 else "near" if f <= 0.1 else "both"
    first[i], last[i] = q["start"], q["end"]


def overlap(x, y):
    i = j = 0
    sx, sy = spans[x], spans[y]
    while i < len(sx) and j < len(sy):
        if sx[i][0] <= sy[j][1] and sy[j][0] <= sx[i][1]:
            return True
        if sx[i][1] < sy[j][1]:
            i += 1
        else:
            j += 1
    return False


def diff(u, v):
    return (1 - u[0] @ v[0]) / SC + (1 - u[1] @ v[1]) / SM


def looks_of(members):
    """A look per half, only for a half the group was really on: 25+ sightings and 20%+ of them.
    A far-half number with a few sightings walking past the net otherwise got a near-half look
    from those few, which then clashed with the player's real near-half look (red #7, 23 Oct)."""
    n = sum(sums[i]["n"] for i in members)
    out = {}
    for h in ("near", "far"):
        c = sum(sums[i][h][0] for i in members)
        m = sum(sums[i][h][1] for i in members)
        k = sum(sums[i][h][2] for i in members)
        if k >= 25 and k >= 0.2 * n:
            out[h] = (c / np.linalg.norm(c), m / np.linalg.norm(m))
    return out


def raw_looks(lx, ly):
    """(how different, kind): half against the same half when both have it, else across halves."""
    shared = [h for h in ("near", "far") if h in lx and h in ly]
    if shared:
        return float(np.mean([diff(lx[h], ly[h]) for h in shared])), "same half"
    if lx and ly:
        return float(np.mean([diff(u, v) for u in lx.values() for v in ly.values()])), "across halves"
    return None, None


looks = {i: looks_of([i]) for i in sums}


def raw(x, y):
    return raw_looks(looks[x], looks[y])


ids = [q["id"] for q in nums if looks[q["id"]]]
print(f"{len(ids)} of {len(nums)} numbers have enough sightings to compare")
# the lines: from pairs on court together (certainly different people), one per kind
conc = {"same half": [], "across halves": []}
for n, x in enumerate(ids):
    for y in ids[n + 1:]:
        if first[y] > last[x]:
            continue
        if overlap(x, y):
            d, kind = raw(x, y)
            if d is not None:
                conc[kind].append(d)
line = {k: float(np.percentile(v, a.pct)) for k, v in conc.items() if len(v) >= 20}
print("suggestion lines:", {k: round(v, 2) for k, v in line.items()},
      "from", {k: len(v) for k, v in conc.items()}, "pairs on court together")


def changed_ends(x, y):
    """One stops on one half and the other starts on the other half within 2 minutes."""
    a_, b_ = (x, y) if last[x] <= first[y] else (y, x)
    return half[a_] != half[b_] and "both" not in (half[a_], half[b_]) and 0 <= first[b_] - last[a_] <= 120 * FPS


def score_groups(gx, gy):
    """Below 1.0 = suggest. Relative to the line for that kind of comparison, on the groups' combined looks."""
    d, kind = raw_looks(looks_of(gx), looks_of(gy))
    if d is None or kind not in line:
        return None, None
    s = d / line[kind]
    why = kind
    if any(changed_ends(x, y) for x in gx for y in gy):
        s *= 0.8
        why += ", changed ends"
    return s, why


def score(x, y):
    return score_groups([x], [y])


# average-linkage grouping, never putting two numbers that were on court together in one group
groups = {i: [i] for i in ids}
pair = {}
for n, x in enumerate(ids):
    for y in ids[n + 1:]:
        if not overlap(x, y):
            s, why = score(x, y)
            if s is not None:
                pair[(x, y)] = pair[(y, x)] = (s, why)


def link(gx, gy):
    s, _ = score_groups(groups[gx], groups[gy])
    return 9.0 if s is None else s


PAIR_MAX = 1.3
LOOSE_WITH_SAME = a.across == "loose"
SIDE_VETO = not a.no_side


def clash(gx, gy, by_turns=False):
    """On court together, or any two cards that would not be a believable match on their own.
    Without the second test, a growing group's combined look drifted to a generic "dark clothes"
    look and chained 15 cards of several players (23 Oct final: SALEH, plain black shirts and
    black shirts with white caps in one suggestion).
    A near-half card against a far-half card only gets the loose colour test (MIX_TURNS) when
    the groups are being put together because they took turns, or can also be compared half to
    half (checked in full here): across the net the look score is near noise for dark clothes
    (a pair that took turns 4 times scored 1.84, about what two different people score)."""
    xs, ys = groups[gx], groups[gy]
    if SIDE_VETO and len({side_of(i) for i in xs + ys} - {None}) > 1:
        return True
    loose = by_turns or (LOOSE_WITH_SAME and any(half[x] == half[y] != "both" for x in xs for y in ys))
    for x in xs:
        for y in ys:
            if overlap(x, y):
                return True
            if loose and {half[x], half[y]} == {"near", "far"}:
                if colour_clash(x, y, MIX_TURNS):
                    return True
                continue
            s_, why = pair.get((x, y), (None, ""))
            if s_ is None or s_ > PAIR_MAX:
                return True
            if colour_clash(x, y):
                return True
    return False


# Shirt colour mix from tag_people.py (tags.json "why"): the shares of each colour family,
# compared by adding up the differences. Far half against near half is the weak look
# comparison; without this, SALEH (black-and-white shirt, 32% white, near half) joined a group of
# plain black far-half shirts (9-14% white) on the 23 Oct final. Measured there: SALEH against
# those shirts 0.45-0.50; red #7 against himself across halves ~0.2. Line: 0.4.
MIX_MAX = 0.4
# Players who took turns across the net: the same navy shirt reads plain dark from the far half
# and dark plus blue from the near half (P3925 / P4076 and P3934 / P4080: 0.45 each), so those
# pairs only need to stay under 0.6. SALEH against plain black shirts was 0.45-0.50, so with this
# looser line the turn-taking and the side played are what keep different people apart.
MIX_TURNS = 0.6
TAGS = json.load(open(os.path.join(a.group_dir, "tags.json"))) if os.path.exists(os.path.join(a.group_dir, "tags.json")) else {}


def colour_clash(x, y, limit=MIX_MAX):
    sx = TAGS.get(str(x), {}).get("why", {}).get("shirt") or {}
    sy = TAGS.get(str(y), {}).get("why", {}).get("shirt") or {}
    if not sx or not sy:
        return False
    if sum(abs(sx.get(f, 0) - sy.get(f, 0)) for f in set(sx) | set(sy)) > limit:
        return True
    return cap_clash(x, y)


def cap_state(i):
    """'cap' = clearly a white cap (half or more of the non-skin top of the head is white);
    'none' = clearly dark hair, no cap (no white among the top colours, 40%+ dark);
    'bare' = no dark at all on top, three quarters or more skin, cream or white: a shaved head
    (or a white cap reading cream at the far half); else unknown.
    At the far half a white cap under warm light reads cream ('yellow'), so it can't count as 'cap'."""
    h = TAGS.get(str(i), {}).get("why", {}).get("head") or {}
    if not h:
        return None
    white = h.get("white", 0) / max(1e-6, 1 - h.get("skin", 0))
    dark = sum(h.get(k, 0) for k in ("navy", "dark grey", "black"))
    if white >= 0.5:
        return "cap"
    if "white" not in h and dark >= 0.4:
        return "none"
    if dark < 0.05 and sum(h.get(k, 0) for k in ("skin", "yellow", "white", "orange")) >= 0.75:
        return "bare"
    return None


def cap_clash(x, y):
    """One clearly dark-haired, the other clearly in a white cap or shaved: two players.
    23 Oct final: a black shirt with a 'Z' print and no cap was suggested with a white-cap black
    shirt with a red print; a shaved-headed player in white (P2240, near: 0% dark on top) with a
    dark-haired, bearded one in white (P2 / P2624 / P4988, near: 44-74% dark), both on the left."""
    s = {cap_state(x), cap_state(y)}
    return "none" in s and bool(s & {"cap", "bare"})


# ── Took turns: the change of ends ──
# In matches where the teams swap halves every few games, a player's near-half number stops and
# seconds later the same player's far-half number starts, and back again at the next swap. The
# timing says which TEAM moved; the side each plays tells the two partners apart. Padel players
# keep their own left or right side all match, and left/right here is measured from the player's
# own end (player_stats.own_side), so it doesn't flip when they change ends. 23 Oct final,
# 3:17-3:39: P3925 (far, left 96%) and P4076 (near, left 88%) took turns 3 times, their partners
# P3934 (right, 14% left) and P4080 (right, 4%) 4 times; timing alone also paired P3934 with
# P4076, 4 times, and only the side ruled that out.
# A stint = a number's pieces joined across gaps of up to 30 s, kept if 1 min+ (two games on one
# half never take less). A handover = a stint on one half ending and a stint on the other half
# starting -10 s to +2 min later (padel allows 90 s at a change of ends). Each stint end and each
# stint start is used for one handover at most, the closest in time first, so a team of two can't
# both be handed to one partner. Handovers of one pair under 2.5 min apart count once: ends change
# every two games (the closest two in this final were 3 min 8 s apart). Without these two rules,
# a 21 s appearance (P579) "took turns" 3 times in 4 minutes with P374 when everyone briefly
# dropped out at 0:36 and came back on the same half.
# Taking turns 2+ times is enough with the same side and the loose colour test. A single
# handover can also be a player leaving after a match and a new one arriving on the other half,
# so it must pass the full look and colour tests as well.
STINT_GAP_S, STINT_MIN_S, TURN_WIN_S, TURN_APART_S, SIDE_CUT = 30, 60, 120, 150, 0.35
own_left, stints = {}, []
for q in nums:
    i = q["id"]
    ps = sorted((pieces[k] for k in q["pieces"]), key=lambda p: p["start"])
    n_ = sum(p.get("n", 0) for p in ps)
    own_left[i] = sum(p.get("left", 0) for p in ps) / n_ if n_ else None
    run = []
    for p in ps + [None]:
        if p is not None and run and p["start"] - run[-1]["end"] <= STINT_GAP_S * FPS:
            run.append(p)
            continue
        if run:
            f = sum(r["far"] for r in run) / sum(r["seen"] for r in run)
            if run[-1]["end"] - run[0]["start"] >= STINT_MIN_S * FPS and (f >= 0.9 or f <= 0.1):
                stints.append((i, run[0]["start"], run[-1]["end"], f >= 0.9))
        run = [p] if p is not None else []


def side_of(i):
    """'left' / 'right' when a number clearly plays one side (65%+ of its time), else None."""
    v = own_left.get(i)
    return None if v is None else "left" if v >= 1 - SIDE_CUT else "right" if v <= SIDE_CUT else None


cand = []
for ei, (x, _, e, fx) in enumerate(stints):
    for si, (y, s, _, fy) in enumerate(stints):
        if fx == fy or x == y or not -10 * FPS <= s - e <= TURN_WIN_S * FPS:
            continue
        if side_of(x) is None or side_of(x) != side_of(y) or (x, y) not in pair:   # pair: never on court together
            continue
        if colour_clash(x, y, MIX_TURNS):
            continue
        cand.append((abs(s - e), ei, si, x, y, e))
used_e, used_s, turns, handovers = set(), set(), {}, []
for _, ei, si, x, y, e in sorted(cand):
    if ei in used_e or si in used_s:
        continue
    used_e.add(ei)
    used_s.add(si)
    handovers.append((min(x, y), max(x, y), e, stints[si][1]))
    ts = turns.setdefault((min(x, y), max(x, y)), [])
    if not any(abs(e - t) < TURN_APART_S * FPS for t in ts):
        ts.append(e)
for ts in turns.values():
    ts.sort()
turns = {k: ts for k, ts in turns.items()
         if len(ts) >= 2 or (pair[k][0] <= PAIR_MAX and not colour_clash(*k))}
print(f"took turns: {len(turns)} near/far pairs, {sum(len(t) > 1 for t in turns.values())} of them 2+ times")


def hm(f):
    s = int(f / FPS)
    return f"{s // 3600}:{s // 60 % 60:02d}"


# ── Two people on one card: stayed put through a change of ends ──
# At a change of ends all four players cross to the other half. So a card seen on the same half
# just before and just after one is either two people (a player who left and the one who took
# their place, joined because they look alike) or someone who isn't playing. 23 Oct final: P2091
# (navy, white cap, near-right) stayed on the near half through the swaps at 2:01 and 2:04 while
# its partner moved: two right-side players in dark clothes and white caps, one card.
# A change of ends = 2+ pairs that took turns 2+ times handing over within 90 s. Pairs that took
# turns once don't count: a few minutes into some matches two players move to the other half
# for good while the other two stay (red #7 at 0:24 and 2:19), and those two would be flagged.
# Before = the 2 min up to 10 s before the first player leaves; after = the 2 min from 10 s after
# the last one arrives; 5 s+ of sightings (25 at 5 a second) on the same half in each.
SWAP_GAP_S, SWAP_WIN_S, SWAP_PAD_S, SWAP_SEEN = 90, 120, 10, 25
strong = {k for k, ts in turns.items() if len(ts) >= 2}
swaps = []
for x, y, e, s_ in sorted((h for h in handovers if h[:2] in strong), key=lambda h: h[2]):
    if swaps and e - swaps[-1]["t1"] <= SWAP_GAP_S * FPS:
        sw = swaps[-1]
        sw["t1"] = max(sw["t1"], s_)
        sw["pairs"].add((x, y))
    else:
        swaps.append({"t0": e, "t1": s_, "pairs": {(x, y)}})
swaps = [sw for sw in swaps if len(sw["pairs"]) >= 2]
seen_by = {i: np.where(pp == i)[0] for i in sums}
flags = {}
for sw in swaps:
    moving = {i for k in sw["pairs"] for i in k}
    lo0, hi0 = sw["t0"] - SWAP_WIN_S * FPS, sw["t0"] - SWAP_PAD_S * FPS
    lo1, hi1 = sw["t1"] + SWAP_PAD_S * FPS, sw["t1"] + SWAP_WIN_S * FPS
    for i, d in seen_by.items():
        if i in moving:
            continue
        f = frame_of[d]
        b, a_ = d[(f >= lo0) & (f <= hi0)], d[(f >= lo1) & (f <= hi1)]
        for name, h in (("far", far), ("near", ~far)):
            if h[b].sum() >= SWAP_SEEN and h[a_].sum() >= SWAP_SEEN:
                # 3 pictures either side, so whoever checks can compare the two people at a glance
                pics = lambda k: [[*crop_at[j], int(frame_of[j])] for j in k[np.linspace(0, len(k) - 1, 3).astype(int)]]
                flags.setdefault(i, []).append({"t": round(sw["t0"] / FPS), "half": name,
                                                "before": pics(b[h[b]]), "after": pics(a_[h[a_]])})
print(f"changes of ends: {len(swaps)} ({', '.join(hm(sw['t0']) for sw in swaps)}); "
      f"cards that stayed put through one: {len(flags)}")
json.dump({str(i): v for i, v in flags.items()}, open(os.path.join(a.group_dir, "flags.json"), "w"))
# A flagged card holds two people (or isn't a player), so it's kept out of every suggestion:
# boxed with others, "Same person: all" would pour a second player's stats into theirs.
for i in flags:
    groups.pop(i, None)


while True:
    best = None
    keys = list(groups)
    for n, gx in enumerate(keys):
        for gy in keys[n + 1:]:
            if not any((x, y) in pair for x in groups[gx] for y in groups[gy]):
                continue
            s = link(gx, gy)
            if s < 1.0 and (best is None or s < best[0]) and not clash(gx, gy):
                best = (s, gx, gy)
    if best is None:
        break
    _, gx, gy = best
    groups[gx] += groups.pop(gy)

# Then two groups holding a pair that took turns are joined, most turns first. Done after the
# grouping by look, not before: put first, a group holding a near-half and a far-half card
# failed the every-two-cards look test against later cards, and the 23 Oct final ended with
# more suggestions to check (65) than without any pairing (61). Refused on the same tests as
# any group (see clash), the near/far pair itself only needing the loose colour test.
for (x, y), ts in sorted(turns.items(), key=lambda kv: (-len(kv[1]), pair[kv[0]][0])):
    if x in flags or y in flags:
        continue
    gx = next(g for g, m in groups.items() if x in m)
    gy = next(g for g, m in groups.items() if y in m)
    if gx != gy and not clash(gx, gy, by_turns=True):
        groups[gx] += groups.pop(gy)

out = []
for g in groups.values():
    if len(g) < 2:
        continue
    g = sorted(g, key=lambda i: first[i])
    links = []
    for n, x in enumerate(g):
        for y in g[n + 1:]:
            ts = turns.get((min(x, y), max(x, y)))
            if (x, y) not in pair or (pair[(x, y)][0] >= 1.0 and not ts):
                continue
            link_ = [x, y, round(pair[(x, y)][0], 2), pair[(x, y)][1]]
            if ts:
                link_[3] += f", took turns {len(ts)}x ({', '.join(hm(t) for t in ts)}), both play the {side_of(x)} side"
                link_.append({"turns": [round(t / FPS) for t in ts], "side": side_of(x)})
            links.append(link_)
    out.append({"ids": g, "links": links})
out.sort(key=lambda gr: first[gr["ids"][0]])
json.dump(out, open(os.path.join(a.group_dir, "suggest.json"), "w"))
inside = sum(len(gr["ids"]) for gr in out)
print(f"{len(out)} suggested groups covering {inside} of {len(ids)} numbers")
for gr in out[:40]:
    print("  " + " + ".join(f"P{i}({half[i][0]})" for i in gr["ids"]))
print("took turns (near/far pairs):")
for (x, y), ts in sorted(turns.items(), key=lambda kv: kv[1][0]):
    together = any(x in gr["ids"] and y in gr["ids"] for gr in out)
    print(f"  P{x} + P{y}: {len(ts)}x at {', '.join(hm(t) for t in ts)}, {side_of(x)} side, "
          f"look {pair[(x, y)][0]:.2f}{'' if together else '  (not grouped: clashes with another card in the group)'}")
print("stayed put through a change of ends (two people, or not a player):")
for i, v in sorted(flags.items(), key=lambda kv: kv[1][0]["t"]):
    print(f"  P{i}: {', '.join(hm(x['t'] * FPS) + ' ' + x['half'] for x in v)}")
