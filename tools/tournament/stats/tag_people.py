#!/usr/bin/env python3
"""Describe each person number in words a player would use: shirt, shorts, cap, name or number on the shirt.

usage: tag_people.py <group_dir> <video> <median_png> --poly=... [--min-min 1] [--views 16]

Reads <group_dir>/people.json and piece_of.npy, writes <group_dir>/tags.json:
  {"<id>": {"tags": ["red shirt", "navy shorts", "white cap", "SALEH on shirt"], "why": {...}}}

  - Colours: every pixel of the person (the empty-court background picture is
    subtracted first) in the chest band and the shorts band, across up to 60
    sightings, named one by one (red, navy, white ...). Skin-coloured pixels
    are left out. The top name wins; a second name joins it ("black and white
    shirt") when it has at least 25% of the pixels.
  - Cap: the top of the head is mostly white, or mostly one strong colour.
    A dark cap can't be told from dark hair, so it is never claimed.
  - Text on the shirt: the Mac's own text reader (Apple Vision, read_text.swift)
    on sharp full-size back views cut from the video (near half of the court,
    where players have their backs to the camera). A word counts only when it
    is read the same (one letter of slack) in 2+ different views. Tested on the
    23 Oct final: it reads printed names sometimes ("SALEH" in 2-3 of 10 views)
    and single kit numbers never, so a missing number means nothing.
"""
import argparse, csv, json, os, subprocess, sys
from collections import Counter

import cv2
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("group_dir")
ap.add_argument("video")
ap.add_argument("median_png")
ap.add_argument("--poly", required=True)
ap.add_argument("--min-min", type=float, default=1.0)
ap.add_argument("--views", type=int, default=16)
ap.add_argument("--no-text", action="store_true", help="skip reading text on shirts (needs the Mac's text reader)")
a = ap.parse_args()
HERE = os.path.dirname(os.path.abspath(__file__))

P = json.load(open(os.path.join(a.group_dir, "people.json")))
piece_of = np.load(os.path.join(a.group_dir, "piece_of.npy"))
FPS = P["fps"]
frame, box, src, off, ln = [], [], [], [], []
for k, p in enumerate(P["parts"]):
    idx = np.fromfile(os.path.join(p, "crops.idx"), np.int64).reshape(-1, 2)
    for r, (o, n) in zip(csv.DictReader(open(os.path.join(p, "dets.csv"))), idx):
        frame.append(int(r["frame"]))
        box.append([float(r[c]) for c in ("x1", "y1", "x2", "y2")])
        src.append(k)
        off.append(int(o))
        ln.append(int(n))
frame, box = np.array(frame), np.array(box)
assert len(frame) == len(piece_of)
blobs = [np.memmap(os.path.join(p, "crops.bin"), np.uint8, "r") for p in P["parts"]]

med = cv2.imread(a.median_png)
H, W = med.shape[:2]
poly = np.array([[float(v) for v in p.split(",")] for p in a.poly.split(";")], np.float32)
x0 = max(0, int(poly[:, 0].min()) - 40) & ~1
x1 = min(W, int(poly[:, 0].max()) + 40) & ~1
y0 = max(0, int(poly[:, 1].min()) - 120) & ~1
y1 = min(H, int(poly[:, 1].max()) + 20) & ~1
CW, CH = x1 - x0, y1 - y0
medc = med[y0:y1, x0:x1]


def crop_and_mask(i):
    im = cv2.imdecode(np.asarray(blobs[src[i]][off[i]:off[i] + ln[i]]), cv2.IMREAD_COLOR)
    bx1, by1, bx2, by2 = box[i]
    cx, cy = (bx1 + bx2) / 2 - x0, (by1 + by2) / 2 - y0
    h = (by2 - by1) * 1.12
    w = h / 2
    xa, xb = int(max(0, cx - w / 2)), int(min(CW, cx + w / 2))
    ya, yb = int(max(0, cy - h / 2)), int(min(CH, cy + h / 2))
    if xb - xa < 4 or yb - ya < 8:
        return im, np.zeros((160, 80), bool)
    bg = cv2.resize(medc[ya:yb, xa:xb], (80, 160), interpolation=cv2.INTER_AREA)
    fg = np.abs(im.astype(int) - bg.astype(int)).sum(2) > 60
    return im, cv2.morphologyEx(fg.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)).astype(bool)


def name_pixels(bgr):
    """A colour name for every pixel (OpenCV HSV: hue 0-179). 'skin' is dropped by the caller."""
    hsv = cv2.cvtColor(bgr.reshape(-1, 1, 3), cv2.COLOR_BGR2HSV).reshape(-1, 3).astype(int)
    h, s, v = hsv[:, 0], hsv[:, 1], hsv[:, 2]
    out = np.empty(len(h), object)
    grey = s < 50
    out[:] = "?"
    out[(v < 55)] = "black"
    g = grey & (v >= 55)
    out[g & (v > 185)] = "white"
    out[g & (v > 120) & (v <= 185)] = "light grey"
    out[g & (v <= 120)] = "dark grey"
    c = ~grey & (v >= 55)
    red = c & ((h < 8) | (h >= 170))
    out[red & (v < 110)] = "maroon"
    out[red & (v >= 110)] = "red"
    orange = c & (h >= 8) & (h < 22)
    out[orange & (s >= 170)] = "orange"
    out[orange & (s < 170)] = "skin"
    out[c & (h >= 22) & (h < 35)] = "yellow"
    out[c & (h >= 35) & (h < 85)] = "green"
    out[c & (h >= 85) & (h < 97)] = "teal"
    blue = c & (h >= 97) & (h < 130)
    out[blue & (v < 110)] = "navy"
    out[blue & (v >= 150) & (s < 120)] = "light blue"
    out[blue & (out == "?")] = "blue"
    out[c & (h >= 130) & (h < 150)] = "purple"
    out[c & (h >= 150) & (h < 170)] = "pink"
    return out


# Shades of one colour are counted together before naming, so a black-and-white
# shirt doesn't split into five small slices (black, navy, dark grey, white,
# light grey) that each miss the 25% bar (that left the "SALEH" shirt with no
# colour at all on the 23 Oct final).
FAMILY = {"black": "dark", "dark grey": "dark", "navy": "dark", "white": "light", "light grey": "light",
          "red": "red", "maroon": "red", "blue": "blue", "light blue": "blue"}


def family_shares(counter):
    total = sum(n for k, n in counter.items() if k not in ("skin", "?"))
    if total < 200:
        return {}
    fam = Counter()
    for k, n in counter.items():
        if k not in ("skin", "?"):
            fam[FAMILY.get(k, k)] += n / total
    return dict(fam.most_common())


def family_name(fam, counter):
    """The everyday name for a family, from the shades inside it."""
    inside = {k: n for k, n in counter.items() if FAMILY.get(k, k) == fam}
    tot = sum(inside.values()) or 1
    if fam == "dark":
        return "navy" if inside.get("navy", 0) / tot >= 0.5 else "black"
    if fam == "light":
        return "white" if inside.get("white", 0) / tot >= 0.4 else "grey"
    return max(inside, key=inside.get)


def colour_words(counter, avoid=None):
    """Up to two colour names with 25%+ each. `avoid`: the shirt's main family, used for the shorts:
    when the shorts band is mostly shirt (a long shirt, a bent player) and a clearly different
    colour has 20%+, that colour is the shorts."""
    sh = family_shares(counter)
    if not sh:
        return None, None, {}
    fams = [f for f, v in sh.items() if v >= 0.25][:2]
    if avoid and fams and fams[0] == avoid:
        other = [f for f, v in sh.items() if f != avoid and v >= 0.20]
        if other:
            fams = [other[0]]
    if not fams:
        return None, None, sh
    return " and ".join(family_name(f, counter) for f in fams), fams[0], {k: round(v, 2) for k, v in list(sh.items())[:4]}


def sightings(q):
    d = np.where(np.isin(piece_of, q["pieces"]))[0]
    return d[np.argsort(frame[d])]


persons = [q for q in P["persons"] if q["on_s"] >= a.min_min * 60]
tags, views = {}, []
for q in persons:
    d = sightings(q)
    pick = d[np.linspace(0, len(d) - 1, min(60, len(d))).astype(int)]
    shirt, shorts, head = Counter(), Counter(), Counter()
    for i in pick:
        im, fg = crop_and_mask(i)
        for (r0, r1), cnt in (((0.22, 0.46), shirt), ((0.54, 0.66), shorts), ((0.03, 0.12), head)):
            rows = slice(int(r0 * 160), int(r1 * 160))
            cols = slice(20, 60) if cnt is not head else slice(26, 54)   # middle: leave out the arms
            m = fg[rows, cols]
            if m.sum():
                cnt.update(name_pixels(im[rows, cols][m]))
    out, why = [], {}
    s_word, s_fam, why["shirt"] = colour_words(shirt)
    if s_word:
        out.append(f"{s_word} shirt")
    b_word, _, why["shorts"] = colour_words(shorts, avoid=s_fam)
    if b_word:
        out.append(f"{b_word} shorts")
    hd = {k: n for k, n in head.items() if k != "?"}
    tot = sum(hd.values())
    if tot >= 150:
        top, n = max(hd.items(), key=lambda kv: kv[1])
        # Only white or a strong colour. A dark cap looks like dark hair, and a
        # bald head under these lights reads yellow-orange (gave a bald player
        # in a yellow shirt a "yellow cap").
        not_skin = tot - hd.get("skin", 0)
        if not_skin and hd.get("white", 0) / not_skin >= 0.5:   # the face takes part of the band; 0.4 gave a bald head a cap
            out.append("white cap")
        elif top in ("red", "blue", "green", "pink", "purple", "orange") and n / tot >= 0.5:
            out.append(f"{top} cap")
        why["head"] = {k: round(v / tot, 2) for k, v in Counter(hd).most_common(3)}
    tags[str(q["id"])] = {"tags": out, "why": why}
    # back views for the text reader: near half (back to the camera), biggest boxes, spread over time
    near = d[box[d, 3] > 600]
    if len(near):
        big = near[np.argsort(-(box[near, 3] - box[near, 1]))[:max(40, a.views * 3)]]
        big = big[np.argsort(frame[big])]
        for i in big[np.linspace(0, len(big) - 1, min(a.views, len(big))).astype(int)]:
            views.append((frame[i], i, q["id"]))
print(f"colours named for {len(persons)} numbers; reading text on {len(views)} back views", flush=True)
if a.no_text:
    json.dump(tags, open(os.path.join(a.group_dir, "tags.json"), "w"), indent=1)
    print("text on shirts not read (--no-text)", flush=True)
    sys.exit(0)

# cut sharp back views from the video, in time order (reading forward is cheaper than seeking)
vdir = os.path.join(a.group_dir, "backviews")
os.makedirs(vdir, exist_ok=True)
cap = cv2.VideoCapture(a.video)
vid_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
pos, files, owner = -1, [], {}
for f, i, pid in sorted(views):
    target = int(round(f / FPS * vid_fps))
    if pos < 0 or target < pos or target - pos > 5 * vid_fps:
        cap.set(cv2.CAP_PROP_POS_FRAMES, target)
        pos = target
    while pos < target:
        cap.grab()
        pos += 1
    ok, img = cap.read()
    pos += 1
    if not ok:
        continue
    bx1, by1, bx2, by2 = box[i].astype(int)
    hh = by2 - by1
    c = img[max(0, by1 + int(.10 * hh)):by1 + int(.62 * hh), max(0, bx1 - 6):bx2 + 6]
    if c.size == 0:
        continue
    c = cv2.resize(c, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
    small = cv2.resize(c, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
    h_, w_ = small.shape[:2]
    pad = np.full((h_ * 3, w_ * 4, 3), 255, np.uint8)       # the reader does better with room around text
    pad[h_:2 * h_, int(1.5 * w_):int(1.5 * w_) + w_] = small
    for tag, im in (("a", c), ("b", pad)):
        p = os.path.join(vdir, f"p{pid}_{i}_{tag}.png")
        cv2.imwrite(p, im)
        files.append(p)
        owner[p] = (pid, i)
# Text printed on the court itself (adverts on the glass, e.g. "tapmad") gets
# read off the background behind a player; read it on the empty-court picture
# in overlapping tiles, so it can be ignored below.
bg_files = []
th, tw = 360, 480
for ty in range(0, H - th + 1, th // 2):
    for tx in range(0, W - tw + 1, tw // 2):
        p = os.path.join(vdir, f"bg_{ty}_{tx}.png")
        cv2.imwrite(p, cv2.resize(med[ty:ty + th, tx:tx + tw], None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC))
        bg_files.append(p)
lst = os.path.join(vdir, "list.txt")
open(lst, "w").write("\n".join(files + bg_files))
res = json.loads(subprocess.check_output(["swift", os.path.join(HERE, "read_text.swift"), lst]) or b"[]")


def close(x, y):
    """Same word with at most one letter different (the reader often drops or swaps one)."""
    if abs(len(x) - len(y)) > 1:
        return False
    if len(x) == len(y):
        return sum(p != q for p, q in zip(x, y)) <= 1
    s, l = (x, y) if len(x) < len(y) else (y, x)
    return any(l[:k] + l[k + 1:] == s for k in range(len(l)))


def clean(t):
    return "".join(ch for ch in t.upper() if ch.isalnum())


background = {clean(t["t"]) for r in res if r["f"] in bg_files for t in r["r"]}
background = {w for w in background if len(w) >= 3}
print("text on the court itself (ignored):", ", ".join(sorted(background)) or "-", flush=True)
reads = {}
for r in res:
    if r["f"] not in owner:
        continue
    pid, i = owner[r["f"]]
    for t in r["r"]:
        w = clean(t["t"])
        if any(w in b for b in background):   # MAD inside TAPMAD; but SAN must not remove HASSAN
            continue
        if (len(w) >= 3 or (w.isdigit() and len(w) >= 1)) and t["c"] >= 0.5:
            reads.setdefault(pid, []).append((w, i))
for pid, rs in reads.items():
    words = Counter(w for w, _ in rs)
    best, best_views = None, set()
    for w in words:
        seen = {i for w2, i in rs if close(w, w2)}
        if len(seen) > len(best_views) or (len(seen) == len(best_views) and best and words[w] > words[best]):
            best, best_views = w, seen
    if best and len(best_views) >= 2:
        # the spelling read most often among the near-identical readings
        best = max((w for w in words if close(best, w)), key=lambda w: words[w])
        tags[str(pid)]["tags"].append(f"#{best}" if best.isdigit() else f"{best} on shirt")
        tags[str(pid)]["why"]["text"] = f"read as {best} in {len(best_views)} back views"
json.dump(tags, open(os.path.join(a.group_dir, "tags.json"), "w"), indent=1)
for pid, t in tags.items():
    print(f"P{pid}: {', '.join(t['tags']) or '-'}")
