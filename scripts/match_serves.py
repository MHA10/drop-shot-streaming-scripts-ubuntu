#!/usr/bin/env python3
"""
match_serves.py — work out which END served each point, and where the server
stood, from player geometry at the moment of the serve.

── IN SIMPLE WORDS ──
At the instant a padel point starts, the four players are arranged in a way that
gives the serve away: the server is deep in a back corner, their partner is up
at the net, and both opponents are waiting back. This reads that shape for every
point in the match and says which end served.

Then it applies a rule from the rulebook. Teams change ends after every odd game,
and the serve alternates every game — which together mean the serving END stays
put for two games, then flips for two. So the sequence of serving ends is not
noise, it is long runs, and a point whose geometry was misread can be corrected
by its neighbours. That correction is what the Viterbi pass does.

── BUSINESS RULES ──
- Exactly two players per half, always. Padel is 2v2 and nobody crosses the net,
  so this is a hard constraint, not a heuristic.
- The serving end holds for two consecutive games, then flips (change ends after
  odd games + serve alternates each game). Runs of ~2 games are CORRECT — a run
  of one game would mean the rules were broken.
- Serve side is reported as an END of the court (`far`/`near` in image terms),
  NOT as a team. The two games in one run are served by DIFFERENT teams, because
  the teams swapped ends between them. Do not read a run as one team's spell.

── WHY IT'S BUILT THIS WAY (change at your peril) ──
- **Geometry, not audio.** The obvious source is "whoever hit the first strike
  served", and it is wrong on these streams. The mic sits at the near end, so a
  far-end serve is often too quiet to detect at all and the first AUDIBLE strike
  is the near team's return. Attributing that gives the near end as the server
  for 25 consecutive points, which the rules make impossible.
- **Two per half, chosen by confidence.** Not a loudness or fixture filter. The
  camera sees a viewing area behind the right-hand glass whose occupants project
  to just inside the sideline, so a fifth "player" appears in about a third of
  points. An occupancy-based fixture filter was tried and removed real servers
  instead: the busiest cells in the whole match are the two back corners, which
  is exactly where servers stand. The per-half cap removes the intruder only
  when two better candidates already exist on that side, which is the only case
  where you can be sure it is an intruder.
- **Three independent geometric votes, not one.** Net-most player's side, the
  side with the larger front-to-back spread, and the side whose deepest player
  is furthest into a corner. Single rules sat around 60-70% and the errors were
  not shared, so the vote is materially better than any one of them.
- **Viterbi, not a median filter.** The signal is long runs with isolated
  errors, and the switch cost is what encodes "ends do not change often". A
  median filter with a window wide enough to fix an error also rounds off the
  genuine two-game boundaries.

── DO NOT ──
- Do NOT read `serve_side` as a team, or difference it to get who won a game.
  See the BUSINESS RULES note: one run spans two games and two different
  serving teams.
- Do NOT report a named player as the server from this file. It gives the
  serving END and the server's court POSITION. Naming the human needs identity
  held across the whole match, which torso colour does not deliver on night
  footage (measured: 41% of four-player frames separate into four clusters).
- Do NOT trust `switch_cost` transplanted to another match without re-checking
  the recovered points-per-game. That number is the diagnostic: padel games
  average ~6.5 points, so a run structure implying 15 or 2 points per game
  means the cost is wrong, not that the match was unusual.
"""

import argparse
import glob
import json
import os
import subprocess
import sys
import tempfile

try:
    import cv2
    import numpy as np
except Exception as exc:  # noqa: BLE001
    sys.stderr.write(f"match_serves: dependencies unavailable: {exc}\n")
    sys.exit(2)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from track_players import CourtModel, calibrate, _dedupe, _plausible_size  # noqa: E402


def sample_players(video, court, poly, model, points, pre, post, fps, verbose):
    """Detect players in the run-up to each point. Returns a flat record array."""
    recs = []
    for i, p in enumerate(points):
        a = max(0.0, p["start"] - pre)
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", f"{a:.2f}",
                            "-t", f"{pre+post:.2f}", "-i", video,
                            "-vf", f"fps={fps}", "-q:v", "3", f"{tmp}/f%03d.jpg"],
                           check=True)
            for k, f in enumerate(sorted(glob.glob(f"{tmp}/f*.jpg"))):
                im = cv2.imread(f)
                if im is None:
                    continue
                r = model.predict(im, classes=[0], conf=0.25, imgsz=1280,
                                  device="mps" if sys.platform == "darwin" else None,
                                  verbose=False)[0]
                dets = []
                for xyxy, c in zip(r.boxes.xyxy.tolist(), r.boxes.conf.tolist()):
                    x1, y1, x2, y2 = xyxy
                    foot = ((x1 + x2) / 2.0, y2)
                    if cv2.pointPolygonTest(poly, foot, False) < 0:
                        continue
                    d = {"box": (x1, y1, x2, y2), "foot": foot, "conf": c}
                    if not _plausible_size(d, court, im.shape[1], im.shape[0]):
                        continue
                    dets.append(d)
                dets = _dedupe(dets)
                # Two per half — the hard structural constraint.
                far, near = [], []
                for d in sorted(dets, key=lambda q: -q["conf"]):
                    u, v = court.uv(*d["foot"])
                    (far if v < court.v_net else near).append((u, v, d))
                for side in (far[:2], near[:2]):
                    for u, v, d in side:
                        recs.append((i, a + k / fps, u, v, d["conf"],
                                     d["box"][3] - d["box"][1],
                                     d["box"][0], d["box"][1], d["box"][2], d["box"][3]))
        if verbose and (i + 1) % 20 == 0:
            sys.stderr.write(f"match_serves: sampled {i+1}/{len(points)} points\n")
    return np.array(recs, np.float32)


def serve_votes(frame, v_net):
    """Three independent geometric reads of which end is serving. 1.0 == far."""
    v = frame[:, 3]
    far = frame[v < v_net]
    near = frame[v >= v_net]
    votes = []
    k = int(np.argmin(np.abs(v - v_net)))          # net-most player's side
    votes.append(1.0 if v[k] < v_net else 0.0)

    def spread(g):
        return (g[:, 3].max() - g[:, 3].min()) if len(g) >= 2 else -1.0
    votes.append(1.0 if spread(far) > spread(near) else 0.0)

    def corner(g):
        if len(g) == 0:
            return -1.0
        j = int(np.argmax(np.abs(g[:, 3] - v_net)))
        return abs(g[j, 2] - 0.5) + abs(g[j, 3] - v_net)
    votes.append(1.0 if corner(far) > corner(near) else 0.0)
    return float(np.mean(votes))


def viterbi(obs, switch_cost, eps=0.12):
    n = len(obs)
    dp = np.full((n, 2), -1e18)
    bk = np.zeros((n, 2), int)

    def em(o, s):
        if np.isnan(o):
            return 0.0
        p = o if s == 1 else 1.0 - o
        return float(np.log(np.clip(p, eps, 1 - eps)))

    for s in (0, 1):
        dp[0, s] = em(obs[0], s)
    for i in range(1, n):
        for s in (0, 1):
            best, arg = -1e18, 0
            for q in (0, 1):
                sc = dp[i-1, q] + (0.0 if q == s else -switch_cost)
                if sc > best:
                    best, arg = sc, q
            dp[i, s] = best + em(obs[i], s)
            bk[i, s] = arg
    path = [int(np.argmax(dp[-1]))]
    for i in range(n - 1, 0, -1):
        path.append(int(bk[i, path[-1]]))
    return np.array(path[::-1])


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--input", required=True, help="letterbox-stripped match video")
    ap.add_argument("--points", required=True, help="JSON from match_points.py")
    ap.add_argument("--output", required=True)
    ap.add_argument("--model", default="tools/reels/models/yolo11s.pt")
    ap.add_argument("--pre", type=float, default=3.5, help="seconds before the first strike")
    ap.add_argument("--post", type=float, default=0.5)
    ap.add_argument("--fps", type=float, default=6.0, help="sampling rate in the window")
    ap.add_argument("--switch-cost", type=float, default=2.0)
    ap.add_argument("--dets", default="", help="reuse a cached detection array")
    ap.add_argument("--dump-dets", default="", help="cache the detection array here")
    ap.add_argument("--court-hsv", default="90,40,40,130,255,255")
    ap.add_argument("--calib-debug", default="")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()

    points = json.load(open(args.points))["points"]
    hv = [int(x) for x in args.court_hsv.split(",")]
    court, note = calibrate(args.input, hv[:3], hv[3:6], args.calib_debug)
    if court is None:
        sys.stderr.write(f"match_serves: court calibration failed ({note})\n")
        return 3
    sys.stderr.write(f"match_serves: calibrated {note}\n")
    poly = court.polygon()

    if args.dets and os.path.exists(args.dets):
        arr = np.load(args.dets)
        sys.stderr.write(f"match_serves: reusing cached detections {arr.shape}\n")
    else:
        from ultralytics import YOLO
        arr = sample_players(args.input, court, poly, YOLO(args.model), points,
                             args.pre, args.post, args.fps, args.debug)
        if args.dump_dets:
            np.save(args.dump_dets, arr)

    obs = np.full(len(points), np.nan)
    serve_frames = {}
    for i, p in enumerate(points):
        sel = arr[arr[:, 0] == i]
        if len(sel) == 0:
            continue
        cand = sel[sel[:, 1] <= p["start"] + 0.05]
        if len(cand) == 0:
            cand = sel
        tl = cand[:, 1].max()
        fr = cand[np.abs(cand[:, 1] - tl) < 1e-6]
        if len(fr) < 2:
            continue
        obs[i] = serve_votes(fr, court.v_net)
        serve_frames[i] = fr

    path = viterbi(obs, args.switch_cost)
    runs, cur = [], 1
    for x, y in zip(path, path[1:]):
        if x == y:
            cur += 1
        else:
            runs.append(cur)
            cur = 1
    runs.append(cur)

    out = []
    for i, p in enumerate(points):
        side = "far" if path[i] else "near"
        fr = serve_frames.get(i)
        server = None
        players = []
        if fr is not None:
            pool = fr[fr[:, 3] < court.v_net] if path[i] else fr[fr[:, 3] >= court.v_net]
            if len(pool):
                j = int(np.argmax(np.abs(pool[:, 3] - court.v_net)))
                server = {"u": round(float(pool[j, 2]), 3), "v": round(float(pool[j, 3]), 3),
                          "box": [round(float(x), 1) for x in pool[j, 6:10]]}
            players = [{"u": round(float(r[2]), 3), "v": round(float(r[3]), 3),
                        "box": [round(float(x), 1) for x in r[6:10]]} for r in fr]
        out.append({
            "point": p["point"], "start": p["start"], "end": p["end"],
            "strikes": p["strikes"], "serve_side": side,
            "raw_vote": None if np.isnan(obs[i]) else round(float(obs[i]), 3),
            "smoothed_agrees_raw": (None if np.isnan(obs[i])
                                    else bool((obs[i] > 0.5) == bool(path[i]))),
            "server": server, "players_at_serve": players,
        })

    payload = {
        "input": args.input,
        "court": {"mL": court.mL, "bL": court.bL, "mR": court.mR, "bR": court.bR,
                  "y_top": court.y_top, "y_bot": court.y_bot, "y_net": court.y_net,
                  "v_net": court.v_net},
        "serve_runs": runs,
        "diagnostics": {
            "points": len(points),
            "points_with_geometry": int((~np.isnan(obs)).sum()),
            "side_switches": int((np.diff(path) != 0).sum()),
            "implied_games": 2 * len(runs),
            "implied_points_per_game": round(len(points) / max(1, 2 * len(runs)), 2),
            "raw_agreement": round(float(
                ((obs[~np.isnan(obs)] > 0.5) == path[~np.isnan(obs)]).mean()), 3),
        },
        "points": out,
    }
    json.dump(payload, open(args.output, "w"), indent=2)

    if args.debug:
        d = payload["diagnostics"]
        sys.stderr.write(
            f"match_serves: {d['points_with_geometry']}/{d['points']} points had usable "
            f"geometry; {d['side_switches']} end switches -> {len(runs)} runs\n"
            f"match_serves: runs={runs}\n"
            f"match_serves: implied {d['implied_games']} games, "
            f"{d['implied_points_per_game']} points/game "
            f"(padel averages ~6.5 - a wild number here means switch-cost is wrong)\n"
            f"match_serves: smoothing overrode raw geometry on "
            f"{100*(1-d['raw_agreement']):.0f}% of points\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"match_serves: unexpected error: {exc}\n")
        sys.exit(1)
