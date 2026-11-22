#!/usr/bin/env python3
"""Turn one match's person numbers into the 4 player slots the backend's stats route takes, and save it.

usage: make_payload.py <job_dir>

── IN SIMPLE WORDS ──
A match page lists "person numbers": the same player is often several numbers (one per
half of the court, or after a break). The backend wants exactly what a match is: 4
players, A and B on the far team, C and D on the near team, each with their stats, a
strip of pictures and a heatmap. This step makes that, and saves it in <job_dir>/api/
so it can be sent later (staging to test, production for real) without redoing anything:
  payload.json   the exact request body for POST .../padel-grounds/:groundId/courts/:courtId/stats
                 (picture and heatmap links empty: they are filled when the files are uploaded)
  upload.json    which local file goes into which link field
  player-A.jpg …  one picture strip per slot; heat-A.png … one heatmap per slot; collage.jpg
  slots.json     which person numbers made each slot, and everything a person should check

── BUSINESS RULES ──
- 4 slots per match, A/B = far team, C/D = near team, team = "far"/"near"
  (ds-backend staging, match-stats/engines/slots.ts, read 2026-11-22).
- No match ID: the backend links the record to the live match on that court at
  capturedAt (match-stats.service.ts matchCovering), so capturedAt is the middle of the match.
- Players claim their slot afterwards ("that's me"); the backend keeps claims open 14 days.
- The scoreboard's team names can't be told apart by court end, so they go in slots.json
  for a person, not into the payload.

── WHY IT'S BUILT THIS WAY (change at your peril) ──
- Stats are added up exactly like the who's-who page does (people-template.html
  combine()): sums for distance, sprints, net/back time; max for top speed; time-weighted
  mean speed. Two different sums for the same card would make the page and the app disagree.
- Teams come from who shares a half with whom over the match, not from each card's own
  half: teams swap ends every 2 games, so a card's half alone says nothing; partners are
  always on the same half at the same time.
- Every guess that could be wrong is written into slots.json "checks", never hidden.

── DO NOT ──
- Don't put anything personal in the payload (no names from the scoreboard): players add
  themselves by claiming.
- Don't write outside <job_dir>/api.
"""
import datetime as dt
import itertools
import json
import os
import re
import sys

import cv2
import numpy as np

SLOTS = ["A", "B", "C", "D"]
MIN_ON_S = 20.0          # scraps shorter than this (people crossing) are left out, like on the page
START_WINDOW_S = 180.0   # which team is "far" = who is on the far half in the first 3 minutes
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def load(path, default):
    try:
        return json.load(open(path))
    except (OSError, ValueError):
        return default


job = sys.argv[1]
J = load(os.path.join(job, "job.json"), {})
WHO = os.path.join(job, "who")
P = load(os.path.join(WHO, "people.json"), None)
if P is None:
    sys.exit("no who/people.json: the grouping step has not run")
SUG = load(os.path.join(WHO, "suggest.json"), [])
FLAGS = load(os.path.join(WHO, "flags.json"), {})
FPS = float(P["fps"])
pieces = {pc["id"]: pc for pc in P["pieces"]}
persons = {q["id"]: q for q in P["persons"]}
checks = []

# ── 1. players = person numbers joined by the "probably the same player" suggestions ──
kept = {i for i, q in persons.items() if q["on_s"] >= MIN_ON_S and str(i) not in FLAGS}
flagged = sorted(int(i) for i in FLAGS if int(i) in persons and persons[int(i)]["on_s"] >= MIN_ON_S)
if flagged:
    checks.append(f"left out, the computer thinks two people or not a player: {', '.join(f'P{i}' for i in flagged)}")
parent = {i: i for i in kept}


def root(i):
    while parent[i] != i:
        parent[i] = parent[parent[i]]
        i = parent[i]
    return i


for g in SUG:
    ids = [i for i in g.get("ids", []) if i in kept]
    for a, b in zip(ids, ids[1:]):
        parent[root(a)] = root(b)
groups = {}
for i in kept:
    groups.setdefault(root(i), []).append(i)
players = sorted(groups.values(), key=lambda ms: -sum(persons[i]["on_s"] for i in ms))
total_on = sum(persons[i]["on_s"] for i in kept) or 1.0
top = players[:4]
held = sum(persons[i]["on_s"] for ms in top for i in ms)
coverage = round(100 * held / total_on)
if len(top) < 4:
    checks.append(f"only {len(top)} players found, not 4")
if coverage < 80:
    checks.append(f"the 4 players hold only {coverage}% of the time on court: someone may be split or missing")
if len(players) > 4:
    rest = players[4:]
    checks.append("not in a slot: " + ", ".join(
        f"{'+'.join(f'P{i}' for i in ms)} ({sum(persons[i]['on_s'] for i in ms) / 60:.1f} min)" for ms in rest[:6]))


def spans(ms):
    """(start_frame, end_frame, far?) for every piece of this player."""
    out = []
    for i in ms:
        for k in persons[i]["pieces"]:
            pc = pieces[k]
            out.append((pc["start"], pc["end"], pc.get("far", 0) * 2 > max(1, pc.get("seen", 1))))
    return out


S = [spans(ms) for ms in top]


def agree(a, b):
    """Seconds on the same half minus seconds on opposite halves, while both are on court."""
    t = 0.0
    for s0, e0, f0 in S[a]:
        for s1, e1, f1 in S[b]:
            ov = min(e0, e1) - max(s0, s1)
            if ov > 0:
                t += (ov if f0 == f1 else -ov) / FPS
    return t


# ── 2. teams: the pairing where partners share a half most ──
if len(top) == 4:
    pairings = [((0, 1), (2, 3)), ((0, 2), (1, 3)), ((0, 3), (1, 2))]
    score = {pr: agree(*pr[0]) + agree(*pr[1]) for pr in pairings}
    best = max(pairings, key=lambda pr: score[pr])
    second = sorted(score.values())[-2]
    if score[best] <= 0:
        checks.append("teams guessed: the players were never on court together long enough to tell partners apart")
    elif score[best] - second < 60:
        checks.append(f"teams unsure: best split leads the next by only {score[best] - second:.0f} s of play")
    pairs = [list(best[0]), list(best[1])]
elif len(top) == 3:
    two = max([(0, 1), (0, 2), (1, 2)], key=lambda pr: agree(*pr))
    pairs = [list(two), [k for k in range(3) if k not in two]]
    checks.append("teams guessed from 3 players")
elif len(top) == 2:
    pairs = [[0, 1], []] if agree(0, 1) >= 0 else [[0], [1]]
    checks.append("teams guessed from 2 players")
else:
    pairs = [list(range(len(top))), []]


T0 = min((s for sp in S for s, _, _ in sp), default=0)  # the first sighting of any of the 4


def far_share(pair):
    """Share of the first minutes of the match this pair spends on the far half."""
    t0 = T0
    limit = t0 + START_WINDOW_S * FPS
    far = near = 0.0
    for k in pair:
        for s, e, f in S[k]:
            ov = min(e, limit) - s
            if ov > 0:
                far, near = (far + ov, near) if f else (far, near + ov)
    return far / (far + near) if far + near else 0.5


def together(a, b):
    """Seconds both are on court at the same time."""
    return sum(max(0, min(e0, e1) - max(s0, s1)) for s0, e0, _ in S[a] for s1, e1, _ in S[b]) / FPS


for a, b in itertools.combinations(range(len(top)), 2):
    shorter = min(sum(persons[i]["on_s"] for i in top[a]), sum(persons[i]["on_s"] for i in top[b]))
    if shorter > 60 and together(a, b) < 0.5 * shorter:
        ids = lambda k: "+".join(f"P{i}" for i in sorted(top[k]))
        checks.append(f"{ids(a)} and {ids(b)} were hardly on court together: maybe the same player")


if pairs[1] and far_share(pairs[1]) > far_share(pairs[0]):
    pairs = [pairs[1], pairs[0]]
if pairs[1] and abs(far_share(pairs[0]) - far_share(pairs[1])) < 0.3:
    checks.append("far/near team unsure: at the start both teams were seen on both halves")


# ── 3. stats per player, added up like the page's combine() ──
def combine(ms):
    t = dict(on_s=0.0, seen=0, stat_s=0.0, dist_m=0.0, lat_m=0.0, sprints=0, top_ms=0.0, mean_w=0.0,
             net_s=0.0, back_s=0.0, n=0, sx=0.0, sy=0.0, left=0, cells=np.zeros(100, int))
    for i in ms:
        for k in persons[i]["pieces"]:
            q = pieces[k]
            t["on_s"] += q["on_s"]
            t["seen"] += q.get("seen", 0)
            if "dist_m" not in q:
                continue
            t["stat_s"] += q["on_s"]
            t["dist_m"] += q["dist_m"]
            t["lat_m"] += q["lat_m"]
            t["sprints"] += q["sprints"]
            t["top_ms"] = max(t["top_ms"], q["top_ms"])
            t["mean_w"] += q["mean_ms"] * q["on_s"]
            t["net_s"] += q["net_s"]
            t["back_s"] += q["back_s"]
            t["n"] += q["n"]
            t["sx"] += q["sx"]
            t["sy"] += q["sy"]
            t["left"] += q["left"]
            for c, v in q["cells"].items():
                t["cells"][int(c)] += v
    return t


def api_stats(t, team):
    s = {"team": team}
    if t["stat_s"] > 0:
        s.update({
            "distance_m": round(t["dist_m"], 1),
            "lateral_distance_m": round(t["lat_m"], 1),
            "mean_speed_ms": round(t["mean_w"] / t["stat_s"], 2),
            "top_speed_ms": round(t["top_ms"], 2),
            "sprints": int(t["sprints"]),
            "time_at_net_s": round(t["net_s"], 1),
            "time_at_net_pct": round(100 * t["net_s"] / t["stat_s"], 1),
            "time_at_back_s": round(t["back_s"], 1),
            "time_at_back_pct": round(100 * t["back_s"] / t["stat_s"], 1),
        })
    if t["n"]:
        left = 100 * t["left"] / t["n"]
        s.update({
            # own half: x = metres from their left sideline, y = metres back from the net (as player_stats.py)
            "avg_position_xy_m": [round(t["sx"] / t["n"], 2), round(t["sy"] / t["n"], 2)],
            "avg_side": "left" if left >= 50 else "right",
            "left_side_pct": round(left, 1),
        })
    dur = J.get("duration_s") or t["on_s"]
    if dur:
        # share of the whole match this player was seen (the backend marks under 0.6 as "numbers under-count")
        s["detection_rate"] = round(min(1.0, t["seen"] / (dur * FPS)), 2)
    return s


slot_of = {}
for team, pair in zip(("far", "near"), pairs):
    # the one who plays more on their own left gets the first letter of the pair (A or C)
    pair = sorted(pair, key=lambda k: -(combine(top[k])["left"] / max(1, combine(top[k])["n"])))
    letters = SLOTS[:2] if team == "far" else SLOTS[2:]
    for letter, k in zip(letters, pair):
        slot_of[letter] = (k, team)

out_dir = os.path.join(job, "api")
os.makedirs(out_dir, exist_ok=True)


# ── 4. pictures: a strip per slot (8 moments, like the page's card), a heatmap, a collage ──
def strip(ms):
    pics = sorted((p for i in ms for p in persons[i]["pictures"]), key=lambda p: p[3])
    step = max(1.0, len(pics) / 8)
    shown = [pics[int(i * step)] for i in range(min(8, len(pics)))]
    tiles = []
    for src, off, ln, _ in shown:
        img = None
        part = P["parts"][src]
        for d in (part, os.path.join(job, "people", os.path.basename(part))):   # box path, or a copy elsewhere
            try:
                with open(os.path.join(d, "crops.bin"), "rb") as fb:
                    fb.seek(off)
                    img = cv2.imdecode(np.frombuffer(fb.read(ln), np.uint8), cv2.IMREAD_COLOR)
                break
            except OSError:
                continue
        tiles.append(img if img is not None else np.zeros((160, 80, 3), np.uint8))
    while len(tiles) < 8:
        tiles.append(np.full((160, 80, 3), 235, np.uint8))
    return np.hstack(tiles)


def heatmap(cells):
    """Own half seen from behind the player: net at the top, back glass at the bottom, 10 x 10 m."""
    g = cells.reshape(10, 10).astype(float)
    mx = max(1.0, g.max())
    img = np.full((10, 10, 3), (232, 238, 241), np.uint8)
    for (y, x), v in np.ndenumerate(g):
        if v:
            r = v / mx
            img[y, x] = (180, 220, 255) if r < .25 else (90, 160, 255) if r < .6 else (30, 60, 220)
    img = cv2.resize(img, (200, 200), interpolation=cv2.INTER_NEAREST)
    cv2.line(img, (0, 1), (199, 1), (40, 40, 40), 3)          # the net
    cv2.line(img, (100, 0), (100, 199), (200, 200, 200), 1)   # middle line (left | right)
    return img


files = {"playerImageUrls": {}, "heatmapUrls": {}}
rows = []
players_api = {}
slot_info = {}
for letter in SLOTS:
    if letter not in slot_of:
        continue
    k, team = slot_of[letter]
    ms = top[k]
    t = combine(ms)
    players_api[letter] = api_stats(t, team)
    if t["stat_s"] >= 60 and t["dist_m"] / (t["stat_s"] / 60) < 10:   # the page's "hardly moved" rule
        checks.append(f"slot {letter} hardly moved (under 10 m a minute): maybe not a player")
    st = strip(ms)
    cv2.imwrite(os.path.join(out_dir, f"player-{letter}.jpg"), st, [cv2.IMWRITE_JPEG_QUALITY, 88])
    cv2.imwrite(os.path.join(out_dir, f"heat-{letter}.png"), heatmap(t["cells"]))
    files["playerImageUrls"][letter] = f"player-{letter}.jpg"
    files["heatmapUrls"][letter] = f"heat-{letter}.png"
    label = np.full((160, 60, 3), 255, np.uint8)
    cv2.putText(label, letter, (12, 100), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (30, 30, 30), 3)
    rows.append(np.hstack([label, st]))
    slot_info[letter] = {"team": team, "person_numbers": sorted(ms), "on_court_min": round(t["on_s"] / 60, 1)}
if rows:
    cv2.imwrite(os.path.join(out_dir, "collage.jpg"), np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 85])
    files["collageUrl"] = "collage.jpg"

# ── 5. the request body, exactly as the route checks it (dto/match-stats.dto.ts) ──
ws, we = J.get("ws"), J.get("we")
mid = dt.datetime.fromtimestamp((ws + (we - ws) / 2) / 1000, tz=dt.timezone.utc) if ws and we else None
payload = {
    "schemaVersion": 1,
    "groundId": J.get("ground_id"),
    "courtId": J.get("court_id"),
    "matchId": None,
    # Stable per match: the backend replaces (not duplicates) a record sent again with the
    # same streamId and capturedAt when no live match was found (match-stats.service.ts ingest).
    "streamId": f"dropshot-box:{J.get('id')}" if J.get("id") else None,
    "capturedAt": mid.strftime("%Y-%m-%dT%H:%M:%SZ") if mid else None,
    "heatmapUrl": None,
    "heatmapUrls": None,
    "collageUrl": None,
    "playerImageUrls": None,
    "stats": {
        "source": "dropshot-tournament-box",
        "duration_s": J.get("duration_s"),
        "players": players_api,
        "teams": {team: {"players": [s for s, (_, tm) in slot_of.items() if tm == team]} for team in ("far", "near")},
    },
}

problems = []
if payload["schemaVersion"] not in (1, 2):
    problems.append("schemaVersion")
for f in ("groundId", "courtId"):
    if not (isinstance(payload[f], str) and UUID.match(payload[f])):
        problems.append(f"{f} missing or not a UUID (court_id: stats/courts.json; ground_id: DROPSHOT_GROUND_ID in the streamer's .env)")
if not payload["capturedAt"]:
    problems.append("capturedAt missing")
for s, v in players_api.items():
    if s not in SLOTS or v.get("team") not in ("far", "near"):
        problems.append(f"slot {s}")
if not players_api:
    problems.append("no players")
# The backend keeps one record per live match: parts of one match would overwrite each other,
# and a whole recording with no match in the log mixes whoever played (review 2026-11-22).
if J.get("kind") != "match":
    problems.append("a whole recording, not one match: split it into matches by hand first")
elif re.search(r"-p\d+$", str(J.get("id", ""))) or any("cut into" in c for c in J.get("checks", [])):
    problems.append("one part of a match over 90 minutes: parts must be joined into one record before sending")

json.dump(payload, open(os.path.join(out_dir, "payload.json"), "w"), indent=1)
json.dump(files, open(os.path.join(out_dir, "upload.json"), "w"), indent=1)
json.dump({
    "job": J.get("id"), "title": J.get("title"), "court": J.get("court_name"),
    "match_start": J.get("start"), "match_end": J.get("end"),
    "team_names_on_scoreboard": J.get("teams"),
    "slots": slot_info, "four_players_hold_pct": coverage,
    "checks": checks + list(J.get("checks", [])),
    "ready_to_send": not problems, "not_ready_because": problems,
}, open(os.path.join(out_dir, "slots.json"), "w"), indent=1)
slot_list = ", ".join("%s=%s" % (s, v["team"]) for s, v in players_api.items())
state = "ready to send" if not problems else "NOT ready: " + "; ".join(problems)
print(f"api payload: {len(players_api)} slots ({slot_list}), 4 players hold {coverage}% of the time on court, "
      f"{len(checks)} checks, {state}", flush=True)
