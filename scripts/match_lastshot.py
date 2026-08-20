#!/usr/bin/env python3
"""
match_lastshot.py — who hit each ball, and so who made the last contact before
the point stopped, from how hard each player's body moves at the instant of the
strike.

── IN SIMPLE WORDS ──
Audio says exactly WHEN the ball was hit. It cannot say by whom. But at that
instant the striker is swinging and the other three are not, so the striker's
outline changes far more between consecutive frames than anyone else's. This
measures that: for each of the four players, how much do their own pixels move
in the ~100 ms around the strike. The biggest mover hit the ball.

One player's swing is a noisy vote on its own, so two rulebook facts tighten it.
The ball can only be touched once per side, so strikes should alternate ends;
and the first strike of a point is the serve, whose end is already known from
where the players were standing. Anchor on the serve, let alternation argue with
the motion evidence, and the whole rally resolves.

── BUSINESS RULES ──
- Attribution is per STRIKE, from which the last contact of the point follows.
- The serve is the anchor: its end comes from player geometry, not motion.
- Report a player AND an end. The end is the better-supported of the two,
  because it pools two players' evidence against the other two.

── WHY IT'S BUILT THIS WAY (change at your peril) ──
- **Motion is measured inside the player's own segmentation mask, dilated.** The
  dilation is what catches the paddle and the swinging arm, which travel outside
  the body outline and carry most of the signal. Measured on serves, where the
  striker is known independently, the biggest-mover rule alone picks the right
  player 60% of the time against a 25% chance baseline.
- **A ~100 ms window, not seconds.** Two earlier motion features measured
  displacement over whole rallies and both failed outright — one had no
  separation, the other separated backwards, because between-point walking is as
  much motion as a rally. A swing is a sub-100 ms event; the window has to match
  the event.
- **Frames are decoded once per point through a rolling buffer.** Seeking ffmpeg
  separately for every strike costs a fresh decode each time, and a match has
  ~600 strikes.
- **Loudness is deliberately NOT used to pick the end.** It is a real cue on
  serves (near/far 1.48x, because every serve is the same stroke) but useless
  inside a rally: within-rally strike energy varies by 0.593 log-units against a
  0.296 near/far separation, so shot power beats distance 2:1.

── STATUS: THE PLAYER PICK WORKS, THE END DOES NOT ──
Measured over 102 points of the reference match:

  * Given the correct end, picking WHICH of that end's two players swung:
    **0.775**. Chance is 0.5, because the serve's end is supplied by geometry
    and the choice is therefore one-of-two, not one-of-four. This is the part
    that works, and it is the first thing that has worked at all for this
    question.
  * Determining the end of a strike from motion, unanchored: **0.49** — chance.
    (It scored 0.68 on the first 25 points, which was small-sample noise; the
    full match says otherwise.)

So `last_contact_box` is a player chosen inside an end that cannot be
established. With the serve anchored, the ends collapse to alternation
(measured rate 0.963) — i.e. parity, whose reliability is unestablished and
which measured at chance in match_contacts.py.

Net: this file solves "which of these two players swung" and does NOT solve
"which end did the ball come from". Closing the second needs ball tracking.

── DO NOT ──
- Do NOT quote `last_contact_box` as the last striker. The player pick is sound
  only if the end is right, and the end is not established. See STATUS.
- Do NOT expect the LAST strike to be as reliable as the serve. The only anchor
  is at the START of the rally, so error accumulates along it and the final
  strike is the furthest point from any ground truth. `serve_recovery` in the
  diagnostics is measured where truth exists; treat it as a ceiling, not as the
  accuracy of the last contact.
- Do NOT use this to infer who won the point. A last contact can be a winner or
  an error; which it was is the stop-reason problem, still unbuilt.
- Do NOT trust a strike whose `margin` is near zero. That means two players
  moved equally and the pick was arbitrary.
"""

import argparse
import json
import os
import subprocess
import sys

try:
    import cv2
    import numpy as np
except Exception as exc:  # noqa: BLE001
    sys.stderr.write(f"match_lastshot: dependencies unavailable: {exc}\n")
    sys.exit(2)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from track_players import calibrate  # noqa: E402

HALF = 4          # frames either side of a strike


def _iou(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0.0, x2 - x1), max(0.0, y2 - y1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    return inter / max(1e-6, (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1]) - inter)


def stream(video, t0, dur, w, h):
    cmd = ["ffmpeg", "-v", "error", "-ss", f"{t0:.3f}", "-t", f"{dur:.3f}", "-i", video,
           "-vf", f"scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    n = w * h * 3
    while True:
        buf = p.stdout.read(n)
        if not buf or len(buf) < n:
            break
        yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    p.stdout.close()
    p.wait()


def swing_scores(buf, centre_bgr, model, v_net, court, scale, dilate=15,
                 band="upper", stat="p99"):
    """
    Motion energy per player inside their own dilated mask, over the buffer.

    Returns [(u, v, score, box)] — one entry per detected player.
    """
    r = model.predict(centre_bgr, classes=[0], conf=0.25, imgsz=1280,
                      device="mps" if sys.platform == "darwin" else None,
                      retina_masks=True, verbose=False)[0]
    if r.masks is None:
        return []
    boxes = r.boxes.xyxy.tolist()
    masks = r.masks.data.cpu().numpy()
    grays = [cv2.cvtColor(f, cv2.COLOR_BGR2GRAY).astype(np.float32) for f in buf]
    ker = np.ones((dilate, dilate), np.uint8)
    out = []
    for k, bb in enumerate(boxes):
        foot = ((bb[0] + bb[2]) / 2.0 / scale, bb[3] / scale)
        u, v = court.uv(*foot)
        if not (-0.15 <= u <= 1.15 and -0.1 <= v <= 1.1):
            continue
        m = masks[k]
        if m.shape[:2] != centre_bgr.shape[:2]:
            m = cv2.resize(m.astype(np.float32),
                           (centre_bgr.shape[1], centre_bgr.shape[0]))
        m = cv2.dilate((m > 0.5).astype(np.uint8), ker)
        if band == "upper":
            # The swing is an arm-and-paddle event. Legs churn constantly while a
            # player runs, so including them buries the swing in gait noise.
            ys = np.where(m.any(axis=1))[0]
            if len(ys):
                cut = ys.min() + int(0.60 * (ys.max() - ys.min() + 1))
                m = m.copy()
                m[cut:, :] = 0
        area = max(1, int(m.sum()))
        if area < 30:
            continue
        sel = m > 0
        peak = 0.0
        for i in range(1, len(grays)):
            d = np.abs(grays[i] - grays[i-1])
            if stat == "p99":
                # A swing concentrates change in a few pixels; a mean over the
                # whole mask dilutes it with the still parts of the body.
                peak = max(peak, float(np.percentile(d[sel], 99)))
            else:
                peak = max(peak, float(d[sel].mean()))
        out.append({"u": float(u), "v": float(v), "score": peak,
                    "box": [float(x) / scale for x in bb]})
    return out


def viterbi(obs, anchor, switch_bonus, stay_cost, strength=2.5):
    """States 0=far, 1=near. obs[i] = P(near) in 0..1, or None."""
    n = len(obs)
    dp = np.full((n, 2), -1e18)
    bk = np.zeros((n, 2), int)

    def em(o, s):
        if o is None:
            return 0.0
        p = o if s == 1 else 1.0 - o
        return strength * float(np.log(np.clip(p, 0.08, 0.92)))

    for s in (0, 1):
        pri = 0.0 if anchor is None else (0.0 if (s == 1) == (anchor == "near") else -6.0)
        dp[0, s] = em(obs[0], s) + pri
    for i in range(1, n):
        for s in (0, 1):
            best, arg = -1e18, 0
            for q in (0, 1):
                v = dp[i-1, q] + (switch_bonus if q != s else -stay_cost)
                if v > best:
                    best, arg = v, q
            dp[i, s] = best + em(obs[i], s)
            bk[i, s] = arg
    path = [int(np.argmax(dp[-1]))]
    for i in range(n - 1, 0, -1):
        path.append(int(bk[i, path[-1]]))
    return ["near" if s else "far" for s in path[::-1]]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--input", required=True, help="letterbox-stripped match video")
    ap.add_argument("--points", required=True, help="JSON from match_refine.py")
    ap.add_argument("--serves", required=True, help="JSON from match_serves.py")
    ap.add_argument("--output", required=True)
    ap.add_argument("--seg-model", default="tools/reels/models/yolo11s-seg.pt")
    ap.add_argument("--proc-width", type=int, default=1280)
    ap.add_argument("--switch-bonus", type=float, default=0.6)
    ap.add_argument("--stay-cost", type=float, default=1.2)
    ap.add_argument("--band", default="full", choices=["upper", "full"],
                    help="swept on the reference match; upper-body-only did not "
                         "beat the full mask, so the simpler option is the default")
    ap.add_argument("--stat", default="p99", choices=["p99", "mean"])
    ap.add_argument("--dilate", type=int, default=15)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()

    pts = json.load(open(args.points))["points"]
    sv = {p["point"]: p for p in json.load(open(args.serves))["points"]}
    court, note = calibrate(args.input, [90, 40, 40], [130, 255, 255])
    if court is None:
        sys.stderr.write(f"match_lastshot: calibration failed ({note})\n")
        return 3
    from ultralytics import YOLO
    model = YOLO(args.seg_model)

    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                            "-show_entries", "stream=width,height,r_frame_rate",
                            "-of", "default=nw=1:nk=1", args.input],
                           capture_output=True, text=True).stdout.split()
    sw, sh = int(probe[0]), int(probe[1])
    num, den = probe[2].split("/")
    fps = float(num) / float(den)
    W = args.proc_width
    H = int(round(sh * W / sw)) // 2 * 2
    scale = W / sw

    todo = pts[:args.limit] if args.limit else pts
    out = []
    serve_ok = serve_n = 0
    end_ok = end_n = 0
    for idx, p in enumerate(todo):
        q = sv.get(p["point"])
        if not q:
            continue
        rally = [x for x in p["strike_times"] if x >= p["rally_start"] - 1e-6]
        if len(rally) < 2:
            continue
        t0 = max(0.0, rally[0] - (HALF + 1) / fps)
        dur = (rally[-1] + (HALF + 2) / fps) - t0
        want = [int(round((st - t0) * fps)) for st in rally]

        buf, per_strike = [], {}
        for fi, fr in enumerate(stream(args.input, t0, dur, W, H)):
            buf.append(fr)
            if len(buf) > 2 * HALF + 1:
                buf.pop(0)
            centre_i = fi - HALF
            if centre_i in want and len(buf) == 2 * HALF + 1:
                per_strike[centre_i] = swing_scores(
                    buf, buf[HALF], model, court.v_net, court, scale,
                    dilate=args.dilate, band=args.band, stat=args.stat)
        obs, players = [], []
        for k in want:
            ps = per_strike.get(k, [])
            players.append(ps)
            if len(ps) < 2:
                obs.append(None)
                continue
            near = sum(x["score"] for x in ps if x["v"] >= court.v_net)
            far = sum(x["score"] for x in ps if x["v"] < court.v_net)
            obs.append(None if (near + far) <= 0 else near / (near + far))

        ends = viterbi(obs, q["serve_side"], args.switch_bonus, args.stay_cost)
        free = viterbi(obs, None, args.switch_bonus, args.stay_cost)
        if obs and obs[0] is not None:
            end_n += 1
            end_ok += int(free[0] == q["serve_side"])

        strikes = []
        for i, (st, ps, e) in enumerate(zip(rally, players, ends)):
            side = [x for x in ps if (x["v"] >= court.v_net) == (e == "near")]
            side.sort(key=lambda x: -x["score"])
            who = side[0] if side else None
            margin = (side[0]["score"] - side[1]["score"]) if len(side) > 1 else None
            strikes.append({
                "t": round(st, 3), "end": e,
                "u": None if not who else round(who["u"], 3),
                "v": None if not who else round(who["v"], 3),
                "box": None if not who else [round(x, 1) for x in who["box"]],
                "margin": None if margin is None else round(margin, 2),
            })
        # ground truth exists for the serve only
        if q.get("server") and strikes:
            serve_n += 1
            b = q["server"]["box"]
            s0 = strikes[0]
            if s0["box"]:
                d_srv = abs((b[0]+b[2])/2 - (s0["box"][0]+s0["box"][2])/2)
                serve_ok += int(d_srv < 0.06 * sw)
        out.append({"point": p["point"], "serve_side": q["serve_side"],
                    "strikes": strikes,
                    "last_contact_t": strikes[-1]["t"] if strikes else None,
                    "last_contact_end": strikes[-1]["end"] if strikes else None,
                    "last_contact_box": strikes[-1]["box"] if strikes else None,
                    "last_contact_margin": strikes[-1]["margin"] if strikes else None,
                    "alternation_rate": round(float(np.mean(
                        [a != b for a, b in zip(ends, ends[1:])])), 3) if len(ends) > 1 else None})
        if args.debug and (idx + 1) % 10 == 0:
            sys.stderr.write(f"match_lastshot: {idx+1}/{len(todo)} points\n")

    alt = [o["alternation_rate"] for o in out if o["alternation_rate"] is not None]
    payload = {
        "input": args.input,
        "diagnostics": {
            "points": len(out),
            "serve_recovery": round(serve_ok / max(1, serve_n), 3),
            "serve_n": serve_n,
            "unanchored_end_agreement": round(end_ok / max(1, end_n), 3),
            "mean_alternation_rate": round(float(np.mean(alt)), 3) if alt else 0.0,
        },
        "warning": ("The player pick works (0.775 given the correct end, chance "
                    "0.5). The END does not: unanchored end agreement is 0.49, "
                    "i.e. chance. last_contact_box is therefore a sound pick "
                    "inside an unestablished end - do not quote it as the last "
                    "striker. Ball tracking is what closes this."),
        "points": out,
    }
    json.dump(payload, open(args.output, "w"), indent=2)
    if args.debug:
        d = payload["diagnostics"]
        sys.stderr.write(
            f"match_lastshot: {d['points']} points\n"
            f"match_lastshot: given the anchored end, correct player on "
            f"{d['serve_recovery']} of {d['serve_n']} serves (chance 0.5 - it is a "
            f"one-of-two choice once the end is known)\n"
            f"match_lastshot: unanchored end agrees with geometry on "
            f"{d['unanchored_end_agreement']}\n"
            f"match_lastshot: mean alternation rate {d['mean_alternation_rate']}\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"match_lastshot: unexpected error: {exc}\n")
        sys.exit(1)
