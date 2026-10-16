#!/usr/bin/env python3
"""
match_refine.py — fix the two ways audio alone mis-counts points, by asking the
video whether anyone was actually standing in a serve formation.

── IN SIMPLE WORDS ──
Listening to the ball tells you when it was hit, but not whether a burst of hits
was a new point. Two things fool it:

  1. A long lob puts three seconds of silence in the MIDDLE of a rally, so one
     point gets counted as two.
  2. A serve fault is a burst of its own — the serve, then nothing — so a point
     that took two serves gets counted as two points.

Both are settled by looking at the court. At a real point start, somebody is
stood deep in a back corner with their partner up at the net and both opponents
waiting back. Mid-rally, nobody is anywhere near that shape. So for every burst
of ball-strikes, this scores "how much does this look like a serve?" and uses the
answer to merge the bursts that were never separate points.

── BUSINESS RULES ──
- A burst that does not start from a serve formation is a CONTINUATION of the
  previous point, not a new one.
- A burst that starts from a serve formation but holds <= `--fault-strikes`
  strikes, and is followed by another serve within `--fault-window` seconds, is
  a SERVE FAULT and belongs to the point that follows it.
- No genuine point starts within `--min-restart` seconds of the previous one
  ending. A ball has to be retrieved and the server has to reset; on the
  reference match the 10th-percentile gap between points was 4.8s.
- Two consecutive faults are FLAGGED, not resolved. That shape is either a
  double fault (which ends a point) or a missed serve, and the difference is not
  visible in this evidence. Flagging beats guessing.

── WHY IT'S BUILT THIS WAY (change at your peril) ──
- **The discriminator is formation, not motion.** Two motion features were built
  and measured first, and both failed outright:
    * total player path length per frame — rally bursts 0.046, one-strike bursts
      0.051. No separation; between-point walking is as much motion as a rally.
    * post-serve displacement of the non-serving players — rally 0.075,
      one-strike 0.105. Separated the WRONG WAY, because a one-strike burst is
      often mid-walkabout while a short rally has players already set.
  Formation score does separate: point starts p10=0.639 against mid-rally
  p90=0.610 on the reference match, which is why the default threshold sits
  between those two numbers.
- **Scored on a single frame just before contact, not averaged over a window.**
  The formation only exists in the instant before the serve; a window that
  reaches past contact includes players already running and washes the signal
  out — which is what killed the two motion features.
- **The service-box rule is deliberately NOT used.** Padel alternates service
  boxes between points, so in principle a repeated box implies a fault. Measured
  on the reference match it alternated on only 67% of same-end pairs, against an
  expected ~77% (faults plus the game boundary inside each two-game run), so the
  rule carries roughly 10 points of noise from the server-position estimate. Too
  soft to decide on.

── DO NOT ──
- Do NOT tune `--serve-threshold` without re-measuring the two distributions on
  the footage in hand. It is an absolute score on a specific court geometry, and
  the whole justification for its value is that it sits in a measured gap.
- Do NOT read `serve_attempts: 2` as "a fault was confirmed". It means a
  serve-shaped burst was absorbed. Watch it in match_debug.py before quoting it.
- Do NOT expect this to find points that audio missed entirely. It only ever
  merges or re-labels bursts that strike detection already found; a point whose
  every strike was too quiet is still absent, and no amount of merging invents
  it.
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
    sys.stderr.write(f"match_refine: dependencies unavailable: {exc}\n")
    sys.exit(2)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from track_players import calibrate, _dedupe, _plausible_size  # noqa: E402


def players_at(video, court, poly, model, tt, lead=0.15):
    """Players (u, v) split by half, one frame just before `tt`."""
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", f"{max(0.0, tt-lead):.3f}",
                        "-i", video, "-frames:v", "1", "-q:v", "3", f"{tmp}/f.jpg"],
                       check=False)
        f = f"{tmp}/f.jpg"
        im = cv2.imread(f) if os.path.exists(f) else None
    if im is None:
        return None
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
    far, near = [], []
    for d in _dedupe(sorted(dets, key=lambda q: -q["conf"])):
        u, v = court.uv(*d["foot"])
        (far if v < court.v_net else near).append((u, v))
    return far[:2], near[:2]


def formation_score(pos, v_net):
    """
    0..1 — how much this instant looks like a padel serve formation.

    Weighted: the would-be server deep (0.40) and wide (0.20), their partner up
    at the net (0.20), both opponents waiting back (0.20). Evaluated for BOTH
    ends and the better one wins, because which end serves is exactly what is
    unknown here.
    """
    if pos is None:
        return None
    far, near = pos
    if len(far) + len(near) < 3:
        return None
    span_far, span_near = max(v_net, 1e-6), max(1.0 - v_net, 1e-6)
    best = None
    for srv, other in ((far, near), (near, far)):
        if not srv:
            continue
        j = int(np.argmax([abs(p[1] - v_net) for p in srv]))
        s = srv[j]
        depth = abs(s[1] - v_net) / (span_far if s[1] < v_net else span_near)
        wide = min(1.0, abs(s[0] - 0.5) * 2)
        partner = 0.0
        if len(srv) > 1:
            o = srv[1 - j]
            partner = 1.0 - min(1.0, abs(o[1] - v_net) / 0.30)
        recv = 0.0
        if other:
            recv = float(np.mean([
                min(1.0, (abs(p[1] - v_net) / (span_far if p[1] < v_net else span_near)) / 0.65)
                for p in other]))
        sc = 0.40 * min(1.0, depth) + 0.20 * wide + 0.20 * partner + 0.20 * recv
        best = sc if best is None else max(best, sc)
    return best


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--input", required=True, help="letterbox-stripped match video")
    ap.add_argument("--bursts", required=True,
                    help="JSON from match_points.py --emit-bursts")
    ap.add_argument("--output", required=True)
    ap.add_argument("--model", default="tools/reels/models/yolo11s.pt")
    ap.add_argument("--serve-threshold", type=float, default=0.625,
                    help="formation score above which a burst starts a point; the "
                         "default sits in the measured gap between point starts "
                         "(p10=0.639) and mid-rally (p90=0.610)")
    ap.add_argument("--rally-strikes", type=int, default=3,
                    help="a serve-shaped burst with at least this many strikes is a "
                         "rally; fewer makes it a serve attempt (fault or bounce)")
    ap.add_argument("--fault-window", type=float, default=12.0,
                    help="a fault must be followed by the retry within this long")
    ap.add_argument("--min-restart", type=float, default=4.0,
                    help="no real point starts sooner than this after the last ended")
    ap.add_argument("--max-continue", type=float, default=5.0,
                    help="a non-serve burst further than this from the previous "
                         "burst is stray noise, not a continuation of that rally")
    ap.add_argument("--court-hsv", default="90,40,40,130,255,255")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()

    data = json.load(open(args.bursts))
    bursts = data.get("bursts")
    if not bursts:
        sys.stderr.write("match_refine: no 'bursts' in input; re-run match_points.py "
                         "with --emit-bursts\n")
        return 3

    hv = [int(x) for x in args.court_hsv.split(",")]
    court, note = calibrate(args.input, hv[:3], hv[3:6])
    if court is None:
        sys.stderr.write(f"match_refine: calibration failed ({note})\n")
        return 3
    sys.stderr.write(f"match_refine: calibrated {note}\n")
    poly = court.polygon()
    from ultralytics import YOLO
    model = YOLO(args.model)

    for i, b in enumerate(bursts):
        sc = formation_score(players_at(args.input, court, poly, model, b["start"]),
                             court.v_net)
        b["formation"] = None if sc is None else round(float(sc), 3)
        b["serve_shaped"] = bool(sc is not None and sc >= args.serve_threshold)
        if args.debug and (i + 1) % 40 == 0:
            sys.stderr.write(f"match_refine: scored {i+1}/{len(bursts)} bursts\n")

    # ── assemble points ──
    # Three burst roles, and each attaches in only one direction:
    #   serve-shaped + >=3 strikes  -> RALLY START (opens a point)
    #   serve-shaped + <=2 strikes  -> SERVE ATTEMPT (fault or pre-serve bounce);
    #                                  attaches FORWARD to the next rally
    #   not serve-shaped            -> CONTINUATION; attaches BACKWARD, but only
    #                                  if close enough to be the same rally
    #
    # The direction matters. An earlier version pushed a too-soon serve-shaped
    # burst backwards as a continuation, which chained bursts together and
    # produced a 40-second and a 52-second "point" on the reference match. A
    # serve formation appearing 3s after a rally ended is the START of the next
    # point's serve sequence, never the middle of the one that just finished.
    points = []
    stats = {"continuations_merged": 0, "serve_attempts_absorbed": 0,
             "noise_dropped": 0, "fast_restart_flags": 0, "orphan_attempts": 0}
    pending = []          # serve attempts waiting for their rally
    for i, b in enumerate(bursts):
        rally_start = b["serve_shaped"] and b["strikes"] >= args.rally_strikes
        attempt = b["serve_shaped"] and not rally_start

        if attempt:
            pending.append(i)
            continue

        if rally_start:
            flags = []
            if points and b["start"] - points[-1]["end"] < args.min_restart:
                flags.append("fast_restart")
                stats["fast_restart_flags"] += 1
            # Only attempts close in front of this rally belong to it.
            mine = [j for j in pending
                    if b["start"] - bursts[j]["end"] <= args.fault_window]
            stats["orphan_attempts"] += len(pending) - len(mine)
            stats["serve_attempts_absorbed"] += len(mine)
            st = bursts[mine[0]]["start"] if mine else b["start"]
            points.append({
                "point": 0, "start": st, "rally_start": b["start"], "end": b["end"],
                "strikes": b["strikes"] + sum(bursts[j]["strikes"] for j in mine),
                "rally_strikes": b["strikes"],
                "serve_attempts": 1 + len(mine),
                "formation": b["formation"],
                "strike_times": sorted(
                    [t for j in mine for t in bursts[j]["strike_times"]] + b["strike_times"]),
                "bursts": mine + [i], "flags": flags,
            })
            pending = []
            continue

        # continuation
        if not points:
            stats["noise_dropped"] += 1
            continue
        p = points[-1]
        if b["start"] - p["end"] > args.max_continue:
            stats["noise_dropped"] += 1
            continue
        p["end"] = b["end"]
        p["strikes"] += b["strikes"]
        p["rally_strikes"] += b["strikes"]
        p["strike_times"] = sorted(p["strike_times"] + b["strike_times"])
        p["bursts"].append(i)
        stats["continuations_merged"] += 1
    stats["orphan_attempts"] += len(pending)

    out = []
    for n, p in enumerate(points, 1):
        p["point"] = n
        p["duration"] = round(p["end"] - p["start"], 2)
        out.append(p)

    payload = {
        "input": args.input,
        "source_bursts": len(bursts),
        "bursts": bursts,
        "points": out,
        "adjustments": stats,
        "totals": {
            "points": len(out),
            "points_with_a_fault": sum(1 for p in out if p["serve_attempts"] > 1),
            "flagged": sum(1 for p in out if p["flags"]),
            "strikes": sum(p["strikes"] for p in out),
        },
    }
    json.dump(payload, open(args.output, "w"), indent=2)

    if args.debug:
        t = payload["totals"]
        sys.stderr.write(
            f"match_refine: {len(bursts)} bursts -> {t['points']} points\n"
            f"match_refine: merged {stats['continuations_merged']} mid-rally "
            f"continuations; absorbed {stats['serve_attempts_absorbed']} serve "
            f"attempts; dropped {stats['noise_dropped']} stray bursts\n"
            f"match_refine: {t['points_with_a_fault']} points took an extra serve "
            f"(fault OR pre-serve bounce - not separable from this evidence)\n"
            f"match_refine: {stats['fast_restart_flags']} fast restarts and "
            f"{stats['orphan_attempts']} orphan serve attempts flagged\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"match_refine: unexpected error: {exc}\n")
        sys.exit(1)
