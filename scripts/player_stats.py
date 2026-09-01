#!/usr/bin/env python3
"""
player_stats.py — the tracking-derived match stats for each player, computed
straight from the A/B/C/D tracks. No ball detection anywhere in here.

── IN SIMPLE WORDS ──
Once you know where each of the four players was in every frame, a whole pack of
stats falls out for free: how far they ran, how fast, where they liked to stand,
how much of the court they covered, how long they sat at the net versus glued to
the back glass, and how well each pair held their shape as a team. This turns
the raw tracks into exactly those numbers.

It reads the output of `track_players.py --dump-tracks` and writes one stats
block per player plus one per team.

── BUSINESS RULES ──
- Metric outputs (metres, m/s) use a fixed padel court: 10 m wide, 20 m long,
  net on the 10 m line. Width is exact; depth is a net-anchored estimate (see
  below) — quote it as an estimate, not a survey.
- "At the net" and "at the back glass" are the front and back 3 m of a player's
  own half — the 3 m matches the real service line, so the zones are the ones a
  padel player already thinks in.
- Teams are the two players sharing a half of the court: {A,B} far, {C,D} near.
  Padel partners never cross the net, so this needs no appearance model.
- Player separation and formation are TEAM stats, not player stats — they are
  about the pair, and the ~2 m separation threshold is the one the coaches use.

── WHY IT'S BUILT THIS WAY (change at your peril) ──
- **Metric depth is anchored on the NET, not on the near baseline.** The court
  model gives u (across) exactly — the court is 10 m wide at every depth, so
  X = 10·u regardless of perspective. Depth v is affine in real distance for a
  pinhole camera, so Y is linear in v; the net sits at a known 10 m and at
  measured v_net, which fixes the scale as Y = 10·v/v_net WITHOUT needing the
  near baseline in frame (it routinely is not). Validated on the reference
  rally: the far pair reads 0.7-6.1 m, the near pair 12.5-20 m, net dividing
  them — physically correct.
- **Distance is summed AFTER smoothing, with a deadband.** Raw foot points
  jitter a few pixels per frame, and at the far end that jitter is amplified
  through the perspective into spurious metres. Without a moving-average plus a
  per-frame deadband, a stationary far player "runs" tens of metres a rally.
- **Only CONFIRMED detections drive the stats; gaps are bridged for continuity
  but flagged.** A coasted position is the tracker's guess; integrating guesses
  inflates distance. Each player's stats carry the detection rate so a low one
  (the near-baseline player who leaves frame) is visible, not hidden.
- **Sprint is displacement over a 1 s WINDOW, not instantaneous speed.** A
  single-frame speed spike is usually a detection jump; a real sprint is
  sustained ground covered, which is exactly the coach's definition.

── DO NOT ──
- Do NOT present the metre and m/s figures as survey-accurate. Depth carries the
  lens's barrel distortion and the affine approximation; treat them as ±10-15%
  and fine for comparing players and rallies, not for a line call.
- Do NOT compute distance from unsmoothed positions. See above — it is dominated
  by jitter, worst for the far pair.
- Do NOT read a low-coverage player's stats without the detection rate. A player
  detected 80% of frames has 20% of their path missing, which understates
  distance and coverage.
- Do NOT run this on a clip where the tracker's identity was not stable. Garbage
  tracks in, garbage stats out; check track_players.py's per-player hit rate
  first.
"""

import argparse
import json
import os
import sys

try:
    import numpy as np
except Exception as exc:  # noqa: BLE001
    sys.stderr.write(f"player_stats: dependencies unavailable: {exc}\n")
    sys.exit(2)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from track_players import CourtModel, LABELS  # noqa: E402

COURT_W_M = 10.0          # padel court width, exact
COURT_L_M = 20.0          # length, baseline to baseline
NET_M = 10.0              # net on the midline
ZONE_M = 3.0              # front/back band = service-line distance
TEAMS = {"far": ("A", "B"), "near": ("C", "D")}


def _smooth(x, win):
    if win < 3 or len(x) < win:
        return x
    win = int(win) | 1
    pad = win // 2
    ker = np.ones(win) / win
    return np.convolve(np.pad(x, pad, mode="edge"), ker, mode="valid")


def metric_track(track, court, fps):
    """
    Per-frame (X, Y) in metres for one player, plus a per-frame 'solid' mask.

    Gaps are linearly interpolated so speed is continuous, but the solid mask
    records which frames were real detections, so the caller can weight
    confidence and report a detection rate.
    """
    n = len(track)
    X = np.full(n, np.nan)
    Y = np.full(n, np.nan)
    solid = np.zeros(n, bool)
    vnet = court.v_net
    for i, s in enumerate(track):
        if not s:
            continue
        u, v = court.uv(s["foot"][0], s["foot"][1])
        X[i] = COURT_W_M * u
        Y[i] = NET_M * v / vnet
        solid[i] = bool(s["solid"])
    have = np.where(~np.isnan(X))[0]
    if len(have) < 2:
        return None
    idx = np.arange(n)
    X = np.interp(idx, have, X[have])
    Y = np.interp(idx, have, Y[have])
    # ~0.3 s smoothing kills the per-frame jitter that otherwise reads as running
    win = max(3, int(round(0.30 * fps)))
    return _smooth(X, win), _smooth(Y, win), solid, have[0], have[-1]


def player_stats(X, Y, solid, span, fps, half):
    """All the per-player metrics for one metric track."""
    a, b = span
    X, Y, solid = X[a:b + 1], Y[a:b + 1], solid[a:b + 1]
    dt = 1.0 / fps
    dx, dy = np.diff(X), np.diff(Y)
    step = np.hypot(dx, dy)
    # Physical clamp. Elite on-court movement peaks ~8 m/s; anything faster is a
    # tracking discontinuity (the near-baseline player exits frame and is
    # re-acquired with a jump), not motion. Those steps are set to zero so a
    # single teleport cannot inject hundreds of metres. Without this, the
    # near-baseline player read 13,403 m and 18,499 m/s on the reference rally.
    MAX_SPEED = 8.0
    max_step = MAX_SPEED * dt
    deadband = 0.03                                       # sub-3 cm/frame = jitter
    valid = step <= max_step
    step_clean = np.where(valid & (step >= deadband), step, 0.0)
    distance = float(step_clean.sum())

    speed = np.where(valid, step, 0.0) / dt               # m/s, discontinuities dropped
    speed_s = _smooth(speed, max(3, int(round(0.20 * fps))))
    mean_speed = float(np.median(speed_s[speed_s > 0])) if (speed_s > 0).any() else 0.0
    max_speed = float(min(MAX_SPEED, np.percentile(speed_s, 99)))

    # sprint = >4 m covered inside any 1 s window
    w = int(round(fps))
    sprint_thresh = 4.0
    covered = np.convolve(step_clean, np.ones(w), mode="valid") if len(step_clean) >= w else np.array([0.0])
    over = covered >= sprint_thresh
    sprints = int(np.sum(over[1:] & ~over[:-1])) + (1 if len(over) and over[0] else 0)

    # Position-based stats use CONFIRMED frames only. Off-frame excursions and
    # re-acquisition jumps put a player at impossible coordinates; counting those
    # as "coverage" or "time in a zone" invents court the player never stood on.
    Xs, Ys = X[solid], Y[solid]
    if len(Xs) < 2:
        Xs, Ys = X, Y
    if half == "far":         # baseline Y=0, net Y=10
        at_net = Ys > (NET_M - ZONE_M)
        at_back = Ys < ZONE_M
    else:                     # baseline Y=20, net Y=10
        at_net = Ys < (NET_M + ZONE_M)
        at_back = Ys > (COURT_L_M - ZONE_M)

    # coverage: fraction of a 1 m grid over the player's own 10x10 m half visited
    gx = np.clip((Xs / COURT_W_M * 10).astype(int), 0, 9)
    gy = np.clip(((Ys - (0 if half == "far" else NET_M)) / NET_M * 10).astype(int), 0, 9)
    cells = len(set(zip(gx.tolist(), gy.tolist())))

    # left/right: total lateral travel (clamped), and side favoured
    lat_step = np.where(valid & (np.abs(dx) >= deadband), np.abs(dx), 0.0)
    lateral = float(lat_step.sum())

    return {
        "distance_m": round(distance, 1),
        "avg_position_xy_m": [round(float(np.mean(Xs)), 2), round(float(np.mean(Ys)), 2)],
        "court_coverage_pct": round(100.0 * cells / 100.0, 1),
        "mean_speed_ms": round(mean_speed, 2),
        "top_speed_ms": round(max_speed, 2),
        "sprints": sprints,
        "time_at_net_s": round(float(at_net.mean() * (b - a) * dt), 1),
        "time_at_back_s": round(float(at_back.mean() * (b - a) * dt), 1),
        "time_at_net_pct": round(float(at_net.mean() * 100), 0),
        "time_at_back_pct": round(float(at_back.mean() * 100), 0),
        "lateral_distance_m": round(lateral, 1),
        "avg_side": "left" if np.mean(Xs) < COURT_W_M / 2 else "right",
    }


def team_stats(mA, mB, span, fps, half):
    """Separation and formation for one pair of partners."""
    a = max(mA[3], mB[3], span[0])
    b = min(mA[4], mB[4], span[1])
    if b <= a:
        return None
    XA, YA = mA[0][a:b + 1], mA[1][a:b + 1]
    XB, YB = mB[0][a:b + 1], mB[1][a:b + 1]
    sep = np.hypot(XA - XB, YA - YB)
    dt = 1.0 / fps

    # formation: front/back band membership per partner, per frame
    if half == "far":
        upA, upB = YA > NET_M - ZONE_M, YB > NET_M - ZONE_M
    else:
        upA, upB = YA < NET_M + ZONE_M, YB < NET_M + ZONE_M
    both_up = float((upA & upB).mean())
    both_back = float((~upA & ~upB).mean())
    staggered = float((upA ^ upB).mean())

    return {
        "mean_separation_m": round(float(np.median(sep)), 2),
        "max_separation_m": round(float(np.percentile(sep, 99)), 2),
        "pct_time_gap_over_2m": round(float((sep > 2.0).mean() * 100), 0),
        "formation": {
            "both_at_net_pct": round(both_up * 100, 0),
            "both_at_back_pct": round(both_back * 100, 0),
            "one_up_one_back_pct": round(staggered * 100, 0),
        },
        "dominant_formation": max(
            (("both at net", both_up), ("both at back", both_back),
             ("one up, one back", staggered)), key=lambda kv: kv[1])[0],
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--tracks", required=True, help="JSON from track_players.py --dump-tracks")
    ap.add_argument("--output", required=True)
    ap.add_argument("--names", default="",
                    help="label the players, e.g. 'A=Ali,B=Sara,C=Omar,D=Zara'")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()

    data = json.load(open(args.tracks))
    if not data.get("court"):
        sys.stderr.write("player_stats: tracks have no court calibration\n")
        return 3
    c = data["court"]
    court = CourtModel(c["mL"], c["bL"], c["mR"], c["bR"], c["y_top"], c["y_bot"], c["y_net"])
    fps = data["fps"] or 30.0
    frames = data["frames"]

    names = {L: L for L in LABELS}
    for part in filter(None, args.names.split(",")):
        k, _, v = part.partition("=")
        if k.strip().upper() in names:
            names[k.strip().upper()] = v.strip()

    half_of = {L: ("far" if L in TEAMS["far"] else "near") for L in LABELS}
    metric = {}
    players = {}
    for L in LABELS:
        m = metric_track(data["tracks"][L], court, fps)
        if m is None:
            continue
        metric[L] = m
        solid_rate = float(np.mean(m[2]))
        st = player_stats(m[0], m[1], m[2], (m[3], m[4]), fps, half_of[L])
        st["name"] = names[L]
        st["team"] = half_of[L]
        st["detection_rate"] = round(solid_rate, 2)
        players[L] = st

    teams = {}
    for half, (p, q) in TEAMS.items():
        if p in metric and q in metric:
            ts = team_stats(metric[p], metric[q], (0, frames - 1), fps, half)
            if ts:
                ts["players"] = [names[p], names[q]]
                teams[half] = ts

    payload = {
        "source": data.get("video"),
        "duration_s": round(frames / fps, 1),
        "calibration": {
            "court_m": [COURT_W_M, COURT_L_M],
            "depth": "net-anchored estimate (Y = 10 * v / v_net); metric values are ~±10-15%",
            "width": "exact (X = 10 * u)",
        },
        "players": players,
        "teams": teams,
    }
    json.dump(payload, open(args.output, "w"), indent=2)

    if args.debug:
        sys.stderr.write(f"player_stats: {len(players)} players, {len(teams)} teams, "
                         f"{payload['duration_s']}s\n")
        for L, st in players.items():
            sys.stderr.write(
                f"  {st['name']:<8} dist {st['distance_m']:>5}m  top {st['top_speed_ms']:>4}m/s "
                f"sprints {st['sprints']:>2}  net {st['time_at_net_pct']:>3.0f}% "
                f"back {st['time_at_back_pct']:>3.0f}%  cover {st['court_coverage_pct']:>4}%  "
                f"det {st['detection_rate']:.2f}\n")
        for half, ts in teams.items():
            sys.stderr.write(
                f"  team {half}: sep {ts['mean_separation_m']}m  gap>2m "
                f"{ts['pct_time_gap_over_2m']:.0f}%  -> {ts['dominant_formation']}\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"player_stats: unexpected error: {exc}\n")
        sys.exit(1)
