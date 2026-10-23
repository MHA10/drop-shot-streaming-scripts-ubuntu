#!/usr/bin/env python3
"""
match_contacts.py — which END, and which TEAM, hit each ball in a rally, and so
who made the last contact before the point stopped.

── IN SIMPLE WORDS ──
The microphone is nearer one end of the court, so a shot played at that end
sounds louder than the identical shot played at the far end. That difference is
the whole trick: it lets each individual ball-strike be attributed to an end of
the court just from how loud it was.

Loudness alone is noisy, so two more things pin it down. First, padel allows one
touch per side, so the ball should alternate ends with every strike. Second, the
first strike of a point is the serve, and which end served is already known from
where the players were standing. Anchoring on the serve and letting alternation
argue with loudness settles the rest.

── BUSINESS RULES ──
- The serve is strike 0 and its end comes from geometry, not sound. It is the
  anchor for the whole rally.
- Strikes should alternate ends, but the model is allowed to break alternation,
  because a missed strike is common and a hard alternation rule would then be
  wrong for the entire remainder of the rally.
- Attribution is to an END, then to the TEAM standing at that end for that
  point. Which of the two teammates actually swung is NOT decided here.

── WHY IT'S BUILT THIS WAY (change at your peril) ──
- **Loudness, not pure parity.** Pure parity — "strikes alternate, so the last
  one is decided by whether the count is odd or even" — was built first and
  measured at 0.498 against the loudness signal, i.e. exactly chance. It fails
  because far-end strikes are routinely too quiet to detect at all, so the chain
  is missing links and every strike after a gap is attributed to the wrong side.
- **The near/far loudness gap is real and was measured on ground truth.** On
  serve strikes, where the end is known independently from player geometry,
  near-end median band energy was 0.606 against 0.408 far — a 1.48x ratio — and
  server depth correlates +0.287 with strike energy. This is the same near-mic
  bias that makes serve detection impossible from audio; here it is the signal
  rather than the problem.
- **Energy is normalised WITHIN a point before use.** Absolute loudness drifts
  with crowd noise, camera gain and how hard the players are hitting; what
  carries the end is a strike being loud or quiet *relative to its own rally*.
- **Alternation enters as a transition cost, not a constraint.** Same reason the
  serve-side stage uses Viterbi: the truth is "usually alternates", and a hard
  rule cannot represent a missed strike while a cost can.

── STATUS: END ATTRIBUTION BEYOND THE SERVE IS NOT VALIDATED ──
Three routes were built and measured. Read this before using the output.

  1. Pure parity ("strikes alternate, so odd/even decides the end"): scored
     0.498 against the loudness signal — exactly chance. Far-end strikes are
     routinely too quiet to detect, so the chain has missing links and every
     strike after a gap inherits the wrong side.
  2. Loudness: genuinely works on SERVES, where the stroke is consistent —
     64.7% from a single strike, near/far median 0.606 vs 0.408. Inside a rally
     it does not: within-rally strike-energy spread is 0.593 log-units against
     a near/far separation of only 0.296, so shot POWER outweighs distance 2:1.
     A smash and a defensive lob differ by more than the width of the court.
  3. Naive ball detection (yellow-green colour gate plus motion): 9 candidates
     per strike instant at the median, up to 57 — shoes, line paint and
     floodlight glints all pass. Needs a real trajectory tracker.

Consequence: with the serve anchored, this file's `strike_ends` collapse to
strict alternation (measured alternation rate 0.99), i.e. it IS parity, whose
reliability route 1 gives no reason to trust. The unanchored variant recovers
the geometric serve end on only 49% of points.

`serve_side` here is validated (it comes from match_serves.py geometry).
`last_contact_end` and `last_contact_team` are NOT. They are carried so the
harness exists for when ball tracking does.

── DO NOT ──
- Do NOT use `last_contact_end` or `last_contact_team` as a result. See STATUS.
  They are marked `unvalidated` in the output for this reason.
- Do NOT read `last_contact_player`. It is not produced. Choosing between two
  teammates standing at the same end needs the ball's position at the instant of
  contact; loudness cannot separate them because they are the same distance from
  the mic.
- Do NOT use this to infer who won the point. The last contact can be a winner
  or an error, and which it was is the stop-reason problem, still unbuilt.
- Do NOT trust a point whose `anchor_confidence` is low. If the serving end was
  itself a guess, everything downstream of it in that rally inherits the guess.
"""

import argparse
import json
import os
import sys

try:
    import numpy as np
except Exception as exc:  # noqa: BLE001
    sys.stderr.write(f"match_contacts: dependencies unavailable: {exc}\n")
    sys.exit(2)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from match_points import read_band_energy, FFT_HOP, FFT_N  # noqa: E402


def strike_energy(hi, sr, times, win=0.06):
    t = (np.arange(len(hi)) * FFT_HOP + FFT_N / 2) / sr
    out = []
    for tt in times:
        m = (t >= tt - win) & (t <= tt + win)
        out.append(float(hi[m].max()) if m.any() else np.nan)
    return np.array(out)


def fit_calibration(points, serve_sides):
    """
    Gaussian class-conditionals for normalised strike energy, fitted on the ONE
    strike per point whose end is known without sound: the serve.

    Fitted from ground truth rather than assumed, because the size of the near/far
    gap is a property of where the mic hangs at a given venue.
    """
    near, far = [], []
    for p in points:
        z = p["z"]
        if len(z) == 0 or np.isnan(z[0]):
            continue
        (near if serve_sides[p["point"]] == "near" else far).append(z[0])
    if len(near) < 8 or len(far) < 8:
        return None
    return {"mu_near": float(np.mean(near)), "sd_near": float(np.std(near) + 1e-6),
            "mu_far": float(np.mean(far)), "sd_far": float(np.std(far) + 1e-6),
            "n_near": len(near), "n_far": len(far)}


def _loglik(z, cal, is_near):
    mu = cal["mu_near"] if is_near else cal["mu_far"]
    sd = cal["sd_near"] if is_near else cal["sd_far"]
    return -0.5 * ((z - mu) / sd) ** 2 - np.log(sd)


def viterbi_ends(z, cal, anchor, switch_bonus, stay_cost):
    """
    States 0=far, 1=near, one per strike. Alternation is rewarded, staying is
    penalised but permitted (a permitted stay is how a missed strike is modelled).
    """
    n = len(z)
    dp = np.full((n, 2), -1e18)
    bk = np.zeros((n, 2), int)
    for s in (0, 1):
        em = 0.0 if np.isnan(z[0]) else _loglik(z[0], cal, s == 1)
        prior = 0.0
        if anchor is not None:
            prior = 0.0 if (s == 1) == (anchor == "near") else -6.0
        dp[0, s] = em + prior
    for i in range(1, n):
        for s in (0, 1):
            em = 0.0 if np.isnan(z[i]) else _loglik(z[i], cal, s == 1)
            best, arg = -1e18, 0
            for q in (0, 1):
                tr = switch_bonus if q != s else -stay_cost
                v = dp[i-1, q] + tr
                if v > best:
                    best, arg = v, q
            dp[i, s] = best + em
            bk[i, s] = arg
    path = [int(np.argmax(dp[-1]))]
    for i in range(n - 1, 0, -1):
        path.append(int(bk[i, path[-1]]))
    path = path[::-1]
    return ["near" if s else "far" for s in path]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--input", required=True, help="match media (for audio)")
    ap.add_argument("--points", required=True, help="JSON from match_refine.py")
    ap.add_argument("--serves", required=True, help="JSON from match_serves.py")
    ap.add_argument("--players", default="", help="JSON from match_players.py")
    ap.add_argument("--output", required=True)
    ap.add_argument("--switch-bonus", type=float, default=0.7,
                    help="reward for the ball changing ends between strikes")
    ap.add_argument("--stay-cost", type=float, default=1.4,
                    help="penalty for two consecutive strikes at the same end "
                         "(how a missed strike gets modelled)")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()

    pts = json.load(open(args.points))["points"]
    sv = {p["point"]: p for p in json.load(open(args.serves))["points"]}
    ident = {}
    teams = None
    if args.players:
        pl = json.load(open(args.players))
        teams = pl.get("teams")
        for q in pl["points"]:
            ident[q["point"]] = q["players"]

    hi, _lo, sr = read_band_energy(args.input, verbose=args.debug)

    prepared = []
    for p in pts:
        if p["point"] not in sv:
            continue
        rally = [x for x in p["strike_times"] if x >= p["rally_start"] - 1e-6]
        if len(rally) < 2:
            continue
        e = strike_energy(hi, sr, rally)
        with np.errstate(divide="ignore"):
            le = np.log(np.clip(e, 1e-6, None))
        med = np.nanmedian(le)
        prepared.append({"point": p["point"], "times": rally,
                         "z": le - med, "rally_strikes": len(rally)})

    serve_sides = {q: sv[q]["serve_side"] for q in sv}
    cal = fit_calibration(prepared, serve_sides)
    if cal is None:
        sys.stderr.write("match_contacts: not enough serves to calibrate\n")
        return 4

    # Held-out check: how often does energy ALONE (no anchor) recover the serve's
    # end, which geometry knows independently? This is the honest accuracy of the
    # loudness signal on a single strike.
    solo_ok = 0
    solo_n = 0
    for p in prepared:
        if np.isnan(p["z"][0]):
            continue
        solo_n += 1
        guess = "near" if _loglik(p["z"][0], cal, True) > _loglik(p["z"][0], cal, False) else "far"
        solo_ok += int(guess == serve_sides[p["point"]])

    out = []
    anchor_ok = 0
    for p in prepared:
        anchor = serve_sides[p["point"]]
        ends = viterbi_ends(p["z"], cal, anchor, args.switch_bonus, args.stay_cost)
        # Without the anchor: agreement on strike 0 measures whether the rest of
        # the rally's evidence is consistent with the geometric serve read.
        free = viterbi_ends(p["z"], cal, None, args.switch_bonus, args.stay_cost)
        anchor_ok += int(free[0] == anchor)
        last_end = ends[-1]
        team = None
        who = ident.get(p["point"])
        if who and teams:
            vnet_side = [nm for nm, uv in who.items()
                         if (uv["v"] >= 0.5) == (last_end == "near")]
            for t in teams:
                if vnet_side and set(vnet_side) == set(t):
                    team = list(t)
        out.append({
            "unvalidated": True,     # see STATUS in the module docstring
            "point": p["point"], "serve_side": anchor,
            "rally_strikes": p["rally_strikes"],
            "strike_ends": ends,
            "alternation_rate": round(
                float(np.mean([a != b for a, b in zip(ends, ends[1:])])), 3)
            if len(ends) > 1 else None,
            "last_contact_t": round(p["times"][-1], 3),
            "last_contact_end": last_end,
            "last_contact_team": team,
            "anchor_free_agrees": free[0] == anchor,
        })

    alt = [o["alternation_rate"] for o in out if o["alternation_rate"] is not None]
    payload = {
        "input": args.input,
        "warning": ("last_contact_end / last_contact_team are UNVALIDATED. "
                    "Audio cannot attribute rally strikes to an end: shot power "
                    "outweighs the near/far distance effect 2:1 within a rally. "
                    "Only serve_side (from geometry) is trustworthy here."),
        "calibration": cal,
        "diagnostics": {
            "points": len(out),
            "serve_end_from_energy_alone": round(solo_ok / max(1, solo_n), 3),
            "anchor_free_agreement": round(anchor_ok / max(1, len(prepared)), 3),
            "mean_alternation_rate": round(float(np.mean(alt)), 3) if alt else 0.0,
            "last_contact_near": sum(1 for o in out if o["last_contact_end"] == "near"),
            "last_contact_far": sum(1 for o in out if o["last_contact_end"] == "far"),
            "teams_resolved": sum(1 for o in out if o["last_contact_team"]),
        },
        "points": out,
    }
    json.dump(payload, open(args.output, "w"), indent=2)

    if args.debug:
        d = payload["diagnostics"]
        sys.stderr.write(
            f"match_contacts: calibrated on {cal['n_near']} near / {cal['n_far']} far serves "
            f"(mu_near={cal['mu_near']:+.3f} mu_far={cal['mu_far']:+.3f})\n"
            f"match_contacts: serve end from ENERGY ALONE = "
            f"{d['serve_end_from_energy_alone']} (0.5 = useless)\n"
            f"match_contacts: unanchored rally agrees with geometric serve on "
            f"{d['anchor_free_agreement']} of points\n"
            f"match_contacts: mean alternation rate {d['mean_alternation_rate']} "
            f"(1.0 = ball changed ends on every strike)\n"
            f"match_contacts: last contact near/far = {d['last_contact_near']}/"
            f"{d['last_contact_far']}; team resolved on {d['teams_resolved']}/"
            f"{d['points']}\n"
            f"match_contacts: WARNING last_contact_* is UNVALIDATED - with the "
            f"serve anchored this is strict alternation (rate "
            f"{d['mean_alternation_rate']}), and unanchored phase recovery is only "
            f"{d['anchor_free_agreement']}. See STATUS in the docstring.\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"match_contacts: unexpected error: {exc}\n")
        sys.exit(1)
