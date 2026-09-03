#!/usr/bin/env python3
"""
match_shots.py — shot detection without the ball: how many shots each rally
had, which team hit each one, and whether it was played from the net or the
back glass. Built from the audio strike times and the player tracking already
produced upstream.

── IN SIMPLE WORDS ──
A shot in padel is a ball struck by a paddle, and that makes a sharp crack the
microphone hears cleanly. So counting shots needs no ball detection at all: each
crack is one shot, and a burst of cracks is a rally. This turns those cracks into
shot counts, works out which END of the court each shot came from, maps that end
to the team standing there, and tags each shot as played going forward (at the
net) or on the back foot (at the glass).

── BUSINESS RULES ──
- A shot = one detected ball strike. Shot count per rally is the strike count,
  which is a FLOOR: a very quiet far-end shot can be missed, so the true count
  is this or slightly higher.
- Shots are attributed to an END, then to the TEAM on that end for that point.
  Which of the two TEAMMATES hit it is deliberately NOT claimed per shot — see
  the DO NOT section.
- Serve counts come from the validated serve stage, not from this file's own
  attribution.

── WHY IT'S BUILT THIS WAY (change at your peril) ──
- **Shot count is the reliable headline; team/attack-defence are secondary.**
  Strike detection is high-precision, so the count is trustworthy. End
  attribution is only as good as the last-contact stage (measured: strong on the
  serve, weaker deep in a rally), so anything derived from the per-shot END
  inherits that and is reported as directional, not exact.
- **Attack vs defence is the hitter's depth at contact, banded at 3 m.** A shot
  struck within 3 m of the net is an attacking/net shot; within 3 m of the back
  glass is defensive. 3 m is the service line, the zone a padel player already
  thinks in.
- **Everything is read from cached JSON, no video pass.** The per-strike end and
  hitter position were already computed by match_lastshot.py; recomputing them
  would re-run YOLO for no gain.

── DO NOT ──
- Do NOT report per-PLAYER shot counts as reliable. Identity is only solved at
  the serve instant, not frame-by-frame through a rally, so which of two
  teammates hit a mid-rally shot is not established. Team-level is as far as the
  evidence honestly goes; per-player is left out rather than guessed.
- Do NOT read shot count as the score. It counts audible contacts, not points.
- Do NOT use winner/error here — it is not produced. That needs the ball (or a
  labelled heuristic) and was deferred on purpose.
"""

import argparse
import json
import os
import sys

try:
    import numpy as np
except Exception as exc:  # noqa: BLE001
    sys.stderr.write(f"match_shots: dependencies unavailable: {exc}\n")
    sys.exit(2)

NET_V = 0.5           # net at mid-depth in normalised court coords
ZONE = 0.15           # ~3 m of the ~20 m court, as a fraction of depth


def team_of_end(point_players, teams, v_net, end):
    """The two-player team standing on `end` for this point."""
    on_end = [nm for nm, uv in point_players.items()
              if (uv["v"] >= v_net) == (end == "near")]
    for t in teams:
        if set(on_end) and set(on_end) <= set(t):
            return list(t)
    # fall back: the team with more members on that end
    best, who = -1, None
    for t in teams:
        n = sum(1 for nm in t if nm in on_end)
        if n > best:
            best, who = n, list(t)
    return who


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--points", required=True, help="refined.json (strike times)")
    ap.add_argument("--lastshot", required=True, help="lastshot.json (per-strike end + position)")
    ap.add_argument("--players", required=True, help="players.json (identity + teams)")
    ap.add_argument("--serves", required=True, help="serves.json (validated serve)")
    ap.add_argument("--output", required=True)
    ap.add_argument("--names", default="", help="P1=Ali,P2=..., for readable output")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()

    pts = {p["point"]: p for p in json.load(open(args.points))["points"]}
    ls = {p["point"]: p for p in json.load(open(args.lastshot))["points"]}
    pj = json.load(open(args.players))
    teams = pj["teams"]
    v_net = 0.5
    id_by_point = {q["point"]: q for q in pj["points"]}
    sv = {p["point"]: p for p in json.load(open(args.serves))["points"]}

    names = {}
    for part in filter(None, args.names.split(",")):
        k, _, v = part.partition("=")
        names[k.strip()] = v.strip()
    nm = lambda p: names.get(p, p)

    team_key = {tuple(sorted(t)): f"Team {chr(65+i)}" for i, t in enumerate(teams)}

    out_points = []
    team_shots = {tuple(sorted(t)): 0 for t in teams}
    attack = defence = mid = 0
    serve_hits = serve_total = 0

    for pn, p in pts.items():
        strikes = ls.get(pn, {}).get("strikes")
        if not strikes:
            continue
        idp = id_by_point.get(pn, {}).get("players", {})
        shots = []
        for k, s in enumerate(strikes):
            end = s["end"]
            team = team_of_end(idp, teams, v_net, end) if idp else None
            v = s.get("v")
            if v is None:
                zone = None
            elif (end == "near" and v < NET_V + ZONE) or (end == "far" and v > NET_V - ZONE):
                zone = "attack"        # within 3 m of the net
            elif (end == "near" and v > 1 - ZONE) or (end == "far" and v < ZONE):
                zone = "defence"       # within 3 m of the back glass
            else:
                zone = "mid"
            shots.append({"t": s["t"], "end": end,
                          "team": None if not team else team_key[tuple(sorted(team))],
                          "zone": zone})
            if team:
                team_shots[tuple(sorted(team))] += 1
            attack += zone == "attack"
            defence += zone == "defence"
            mid += zone == "mid"

        # NOTE: no independent check of end attribution is possible here.
        # match_lastshot anchors strike 0 on the serve side, so comparing the
        # serve strike's end to the serve is tautological (always agrees) and
        # proves nothing. Team attribution past the serve is therefore reported
        # as directional/unvalidated, not measured. Serve strikes themselves are
        # well attributed (the serve stage is validated at 0.94 rotation).
        if pn in sv and strikes:
            serve_total += 1

        out_points.append({
            "point": pn, "shots": len(strikes),
            "serve_side": sv.get(pn, {}).get("serve_side"),
            "server": nm(id_by_point.get(pn, {}).get("server_player")) if id_by_point.get(pn) else None,
            "shot_ends": [s["end"] for s in strikes],
            "shot_teams": [x["team"] for x in shots],
            "shot_zones": [x["zone"] for x in shots],
        })

    counts = np.array([o["shots"] for o in out_points]) if out_points else np.array([0])
    total_shots = int(counts.sum())
    zt = attack + defence + mid or 1

    payload = {
        "input": pj.get("input"),
        "totals": {
            "rallies": len(out_points),
            "total_shots": total_shots,
            "shots_per_rally_median": int(np.median(counts)),
            "shots_per_rally_max": int(counts.max()),
            "longest_rally_point": int(out_points[int(np.argmax(counts))]["point"]) if out_points else None,
        },
        "team_shots": {team_key[k]: v for k, v in team_shots.items()},
        "shot_zone_split": {
            "attack_net_pct": round(100 * attack / zt, 0),
            "mid_pct": round(100 * mid / zt, 0),
            "defence_glass_pct": round(100 * defence / zt, 0),
        },
        "confidence": {
            "shot_count": "HIGH — audio strike detection is high-precision; the count is a floor (very quiet far-end shots can be missed)",
            "serve_shots": "HIGH — the serving player and end come from the validated serve stage (0.94 rotation consistency)",
            "team_attribution_in_rally": "DIRECTIONAL / UNVALIDATED — past the serve, the per-shot end reduces to alternation, whose accuracy measured at chance (0.49) when not anchored. The team split below is a best effort, not a measured result",
            "zone_attack_defence": "DIRECTIONAL — depends on locating the hitter each shot (~0.6 one-of-four); the aggregate split is indicative, individual shots are not reliable",
            "per_player_shots": "NOT PRODUCED — identity is solved only at the serve instant, not frame-by-frame, so which teammate hit a mid-rally shot is not established",
        },
        "points": out_points,
    }
    json.dump(payload, open(args.output, "w"), indent=2)

    if args.debug:
        t = payload["totals"]
        z = payload["shot_zone_split"]
        sys.stderr.write(
            f"match_shots: {t['rallies']} rallies, {t['total_shots']} shots "
            f"(median {t['shots_per_rally_median']}/rally, max {t['shots_per_rally_max']})\n"
            f"match_shots: team shots {payload['team_shots']}\n"
            f"match_shots: zones attack {z['attack_net_pct']:.0f}% / mid {z['mid_pct']:.0f}% "
            f"/ defence {z['defence_glass_pct']:.0f}%\n"
            f"match_shots: shot COUNT is solid; team split {payload['team_shots']} "
            f"and zones are DIRECTIONAL only (no independent ground truth without "
            f"hand-labelling; end attribution measured at chance past the serve)\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"match_shots: unexpected error: {exc}\n")
        sys.exit(1)
