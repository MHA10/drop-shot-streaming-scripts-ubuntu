#!/usr/bin/env python3
"""
track_players.py — label the four padel players A/B/C/D and render a tracking
overlay: per-player box + tag + motion trail, plus a top-down court radar.

── IN SIMPLE WORDS ──
Point this at a rally clip and it works out which blob is which human, gives
each one a permanent letter, and draws it back onto the video. The letters are
handed out once, at the start, by where the player is standing: top-left of the
frame is A, top-right is B, bottom-left is C, bottom-right is D. After that the
letter belongs to the *person*, not the corner — if C sprints across to the
right side, they are still C. Bottom-left of the picture also gets a little
top-down map of the court with four dots on it, like a radar, so you can see
the formation without reading the perspective.

This is the ML sibling of `reframe_ball.py`. That one asks "where is the
motion?" and pans a crop at it. This one asks "who is who, and where are they
standing on the court?" — a question background subtraction cannot answer.

── BUSINESS RULES ──
- Exactly four players. Padel is 2v2, the cardinality is fixed, and the tool
  leans on that: four permanent slots, always four tags on screen (see the
  slot-tracker note below).
- Letters are assigned ONCE, on the lock-in frame, by frame quadrant —
  top-left=A, top-right=B, bottom-left=C, bottom-right=D (decision 2026-08-17,
  chosen over per-frame quadrant re-assignment so tags do not swap mid-rally
  when players cross).
- Quadrants are measured in IMAGE space, not court space. The spec is literally
  "top left of the picture", and image space keeps that true no matter which end
  the camera is bolted to.
- The radar is a FORMATION view, not a metrology tool — it answers "who is up,
  who is back, who covers which side", and deliberately does not claim metres.
  See CourtModel for the measurement that would be needed and why this camera
  cannot support it.
- Marketing/analysis tool. Runs on a laptop, NOT on a streamer box — see the
  DO NOT section.

── WHY IT'S BUILT THIS WAY (change at your peril) ──
- **Four fixed slots, not tracker IDs.** ByteTrack/BoTSORT mint a NEW id when a
  player is occluded behind another or clipped by the frame edge — and a new id
  means a new letter, so the tags renumber themselves mid-rally, which is the
  one thing the whole tool exists to prevent. Instead: four slots that live for
  the whole clip, each frame's detections assigned to them by brute-force
  optimal matching over all permutations (<=4 items, 24 permutations — exact,
  and cheaper than importing scipy for a Hungarian solver). A slot with no
  detection nearby coasts on its last velocity and draws dimmed rather than
  disappearing.
- **A gate on match distance.** Without `--max-jump-frac`, a slot will happily
  snap onto a line judge or a spectator behind the glass the moment its own
  player is occluded, and then it never comes back. The gate makes a bad match
  impossible rather than merely unlikely — an unmatched slot coasts instead.
- **Detections are filtered to the court polygon.** The camera sees the terrace,
  the next court and people behind the glass. Without the polygon filter YOLO
  returns 6-10 people on a busy night and the four slots latch onto spectators.
- **Two passes: detect everything, then render.** Positions are smoothed and
  gaps interpolated across the WHOLE clip before a single frame is drawn. A
  causal (single-pass) smoother can only look backwards, so it lags the player
  by its own window length and the box trails visibly behind them.
- **Calibration comes from a median frame, not a single frame.** Players stand
  on the blue surface; on any one frame they punch person-shaped holes in the
  court mask and dent the hull. The pixelwise median over sampled frames erases
  anything that moved, leaving an empty court.
- **The net's BOTTOM cord marks the halfway line, not its darkest row.** A
  padel net reads as two dark cords with translucent mesh between them, and the
  darkest row by far is the top tape — ~40 px above the floor contact on this
  footage. Anchoring on the tape puts the net line too far up the image and
  drags every radar dot toward the far end.

── DO NOT ──
- Do NOT wire this into the live streamer pipeline. It pulls torch +
  ultralytics (~2 GB installed) and runs far slower than real time on a
  low-power box. `reframe_ball.py` is the one that ships; this one does not.
- Do NOT re-assign letters per frame "to keep them tidy". That is the rejected
  design; it makes tags swap every time players cross.
- Do NOT trust the auto-calibration blindly on a new court. Always look at the
  `--calib-debug` image: it draws the fitted sidelines, the net and the depth
  grid back onto the frame, and a bad fit is obvious there and invisible in the
  radar.
- Do NOT assume the auto-calibration works on a court whose surface is not
  blue-ish — the court finder is an HSV gate on the playing surface. Green and
  terracotta courts need a re-tuned `--court-hsv`, or a saved `--court-json`.
- Do NOT read distances off the radar, or add metre ticks to it. See CourtModel.
- Do NOT feed this a clip where players are still walking on between points;
  the lock-in frame would hand out letters to whoever happens to be standing in
  each quadrant. Lock in during live play (`--lock-sec` defaults into the
  rally, not frame 0).
"""

import argparse
import itertools
import json
import sys
from collections import deque

try:
    import cv2
    import numpy as np
except Exception as exc:  # noqa: BLE001
    sys.stderr.write(f"track_players: dependencies unavailable: {exc}\n")
    sys.exit(2)


# ── court model ──
# The radar is a FORMATION view, not a metrology tool. See CourtModel for why
# this stops short of a metric homography on these cameras.
LABELS = ("A", "B", "C", "D")
# BGR. Picked to stay separable against a blue court under yellow floodlights.
COLORS = {
    "A": (56, 168, 255),    # amber
    "B": (255, 196, 0),     # teal
    "C": (222, 82, 255),    # magenta
    "D": (98, 232, 127),    # mint
}


class CourtModel:
    """
    Where a foot pixel sits on the court, in normalised court coordinates:
    u across (0 = left sideline, 1 = right sideline) and v along (0 = far edge
    of the visible court, 1 = near edge), with the net at `v_net`.

    ── WHY NOT A METRIC HOMOGRAPHY (change at your peril) ──
    The obvious design is image->metres via a 4-point homography onto a 10x20 m
    court, and it was tried first. It does not survive contact with these
    cameras, for two reasons that compound:
      1. The near baseline is BELOW the frame on this mount, so the fourth
         correspondence has to be inferred rather than seen.
      2. The lens is a wide-angle with real barrel distortion — the far
         baseline bows up ~14 px at mid-court and the near service line bows
         down ~40 px. A planar homography cannot represent a curve, so the
         residual lands wherever the fit feels like putting it.
    Fitted against the landmarks that ARE visible (far court edge, net cords,
    service lines) the depth scale came out inconsistent by ~10% depending on
    which pair of landmarks anchored it, and some anchor pairs placed the near
    baseline behind the camera. A radar built on that would render confident
    metre-accurate-looking dots that are simply wrong.
    So: measure only what the image actually shows.
      - `u` is EXACT. The sidelines are fitted straight lines over the full
        depth of the mask and they track the real court edges to a couple of
        pixels.
      - `v` is exact in RELATIVE terms. 1/width is affine in camera depth for
        any pinhole, so equal steps in v are equal steps in metres — the scale
        is anchored to the visible court rather than to a 20 m baseline.
    Net effect: "who is up, who is back, who covers which side" is right, and
    the tool never claims a distance in metres.
    """

    def __init__(self, mL, bL, mR, bR, y_top, y_bot, y_net):
        self.mL, self.bL, self.mR, self.bR = mL, bL, mR, bR
        self.y_top, self.y_bot, self.y_net = y_top, y_bot, y_net
        self.s_top, self.s_bot = self._s(y_top), self._s(y_bot)
        self.v_net = self.v_of_y(y_net)

    def sides(self, y):
        return self.mL * y + self.bL, self.mR * y + self.bR

    def _s(self, y):
        """1/court-width at row y — affine in camera depth, so linear in metres."""
        xl, xr = self.sides(y)
        return 1.0 / max(1.0, xr - xl)

    def v_of_y(self, y):
        den = self.s_top - self.s_bot
        if abs(den) < 1e-12:
            return 0.0
        return (self.s_top - self._s(y)) / den

    def uv(self, x, y):
        xl, xr = self.sides(y)
        u = (x - xl) / max(1.0, xr - xl)
        return u, self.v_of_y(y)

    def polygon(self, margin_u=0.03, margin_far=0.01, margin_near=0.03):
        """
        Detection filter: the fitted court plus a small tolerance.

        Margins are TIGHT on purpose. A padel court is enclosed — the glass and
        the mesh are the boundary, so a player physically cannot stand outside
        it and any generous margin buys nothing but false positives. It costs
        real tracks: at a 12% margin the right-hand edge reached past the side
        glass into the seating, and slot C spent a third of the reference rally
        boxing a spectator while the actual player went untagged. The remaining
        few percent is tolerance for the line fit and for YOLO putting a box
        bottom slightly under the feet.
        """
        pts = []
        y_lo = self.y_top - margin_far * (self.y_bot - self.y_top)
        y_hi = self.y_bot + margin_near * (self.y_bot - self.y_top)
        for y in (y_lo, y_hi):
            xl, xr = self.sides(y)
            w = xr - xl
            pts.append((xl - margin_u * w, y, xr + margin_u * w))
        return np.array([[pts[0][0], pts[0][1]], [pts[0][2], pts[0][1]],
                         [pts[1][2], pts[1][1]], [pts[1][0], pts[1][1]]], np.int32)


def median_frame(path, samples=9):
    """Empty-court frame: pixelwise median kills anything that moved."""
    cap = cv2.VideoCapture(path)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    frames = []
    if total > 1:
        for i in range(samples):
            cap.set(cv2.CAP_PROP_POS_FRAMES, int(total * (i + 0.5) / samples))
            ok, f = cap.read()
            if ok:
                frames.append(f)
    else:
        while len(frames) < samples:
            ok, f = cap.read()
            if not ok:
                break
            frames.append(f)
    cap.release()
    if not frames:
        return None
    return np.median(np.stack(frames), axis=0).astype(np.uint8)


def court_hull(med, hsv_lo, hsv_hi):
    """Convex hull of the playing surface, via an HSV gate on the court colour."""
    hsv = cv2.cvtColor(med, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, np.array(hsv_lo, np.uint8), np.array(hsv_hi, np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return None, 0.0
    c = max(cnts, key=cv2.contourArea)
    frac = cv2.contourArea(c) / float(med.shape[0] * med.shape[1])
    filled = np.zeros(mask.shape, np.uint8)
    cv2.drawContours(filled, [cv2.convexHull(c)], -1, 255, -1)
    return filled, frac


def _fit_side(pts):
    """
    x as a function of y, refit twice against residuals.

    Fitted x=f(y) rather than y=f(x) because sidelines are steep — near
    vertical in the image — and the usual orientation is ill-conditioned there.
    The refit drops rows where the mask is eaten by the near-end structure in
    the bottom corners; left in, those rows drag the whole sideline inwards.
    """
    x = pts[:, 0].astype(float)
    y = pts[:, 1].astype(float)
    for _ in range(3):
        m, b = np.polyfit(y, x, 1)
        r = np.abs(x - (m * y + b))
        keep = r < max(2.0, 2.0 * r.std())
        if keep.sum() < 20:
            break
        x, y = x[keep], y[keep]
    return np.polyfit(y, x, 1)


def _find_net(med, filled, mL, bL, mR, bR, y_top, y_bot):
    """
    The net's GROUND line — where the mesh meets the floor, not its dark tape.

    A padel net reads as TWO dark cords with translucent mesh between them: the
    top tape (very dark, the global minimum) and the bottom cord sitting on the
    floor. The floor contact is the one that marks the halfway line; taking the
    tape instead puts the net ~40 px too far up the image and pulls every
    radar dot toward the far end.
    """
    gray = cv2.cvtColor(med, cv2.COLOR_BGR2GRAY).astype(float)
    ys, vals = [], []
    for y in range(int(y_top) + 4, int(y_top + (y_bot - y_top) * 0.65)):
        xl, xr = mL * y + bL, mR * y + bR
        a, b = int(xl + 0.12 * (xr - xl)), int(xr - 0.12 * (xr - xl))
        if b - a < 40 or y >= gray.shape[0]:
            continue
        ys.append(y)
        vals.append(gray[y, a:b].mean())
    if len(ys) < 40:
        return None
    ys = np.array(ys)
    vals = np.array(vals)
    bg = np.convolve(np.pad(vals, 50, mode="edge"), np.ones(101) / 101, mode="valid")
    dark = bg - vals
    i_tape = int(np.argmax(dark))
    peak = float(dark[i_tape])
    if peak < 12:
        return None
    # Bottom cord: strongest secondary dark peak within a net-height window
    # below the tape. The window is scaled off court width so it holds at any
    # zoom level.
    span = int(max(12, 0.09 * (y_bot - y_top)))
    lo, hi = i_tape + 3, min(len(ys) - 1, i_tape + span)
    if hi <= lo:
        return float(ys[i_tape])
    j = lo + int(np.argmax(dark[lo:hi + 1]))
    if dark[j] < 0.15 * peak:
        return float(ys[i_tape])
    return float(ys[j])


def calibrate(video, hsv_lo, hsv_hi, debug_path="", med=None):
    """Build a CourtModel from an empty-court median frame."""
    if med is None:
        med = median_frame(video)
    if med is None:
        return None, "could not read frames"
    filled, frac = court_hull(med, hsv_lo, hsv_hi)
    if filled is None or frac < 0.05:
        return None, f"no court-coloured region found (largest={frac:.3f})"

    rows = []
    for y in range(filled.shape[0]):
        r = np.where(filled[y] > 0)[0]
        if len(r) > 30:
            rows.append((y, r.min(), r.max()))
    if len(rows) < 60:
        return None, "court region too small to fit sidelines"
    rows = np.array(rows)
    y_top, y_bot = float(rows[0, 0]), float(rows[-1, 0])
    # Fit over the middle of the depth range only: the top few rows are the
    # distortion-bowed baseline and the bottom rows are clipped by the frame
    # edge and the near-end structure.
    band = rows[(rows[:, 0] > y_top + 20) & (rows[:, 0] < y_top + (y_bot - y_top) * 0.85)]
    if len(band) < 40:
        band = rows
    mL, bL = _fit_side(np.stack([band[:, 1], band[:, 0]], 1))
    mR, bR = _fit_side(np.stack([band[:, 2], band[:, 0]], 1))
    if (mR * y_top + bR) - (mL * y_top + bL) < 30:
        return None, "sideline fit degenerate"

    y_net = _find_net(med, filled, mL, bL, mR, bR, y_top, y_bot)
    if y_net is None:
        return None, "net line not found"

    court = CourtModel(mL, bL, mR, bR, y_top, y_bot, y_net)
    if debug_path:
        _write_calib_debug(med, court, debug_path)
    return court, (f"court rows {int(y_top)}-{int(y_bot)}, net y={int(y_net)} "
                   f"(v={court.v_net:.2f})")


def _write_calib_debug(med, court, path):
    """Draw the fitted model back onto the frame. A bad fit is obvious here."""
    vis = med.copy()
    for y in range(int(court.y_top), int(court.y_bot) + 1):
        xl, xr = court.sides(y)
        cv2.circle(vis, (int(xl), y), 1, (0, 255, 0), -1)
        cv2.circle(vis, (int(xr), y), 1, (0, 255, 0), -1)
    for y, col, lbl in ((court.y_top, (0, 255, 0), "far edge  v=0.00"),
                        (court.y_net, (0, 0, 255), f"net       v={court.v_net:.2f}"),
                        (court.y_bot, (0, 255, 0), "near edge v=1.00")):
        xl, xr = court.sides(y)
        cv2.line(vis, (int(xl), int(y)), (int(xr), int(y)), col, 2)
        cv2.putText(vis, lbl, (int(xr) + 8, int(y)), cv2.FONT_HERSHEY_SIMPLEX,
                    0.5, col, 1, cv2.LINE_AA)
    # v gridlines every 0.1 — even metric spacing, so uneven pixel spacing here
    # is the perspective doing its job, not a bug.
    for k in range(1, 10):
        target = k / 10.0
        s = court.s_top - target * (court.s_top - court.s_bot)
        lo, hi = court.y_top, court.y_bot
        for _ in range(40):
            mid = (lo + hi) / 2
            if court._s(mid) > s:
                lo = mid
            else:
                hi = mid
        y = (lo + hi) / 2
        xl, xr = court.sides(y)
        cv2.line(vis, (int(xl), int(y)), (int(xr), int(y)), (200, 200, 0), 1)
    cv2.polylines(vis, [court.polygon()], True, (0, 165, 255), 2)
    cv2.imwrite(path, vis)


# ──────────────────────────────────────────────────────────────────────────
# detection + four-slot tracking
# ──────────────────────────────────────────────────────────────────────────

def _iou(a, b):
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / max(1e-6, ua)


def _dedupe(dets, iou_thresh=0.45):
    """
    Collapse multiple boxes on the same person into one.

    YOLO's own NMS does not always do this on the far pair: at ~50 px tall,
    two players standing close return three heavily-overlapping boxes with
    different extents, all above threshold. The tracker treats each as a
    separate person, so two slots latch onto what is physically one player and
    the other player goes untagged for the rest of the rally. Measured on the
    reference clip this was the single biggest cause of lost tracks.
    """
    keep = []
    for d in sorted(dets, key=lambda d: -d["conf"]):
        if all(_iou(d["box"], k["box"]) < iou_thresh for k in keep):
            keep.append(d)
    return keep


def _plausible_size(d, court, frame_w, frame_h):
    """
    Is this box the right size for a person standing at that depth?

    A padel player is ~1.75 m against a 10 m court width, so the expected box
    height is ~0.175x the court's pixel width at the player's own row. On the
    reference clip real detections cluster tightly around that (p5-p95 spans
    0.77-1.16), which makes it a cheap, principled way to reject reflections in
    the glass and half-lit background objects.

    Boxes touching a frame edge are EXEMPT: a player walking out of the bottom
    of frame is truncated to ~0.5x expected, and they are still the player.
    """
    if court is None:
        return True
    x1, y1, x2, y2 = d["box"]
    if x1 <= 4 or y1 <= 4 or x2 >= frame_w - 4 or y2 >= frame_h - 4:
        return True
    xl, xr = court.sides(d["foot"][1])
    expected = 0.175 * (xr - xl)
    if expected <= 1:
        return True
    return 0.55 <= (y2 - y1) / expected <= 1.5


def _static_people(med, model, imgsz, device):
    """
    People who never moved during the clip — spectators, staff, furniture.

    Runs the detector over the MEDIAN frame. The median erases anything that
    moved, so whatever still reads as a person in it was motionless for the
    whole clip and therefore cannot be one of the four players. On the
    reference rally this finds exactly one box, and it is exactly the seated
    figure behind the right-hand glass that a slot kept stealing: it sits
    ~5 px inside the sideline in image space, so no plausible court-polygon
    margin excludes it, and it is stationary, so no motion heuristic based on
    a single frame excludes it either.

    Tradeoff, stated plainly: a player who stands still for most of the clip
    would also land in the median and be suppressed. In a rally that does not
    happen; between points it would. Run this on rally windows.
    """
    if med is None:
        return []
    r = model.predict(med, classes=[0], conf=0.15, imgsz=imgsz,
                      device=device, verbose=False)[0]
    return [tuple(b) for b in r.boxes.xyxy.tolist()]


def detect_all(video, model_path, conf, imgsz, device, court, poly, every, verbose,
               med=None):
    """Pass 1 — person boxes per frame, filtered to the court and deduped."""
    from ultralytics import YOLO
    model = YOLO(model_path)
    static = _static_people(med, model, imgsz, device)
    if verbose and static:
        sys.stderr.write(f"track_players: suppressing {len(static)} static "
                         f"person(s) found in the empty-court frame\n")

    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        raise SystemExit("track_players: cannot open input")
    frame_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    frame_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    per_frame = []
    idx = 0
    last = []
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if idx % every == 0:
            r = model.predict(frame, classes=[0], conf=conf, imgsz=imgsz,
                              device=device, verbose=False)[0]
            dets = []
            for xyxy, c in zip(r.boxes.xyxy.tolist(), r.boxes.conf.tolist()):
                x1, y1, x2, y2 = xyxy
                foot = ((x1 + x2) / 2.0, y2)
                if poly is not None and cv2.pointPolygonTest(poly, foot, False) < 0:
                    continue
                d = {"box": (x1, y1, x2, y2), "foot": foot, "conf": c}
                if not _plausible_size(d, court, frame_w, frame_h):
                    continue
                if any(_iou(d["box"], s) > 0.35 for s in static):
                    continue
                dets.append(d)
            last = _dedupe(dets)[:6]
        per_frame.append(last)
        idx += 1
        if verbose and idx % 100 == 0:
            sys.stderr.write(f"track_players: detected {idx} frames\n")
    cap.release()
    return per_frame


def assign_slots(per_frame, lock_idx, w, h, max_jump, coast_frames):
    """
    Pass 1b — four permanent slots, matched frame to frame.

    Letters are handed out once at `lock_idx` by frame quadrant, then follow the
    person. Matching is brute force over permutations: with at most 4 slots and
    6 candidates that is exact and trivially cheap, and it avoids the greedy
    failure where two players crossing steal each other's tag.
    """
    lock_dets = per_frame[lock_idx] if lock_idx < len(per_frame) else []
    if len(lock_dets) < 4:
        # Widen the search: the lock frame may catch a player mid-occlusion.
        for off in range(1, len(per_frame)):
            for j in (lock_idx - off, lock_idx + off):
                if 0 <= j < len(per_frame) and len(per_frame[j]) >= 4:
                    lock_dets, lock_idx = per_frame[j], j
                    break
            if len(lock_dets) >= 4:
                break
    if len(lock_dets) < 4:
        raise SystemExit(
            f"track_players: never saw 4 players in-court "
            f"(best frame had {len(lock_dets)}). Check --calib-debug, or lower --conf."
        )

    # Quadrant by frame midpoint, using the foot point (a player's feet say
    # where they stand; their bounding-box centre drifts with a raised arm).
    def quad(d):
        fx, fy = d["foot"]
        return (0 if fy < h / 2 else 2) + (0 if fx < w / 2 else 1)

    # Pick the four detections that best fill the four quadrants, NOT the four
    # most confident. On a busy night the lock frame carries 5-6 in-polygon
    # boxes; ranking by confidence alone can hand a letter to a spectator
    # standing at the far glass while a real player goes unlabelled. Spread
    # across quadrants is the property the letters are defined by, so select on
    # it directly and use confidence only to break ties.
    best = None
    for combo in itertools.combinations(range(len(lock_dets)), 4):
        group = [lock_dets[j] for j in combo]
        score = (len({quad(d) for d in group}), sum(d["conf"] for d in group))
        if best is None or score > best[0]:
            best = (score, group)
    cand = best[1]

    by_quad = {}
    for d in cand:
        by_quad.setdefault(quad(d), []).append(d)
    slots = {}
    unplaced = []
    for q, letter in enumerate(LABELS):
        group = by_quad.get(q, [])
        if group:
            slots[letter] = group.pop(0)
        else:
            slots[letter] = None
    for group in by_quad.values():
        unplaced.extend(group)
    # A quadrant can legitimately hold two players at lock-in (both at the net,
    # say). Fill any empty letter from the leftovers rather than dropping one.
    for letter in LABELS:
        if slots[letter] is None and unplaced:
            slots[letter] = unplaced.pop(0)

    state = {}
    for letter in LABELS:
        d = slots[letter]
        state[letter] = {
            "pos": np.array(d["foot"], float) if d else np.array([w / 2, h / 2], float),
            "vel": np.zeros(2),
            "box": d["box"] if d else None,
            "missing": 0 if d else coast_frames + 1,
        }

    n = len(per_frame)
    tracks = {L: [None] * n for L in LABELS}

    for i in range(n):
        dets = per_frame[i]
        pred = {L: state[L]["pos"] + state[L]["vel"] for L in LABELS}

        # Per-slot gate, widened while a slot is coasting: a slot that has not
        # been seen for 20 frames could legitimately be anywhere within a
        # sprint, and holding it to the single-frame gate keeps it permanently
        # lost. The cap stops the gate opening wide enough to swallow the court.
        # The 2x cap matters: at 5x the gate spans most of the court, and a slot
        # whose player has walked out of frame simply grabs whoever is nearest —
        # on the reference rally slot C bounced between three different people
        # for 200 frames. Capped, a lost slot stays parked until its own player
        # comes back.
        gates = {L: min(max_jump * (1 + 0.1 * state[L]["missing"]), max_jump * 2)
                 for L in LABELS}
        # Partial assignment, not a full permutation. An all-or-nothing matcher
        # (reject the whole assignment if ANY pair trips its gate) collapses the
        # moment one player is occluded: every slot coasts, their predictions
        # drift, and the next frame is worse. Measured on the reference rally it
        # lost every track from ~frame 650. Here an unmatched slot costs a
        # penalty and the other three still match.
        penalty = max_jump * 4.0
        cost = {}
        for L in LABELS:
            for j, d in enumerate(dets):
                dist = float(np.linalg.norm(np.array(d["foot"]) - pred[L]))
                if dist <= gates[L]:
                    cost[(L, j)] = dist

        best_pick, best_cost = {}, None

        def search(k, used, acc, chosen):
            nonlocal best_pick, best_cost
            if best_cost is not None and acc >= best_cost:
                return
            if k == len(LABELS):
                if best_cost is None or acc < best_cost:
                    best_cost, best_pick = acc, dict(chosen)
                return
            L = LABELS[k]
            for j in range(len(dets)):
                if j in used or (L, j) not in cost:
                    continue
                chosen[L] = j
                search(k + 1, used | {j}, acc + cost[(L, j)], chosen)
                del chosen[L]
            search(k + 1, used, acc + penalty, chosen)   # leave this slot unmatched

        search(0, frozenset(), 0.0, {})
        matched = best_pick

        # ── re-acquisition by elimination ──
        # Padel is 2v2, so the roster is closed. If exactly one slot and exactly
        # one detection are left over, that detection IS that player — there is
        # nobody else it could be — and the distance gate is overruled.
        # This is what recovers a player who leaves the frame at one corner and
        # walks back in at the other: on the reference rally slot C exits bottom
        # -right at frame 431 and reappears bottom-left, a ~700 px jump that the
        # gate rightly refuses frame to frame, leaving C dead for the remaining
        # 15 seconds. Restricted to the unambiguous 1-and-1 case; with two of
        # each there is no way to tell which is which, so it declines to guess.
        if len(matched) == len(LABELS) - 1 and len(dets) - len(matched) == 1:
            lost = next(L for L in LABELS if L not in matched)
            if state[lost]["missing"] >= 3:
                free = next(j for j in range(len(dets)) if j not in set(matched.values()))
                matched[lost] = free

        for L in LABELS:
            st = state[L]
            if L in matched:
                d = dets[matched[L]]
                new = np.array(d["foot"], float)
                st["vel"] = 0.6 * st["vel"] + 0.4 * (new - st["pos"])
                st["pos"] = new
                st["box"] = d["box"]
                st["missing"] = 0
                tracks[L][i] = {"box": d["box"], "foot": tuple(new), "solid": True}
            else:
                st["missing"] += 1
                st["vel"] *= 0.7          # bleed off velocity so a lost slot
                st["pos"] = st["pos"] + st["vel"]   # coasts to a stop, not away
                if st["missing"] <= coast_frames and st["box"] is not None:
                    bx = st["box"]
                    bw, bh = bx[2] - bx[0], bx[3] - bx[1]
                    cx, cy = st["pos"]
                    box = (cx - bw / 2, cy - bh, cx + bw / 2, cy)
                    tracks[L][i] = {"box": box, "foot": (cx, cy), "solid": False}
    return tracks, lock_idx


def smooth_tracks(tracks, win):
    """
    Pass 1c — interpolate gaps and smooth, over the whole clip at once.

    Non-causal on purpose: a trailing-window smoother lags by its own length,
    which on screen looks like the box chasing the player.
    """
    if win < 3:
        return tracks
    win = int(win) | 1
    pad = win // 2
    out = {}
    for L, seq in tracks.items():
        n = len(seq)
        have = [i for i, s in enumerate(seq) if s]
        if len(have) < 2:
            out[L] = seq
            continue
        arr = np.full((n, 6), np.nan)
        for i in have:
            b = seq[i]["box"]
            arr[i] = [b[0], b[1], b[2], b[3], seq[i]["foot"][0], seq[i]["foot"][1]]
        idx = np.arange(n)
        for c in range(6):
            col = arr[:, c]
            m = ~np.isnan(col)
            arr[:, c] = np.interp(idx, idx[m], col[m])
        ker = np.ones(win) / win
        for c in range(6):
            arr[:, c] = np.convolve(np.pad(arr[:, c], pad, mode="edge"), ker, mode="valid")
        out[L] = [
            {"box": tuple(arr[i, :4]), "foot": (arr[i, 4], arr[i, 5]),
             "solid": bool(seq[i] and seq[i]["solid"])}
            if seq[i] or (have[0] <= i <= have[-1]) else None
            for i in range(n)
        ]
    return out


# ──────────────────────────────────────────────────────────────────────────
# rendering
# ──────────────────────────────────────────────────────────────────────────

def draw_tag(img, x, y, letter, color, scale, box_h=None):
    """
    Label chip above the player: filled plate, letter knocked out.

    The chip is sized off the player's box height, not off the frame alone.
    A fixed-size chip is fine on the near pair but swamps the far pair, whose
    boxes are ~55 px tall — the tag ends up bigger than the person it labels
    and the far half of the court turns into a wall of chips.
    """
    font = cv2.FONT_HERSHEY_DUPLEX
    k = scale if box_h is None else max(0.55 * scale, min(scale, box_h / 130.0 * scale))
    fs = 0.7 * k
    th = max(1, int(round(1.6 * k)))
    scale = k
    (tw, tht), _ = cv2.getTextSize(letter, font, fs, th)
    padx, pady = int(9 * scale), int(6 * scale)
    w, h = tw + 2 * padx, tht + 2 * pady
    x0, y0 = int(x - w / 2), int(y - h)
    overlay = img.copy()
    cv2.rectangle(overlay, (x0, y0), (x0 + w, y0 + h), color, -1)
    cv2.addWeighted(overlay, 0.85, img, 0.15, 0, img)
    cv2.rectangle(img, (x0, y0), (x0 + w, y0 + h), (255, 255, 255), max(1, int(scale)))
    cv2.putText(img, letter, (x0 + padx, y0 + pady + tht), font, fs, (20, 20, 20), th, cv2.LINE_AA)
    # Stem down to the player, so a tag is never ambiguous in a crowd.
    cv2.line(img, (int(x), y0 + h), (int(x), int(y + 4 * scale)), color, max(1, int(scale)))


def draw_radar(img, court, feet, pos, scale):
    """
    Top-down formation view: the visible court as a rectangle, the net across
    it at its measured position, and a dot per player at (u, v).

    Deliberately drawn WITHOUT metre ticks or service boxes. The geometry
    behind it is relative, not metric (see CourtModel), and drawing a full
    regulation court here would invite reading distances off a panel that
    cannot support them.
    """
    pad = int(14 * scale)
    cw, ch = int(112 * scale), int(224 * scale)
    w, h = cw + 2 * pad, ch + 2 * pad
    fh, fw = img.shape[:2]
    margin = int(20 * scale)
    x0 = margin if "left" in pos else fw - w - margin
    y0 = margin if "top" in pos else fh - h - margin
    if x0 < 0 or y0 < 0 or x0 + w > fw or y0 + h > fh:
        return

    panel = img[y0:y0 + h, x0:x0 + w].copy()
    dark = np.full_like(panel, (28, 22, 18))
    cv2.addWeighted(dark, 0.78, panel, 0.22, 0, panel)
    img[y0:y0 + h, x0:x0 + w] = panel
    cv2.rectangle(img, (x0, y0), (x0 + w, y0 + h), (210, 210, 210), max(1, int(scale)))

    def uv2p(u, v):
        return (int(x0 + pad + u * cw), int(y0 + pad + v * ch))

    line = (170, 170, 170)
    cv2.rectangle(img, uv2p(0, 0), uv2p(1, 1), line, max(1, int(scale)))
    cv2.line(img, uv2p(0, court.v_net), uv2p(1, court.v_net),
             (255, 255, 255), max(1, int(1.6 * scale)))
    cv2.line(img, uv2p(0.5, 0), uv2p(0.5, 1), (110, 110, 110), max(1, int(scale)))

    for letter, ft in feet.items():
        if ft is None:
            continue
        u, v = court.uv(ft[0], ft[1])
        # Clamp: a player legitimately plays off the back glass and the side
        # walls, landing just outside the fitted lines. Clipping keeps them on
        # the panel edge instead of vanishing off it.
        cx, cy = uv2p(float(np.clip(u, -0.04, 1.04)), float(np.clip(v, -0.04, 1.04)))
        cv2.circle(img, (cx, cy), int(7 * scale), COLORS[letter], -1)
        cv2.circle(img, (cx, cy), int(7 * scale), (255, 255, 255), max(1, int(scale)))
        cv2.putText(img, letter, (cx - int(4 * scale), cy + int(4 * scale)),
                    cv2.FONT_HERSHEY_DUPLEX, 0.35 * scale, (20, 20, 20),
                    max(1, int(scale)), cv2.LINE_AA)


def render(video, output, tracks, court, trail_len, radar_pos, show_court, poly, verbose):
    """Pass 2 — draw boxes, tags, trails and the radar onto every frame."""
    cap = cv2.VideoCapture(video)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    scale = max(1.0, w / 1280.0)
    writer = cv2.VideoWriter(output, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    if not writer.isOpened():
        cap.release()
        raise SystemExit("track_players: cannot open output writer")

    trails = {L: deque(maxlen=trail_len) for L in LABELS}
    i = 0
    try:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if show_court and poly is not None:
                cv2.polylines(frame, [poly], True, (90, 90, 90), 1)

            feet = {}
            for L in LABELS:
                s = tracks[L][i] if i < len(tracks[L]) else None
                feet[L] = s["foot"] if s else None
                # Only real detections join the trail. Coasted positions are a
                # guess, and a guess drawn as history reads as fact.
                trails[L].append((int(s["foot"][0]), int(s["foot"][1]))
                                 if s and s["solid"] else None)

            # Trails first, so a box always sits on top of its own tail.
            # Segments longer than max_seg are dropped rather than drawn: when a
            # slot re-acquires its player across the court, joining the two
            # points paints a stripe over the whole picture, which looks like a
            # player teleported and buries the frame under it.
            max_seg = 0.05 * w
            for L in LABELS:
                pts = list(trails[L])
                for j in range(1, len(pts)):
                    p, q = pts[j - 1], pts[j]
                    if p is None or q is None or np.hypot(q[0] - p[0], q[1] - p[1]) > max_seg:
                        continue
                    a = j / float(len(pts))
                    col = tuple(int(c * a) for c in COLORS[L])
                    cv2.line(frame, p, q, col, max(1, int(round(3 * scale * a))), cv2.LINE_AA)

            for L in LABELS:
                s = tracks[L][i] if i < len(tracks[L]) else None
                if not s:
                    continue
                x1, y1, x2, y2 = [int(v) for v in s["box"]]
                col = COLORS[L]
                thick = max(1, int(round(2 * scale)))
                if s["solid"]:
                    cv2.rectangle(frame, (x1, y1), (x2, y2), col, thick)
                else:
                    # Coasting (no detection this frame): dashed, so the overlay
                    # never claims a confidence the detector did not have.
                    for (ax, ay, bx, by) in ((x1, y1, x2, y1), (x2, y1, x2, y2),
                                             (x2, y2, x1, y2), (x1, y2, x1, y1)):
                        n = max(2, int(np.hypot(bx - ax, by - ay) / (9 * scale)))
                        for k in range(0, n, 2):
                            p = (int(ax + (bx - ax) * k / n), int(ay + (by - ay) * k / n))
                            q = (int(ax + (bx - ax) * (k + 1) / n), int(ay + (by - ay) * (k + 1) / n))
                            cv2.line(frame, p, q, col, thick)
                draw_tag(frame, (x1 + x2) / 2, y1 - int(6 * scale), L, col, scale,
                         box_h=y2 - y1)

            if court is not None:
                draw_radar(frame, court, feet, radar_pos, scale)

            writer.write(frame)
            i += 1
            if verbose and i % 100 == 0:
                sys.stderr.write(f"track_players: rendered {i} frames\n")
    finally:
        cap.release()
        writer.release()
    return i


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--model", default="yolo11s.pt",
                    help="ultralytics weights; yolo11s is the sweet spot here "
                         "(matches yolo11m on this footage, ~3x faster)")
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--imgsz", type=int, default=1280,
                    help="far-end players are ~55px tall; 640 loses them")
    ap.add_argument("--device", default="", help="'mps', 'cuda', 'cpu' (default: auto)")
    ap.add_argument("--detect-every", type=int, default=1)
    ap.add_argument("--lock-sec", type=float, default=2.0,
                    help="second at which letters are handed out by quadrant")
    ap.add_argument("--max-jump-frac", type=float, default=0.06,
                    help="max per-frame foot movement, as a fraction of width; "
                         "the gate that stops a slot stealing a spectator")
    ap.add_argument("--coast-frames", type=int, default=25)
    ap.add_argument("--smooth-win", type=int, default=7)
    ap.add_argument("--trail-sec", type=float, default=1.2)
    ap.add_argument("--radar", default="bottom-left",
                    choices=["bottom-left", "bottom-right", "top-left", "top-right", "off"])
    ap.add_argument("--court-json", default="",
                    help="reuse a saved calibration (see --dump-court); skips "
                         "auto-detection, which is the fix for a court whose "
                         "surface the HSV gate cannot find")
    ap.add_argument("--dump-court", default="",
                    help="write the calibration it worked out to this JSON file")
    ap.add_argument("--court-hsv", default="90,40,40,130,255,255",
                    help="HSV gate for the playing surface (lo h,s,v,hi h,s,v)")
    ap.add_argument("--calib-debug", default="", help="write the calibration check image here")
    ap.add_argument("--show-court", action="store_true", help="outline the court filter polygon")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()

    cap = cv2.VideoCapture(args.input)
    if not cap.isOpened():
        sys.stderr.write("track_players: cannot open input\n")
        return 3
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()

    hv = [int(v) for v in args.court_hsv.split(",")]
    hsv_lo, hsv_hi = hv[:3], hv[3:6]

    # One empty-court frame serves both jobs: fitting the court, and finding
    # the people who never move.
    med = median_frame(args.input)

    court = None
    if args.court_json:
        with open(args.court_json) as fh:
            cj = json.load(fh)
        court = CourtModel(cj["mL"], cj["bL"], cj["mR"], cj["bR"],
                           cj["y_top"], cj["y_bot"], cj["y_net"])
        sys.stderr.write("track_players: calibration from --court-json\n")
    else:
        court, note = calibrate(args.input, hsv_lo, hsv_hi, args.calib_debug, med)
        if court is None:
            sys.stderr.write(f"track_players: calibration failed ({note}); "
                             f"radar and court filter disabled\n")
        else:
            sys.stderr.write(f"track_players: calibrated {note}\n")
    if court is not None and args.dump_court:
        with open(args.dump_court, "w") as fh:
            json.dump({"mL": court.mL, "bL": court.bL, "mR": court.mR, "bR": court.bR,
                       "y_top": court.y_top, "y_bot": court.y_bot, "y_net": court.y_net},
                      fh, indent=2)

    # Court polygon for filtering detections — the fitted court plus a margin,
    # because a player's feet land outside the lines when they play the glass.
    poly = court.polygon() if court is not None else None

    device = args.device or ("mps" if sys.platform == "darwin" else "")
    per_frame = detect_all(args.input, args.model, args.conf, args.imgsz,
                           device or None, court, poly,
                           max(1, args.detect_every), args.debug, med)
    if not per_frame:
        sys.stderr.write("track_players: no frames read\n")
        return 4

    lock_idx = min(len(per_frame) - 1, max(0, int(args.lock_sec * fps)))
    tracks, used_lock = assign_slots(per_frame, lock_idx, w, h,
                                     args.max_jump_frac * w, args.coast_frames)
    tracks = smooth_tracks(tracks, args.smooth_win)

    if args.debug:
        for L in LABELS:
            solid = sum(1 for s in tracks[L] if s and s["solid"])
            drawn = sum(1 for s in tracks[L] if s)
            sys.stderr.write(f"track_players: {L} detected={solid}/{len(per_frame)} "
                             f"({solid/len(per_frame):.2f}) drawn={drawn}\n")
        radar_on = court is not None and args.radar != "off"
        sys.stderr.write(f"track_players: lock frame={used_lock} "
                         f"({used_lock/fps:.2f}s) radar={'on' if radar_on else 'off'}\n")

    n = render(args.input, args.output, tracks, court if args.radar != "off" else None,
               max(2, int(args.trail_sec * fps)), args.radar, args.show_court, poly, args.debug)
    if n == 0:
        sys.stderr.write("track_players: no frames written\n")
        return 4
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"track_players: unexpected error: {exc}\n")
        sys.exit(1)
