#!/usr/bin/env python3
"""
player_heatmap.py — a vertical share card: four per-player court heatmaps
around the clip, showing where each player spent the point.

── IN SIMPLE WORDS ──
Takes the A/B/C/D tracking data that `track_players.py` produced and turns it
into a 9:16 graphic for social. Four little top-down courts, one per player,
each stained with the colour of how long that player stood there — green where
they passed through, red where they camped. The clip itself plays in the middle,
and a legend along the bottom says which colour means what.

Think of it as a long-exposure photograph of each player's feet: the longer
they stand somewhere, the brighter that patch burns in.

── BUSINESS RULES ──
- One panel per player, laid out to MATCH THE COURT, not to match reading
  order: A and B (the far pair) on the top row, C and D (the near pair) on the
  bottom row, with the clip between them. Someone glancing at the card should
  map a panel to a player without reading the labels.
- Heat comes from CONFIRMED detections only. Coasted positions are the
  tracker's guess at where a player probably was; baking a guess into a
  statistic makes it look like data.
- All four panels share ONE colour scale, so the panels are comparable with
  each other. A player who barely moved gets a dim panel — that is the finding,
  not a rendering bug.
- Court panels are SCHEMATIC. Outline, net and centre line only. Nothing here
  is drawn to scale — see the DO NOT section.

── WHY IT'S BUILT THIS WAY (change at your peril) ──
- **Two passes over the track data: accumulate everything first, then
  animate.** The colour scale is pinned to the FINAL heat maximum, computed
  before a single frame is drawn. Normalising each frame against its own
  running maximum instead makes the first few frames — where one stray splat is
  the maximum — come out fully saturated, so the card opens at peak red and the
  heat appears to fade as the point goes on, which is backwards.
- **Heat accumulates in court space (u, v), not pixel space.** A player at the
  far end covers a fraction of the pixels of a near player at the same physical
  speed, so a pixel-space heatmap would say the far pair barely moved. Court
  space removes the perspective before counting.
- **Splats are weighted by 1/frames-present.** Without it the card rewards
  being detectable rather than being active: a player visible for the whole
  clip accumulates more total heat than one who leaves the frame, purely from
  having more samples.

── DO NOT ──
- Do NOT add metre markings, service boxes or "distance covered" numbers to
  these panels. The underlying court model is relative, not metric (see
  CourtModel in track_players.py: the near baseline is off-frame and the lens
  has barrel distortion). The panels are drawn at a chosen display ratio, so
  any measurement read off them would be invented.
- Do NOT compare heatmaps across clips. The scale is normalised per render,
  so red on one card is not the same amount of standing-around as red on
  another.
- Do NOT read a dim panel as "lazy player" without checking the detection rate
  that `track_players.py --debug` printed. A player who spends the point
  outside the camera crop produces a dim panel for a reason that has nothing
  to do with them.
"""

import argparse
import json
import sys

try:
    import cv2
    import numpy as np
except Exception as exc:  # noqa: BLE001
    sys.stderr.write(f"player_heatmap: dependencies unavailable: {exc}\n")
    sys.exit(2)

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from track_players import CourtModel, LABELS  # noqa: E402

# ── palette (BGR) ──
BG_TOP = (92, 48, 18)
BG_BOT = (168, 104, 40)
COURT_FILL = (150, 92, 34)
COURT_LINE = (245, 235, 220)
PANEL_EDGE = (220, 190, 150)
TEXT = (255, 255, 255)

GRID_U, GRID_V = 96, 168     # heat grid resolution in court space


def heat_lut():
    """
    Low->high colour ramp: green -> yellow -> orange -> red, with alpha rising
    fast off zero.

    Deliberately NOT one of cv2's built-ins. COLORMAP_JET, the obvious pick,
    starts at dark blue — and on a blue court graphic the low end of the scale
    would be invisible against the background it is drawn on.
    """
    stops = [(0.00, (0, 150, 0)), (0.35, (0, 230, 230)),
             (0.65, (0, 150, 255)), (1.00, (40, 40, 235))]
    lut = np.zeros((256, 3), np.uint8)
    alpha = np.zeros(256, np.float32)
    for i in range(256):
        t = i / 255.0
        for (t0, c0), (t1, c1) in zip(stops, stops[1:]):
            if t0 <= t <= t1:
                f = 0.0 if t1 == t0 else (t - t0) / (t1 - t0)
                lut[i] = [int(c0[k] + (c1[k] - c0[k]) * f) for k in range(3)]
                break
        # Ramp opacity steeply over the first fifth of the scale: a court is
        # mostly empty, and a linear alpha leaves the whole panel under a
        # uniform green film that reads as activity where there was none.
        alpha[i] = min(1.0, (t / 0.20) ** 0.75) * 0.92
    return lut, alpha


def accumulate(tracks, court, frames):
    """
    Per-player heat grids in court space, as a running series.

    Returns (grids, order) where grids[L] is the FINAL grid and order[L] is the
    list of (frame_index, gu, gv, weight) splats, so the animation can replay
    the build-up without re-deriving anything.
    """
    splats = {L: [] for L in LABELS}
    present = {L: max(1, sum(1 for s in tracks[L] if s and s["solid"])) for L in LABELS}
    for L in LABELS:
        for i, s in enumerate(tracks[L][:frames]):
            if not s or not s["solid"]:
                continue
            u, v = court.uv(s["foot"][0], s["foot"][1])
            gu = int(np.clip(u, 0, 0.999) * GRID_U)
            gv = int(np.clip(v, 0, 0.999) * GRID_V)
            splats[L].append((i, gu, gv, 1.0 / present[L]))
    return splats


def blur_heat(raw):
    return cv2.GaussianBlur(raw, (0, 0), sigmaX=3.2, sigmaY=3.2)


def draw_court_panel(w, h, court, heat, vmax, lut, alpha):
    """One schematic court with its heat layer composited on."""
    panel = np.zeros((h, w, 3), np.uint8)
    panel[:] = COURT_FILL

    if heat is not None and vmax > 0:
        norm = np.clip(heat / vmax, 0, 1)
        idx = (norm * 255).astype(np.uint8)
        colour = lut[idx]                                   # (gv, gu, 3)
        a = alpha[idx][..., None]
        colour = cv2.resize(colour, (w, h), interpolation=cv2.INTER_LINEAR)
        a = cv2.resize(a, (w, h), interpolation=cv2.INTER_LINEAR)[..., None]
        panel = (panel * (1 - a) + colour * a).astype(np.uint8)

    lw = max(1, int(round(w / 150)))
    cv2.rectangle(panel, (0, 0), (w - 1, h - 1), COURT_LINE, lw)
    ynet = int(court.v_net * h)
    cv2.line(panel, (0, ynet), (w, ynet), COURT_LINE, lw + 1)
    cv2.line(panel, (w // 2, 0), (w // 2, h), COURT_LINE, lw)
    return panel


def put_centered(img, text, cx, cy, scale, colour, thick, font=cv2.FONT_HERSHEY_DUPLEX):
    (tw, th), _ = cv2.getTextSize(text, font, scale, thick)
    cv2.putText(img, text, (int(cx - tw / 2), int(cy + th / 2)), font, scale,
                colour, thick, cv2.LINE_AA)
    return tw, th


def background(w, h):
    """Vertical gradient, so the card does not read as a flat screenshot."""
    ramp = np.linspace(0, 1, h, dtype=np.float32)[:, None]
    bg = np.zeros((h, w, 3), np.float32)
    for c in range(3):
        bg[..., c] = BG_TOP[c] + (BG_BOT[c] - BG_TOP[c]) * ramp
    return bg.astype(np.uint8)


def draw_legend(canvas, x, y, w, h, lut, alpha):
    bar_h = max(14, h // 3)
    grad = np.linspace(0, 255, w).astype(np.uint8)
    strip = lut[grad][None, :, :].repeat(bar_h, axis=0)
    canvas[y:y + bar_h, x:x + w] = strip
    cv2.rectangle(canvas, (x, y), (x + w, y + bar_h), (255, 255, 255), 1)
    put_centered(canvas, "LOW ACTIVITY", x + w * 0.16, y + bar_h + h * 0.42, 0.62, TEXT, 1)
    put_centered(canvas, "HIGH ACTIVITY", x + w * 0.84, y + bar_h + h * 0.42, 0.62, TEXT, 1)


def _blit_logo(canvas, path, W, top, band_h):
    """
    Centre the brand mark in the header band.

    Alpha is honoured when the PNG has it. A logo without alpha renders as its
    own rectangle on the gradient, which looks like a pasted screenshot — that
    is a property of the asset, not of this code (see the reel README on
    keying a black background out of a JPEG logo).
    """
    logo = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if logo is None:
        return
    h = int(band_h * 0.82)
    w = max(1, int(logo.shape[1] * h / logo.shape[0]))
    if w > W * 0.5:
        w = int(W * 0.5)
        h = max(1, int(logo.shape[0] * w / logo.shape[1]))
    logo = cv2.resize(logo, (w, h), interpolation=cv2.INTER_AREA)
    x = (W - w) // 2
    y = top + (band_h - h) // 2
    if y < 0 or y + h > canvas.shape[0]:
        return
    roi = canvas[y:y + h, x:x + w]
    if logo.shape[2] == 4:
        a = (logo[..., 3:4].astype(np.float32) / 255.0)
        canvas[y:y + h, x:x + w] = (roi * (1 - a) + logo[..., :3] * a).astype(np.uint8)
    else:
        canvas[y:y + h, x:x + w] = logo


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--tracks", required=True,
                    help="JSON from track_players.py --dump-tracks")
    ap.add_argument("--output", required=True, help="composite .mp4")
    ap.add_argument("--poster", default="", help="also write the final frame as PNG")
    ap.add_argument("--video", default="",
                    help="clip for the centre panel (default: the one in --tracks)")
    ap.add_argument("--width", type=int, default=1080)
    ap.add_argument("--height", type=int, default=1920)
    ap.add_argument("--names", default="",
                    help="rename the panels, e.g. 'A=DI NENNO,B=LEBRON,C=TAPIA,D=COELLO'")
    ap.add_argument("--title", default="", help="text burned over the clip, e.g. 'SET 1'")
    ap.add_argument("--logo", default="public/ds.png",
                    help="branding logo for the header ('' for none)")
    ap.add_argument("--static", action="store_true",
                    help="write the poster only; skip the video render")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()

    with open(args.tracks) as fh:
        data = json.load(fh)
    if not data.get("court"):
        sys.stderr.write("player_heatmap: tracks have no court calibration; "
                         "heatmaps need one (re-run track_players.py on a clip "
                         "where calibration succeeded)\n")
        return 3
    c = data["court"]
    court = CourtModel(c["mL"], c["bL"], c["mR"], c["bR"],
                       c["y_top"], c["y_bot"], c["y_net"])
    tracks = data["tracks"]
    n_frames = data["frames"]
    fps = data["fps"] or 30.0
    video = args.video or data["video"]

    names = {L: L for L in LABELS}
    for part in filter(None, args.names.split(",")):
        k, _, v = part.partition("=")
        if k.strip().upper() in names:
            names[k.strip().upper()] = v.strip().upper()

    lut, alpha = heat_lut()
    splats = accumulate(tracks, court, n_frames)

    # Final heat first — the colour scale is pinned to it (see module header).
    final = {}
    for L in LABELS:
        raw = np.zeros((GRID_V, GRID_U), np.float32)
        for _, gu, gv, wgt in splats[L]:
            raw[gv, gu] += wgt
        final[L] = blur_heat(raw)
    vmax = max(float(g.max()) for g in final.values()) or 1.0
    if args.debug:
        for L in LABELS:
            sys.stderr.write(f"player_heatmap: {L} splats={len(splats[L])} "
                             f"peak={final[L].max() / vmax:.2f} of scale\n")

    # ── layout ──
    W, H = args.width, args.height
    M = int(W * 0.033)
    gap = int(W * 0.022)
    legend_h = int(H * 0.047)
    vid_w = W - 2 * M
    vid_h = int(round(vid_w * data["height"] / data["width"]))
    header_h = int(H * 0.052) if args.logo else 0
    # Every band gets subtracted BEFORE the rows are sized, so the two panel
    # rows absorb whatever is left. Reclaiming only part of a band here is how
    # the bottom row ends up sliding underneath the legend.
    row_h = (H - 2 * M - header_h - vid_h - legend_h - 3 * gap) // 2
    panel_w = (W - 2 * M - gap) // 2
    label_h = int(row_h * 0.13)
    court_h = row_h - label_h - int(gap * 0.3)
    court_w = min(panel_w - 2 * gap, int(court_h / 1.75))

    y_row1 = M + header_h
    y_vid = y_row1 + row_h + gap
    y_row2 = y_vid + vid_h + gap
    y_leg = y_row2 + row_h + gap

    slots = {"A": (M, y_row1), "B": (M + panel_w + gap, y_row1),
             "C": (M, y_row2), "D": (M + panel_w + gap, y_row2)}

    base = background(W, H)
    if header_h:
        _blit_logo(base, args.logo, W, M, header_h)
    draw_legend(base, M + int(vid_w * 0.15), y_leg, int(vid_w * 0.7), legend_h, lut, alpha)

    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        sys.stderr.write(f"player_heatmap: cannot open {video}\n")
        return 3

    writer = None
    if not args.static:
        writer = cv2.VideoWriter(args.output, cv2.VideoWriter_fourcc(*"mp4v"),
                                 fps, (W, H))
        if not writer.isOpened():
            cap.release()
            sys.stderr.write("player_heatmap: cannot open output writer\n")
            return 3

    running = {L: np.zeros((GRID_V, GRID_U), np.float32) for L in LABELS}
    cursor = {L: 0 for L in LABELS}
    last = None

    for i in range(n_frames):
        ok, frame = cap.read()
        if not ok:
            break
        for L in LABELS:
            while cursor[L] < len(splats[L]) and splats[L][cursor[L]][0] <= i:
                _, gu, gv, wgt = splats[L][cursor[L]]
                running[L][gv, gu] += wgt
                cursor[L] += 1

        canvas = base.copy()
        for L in LABELS:
            px, py = slots[L]
            panel = draw_court_panel(court_w, court_h, court,
                                     blur_heat(running[L]), vmax, lut, alpha)
            cx = px + (panel_w - court_w) // 2
            cy = py + label_h + int(gap * 0.3)
            canvas[cy:cy + court_h, cx:cx + court_w] = panel
            cv2.rectangle(canvas, (cx - 1, cy - 1), (cx + court_w, cy + court_h),
                          PANEL_EDGE, 1)
            put_centered(canvas, names[L], px + panel_w / 2, py + label_h * 0.55,
                         min(1.0, panel_w / 480.0), TEXT, 2)

        vid = cv2.resize(frame, (vid_w, vid_h), interpolation=cv2.INTER_AREA)
        canvas[y_vid:y_vid + vid_h, M:M + vid_w] = vid
        cv2.rectangle(canvas, (M - 1, y_vid - 1), (M + vid_w, y_vid + vid_h),
                      PANEL_EDGE, 2)
        if args.title:
            # Shadow first: white-on-video is unreadable over a floodlit court
            # without one, and this card is meant to survive a phone screen.
            put_centered(canvas, args.title, W / 2 + 4, y_vid + vid_h * 0.5 + 4,
                         vid_w / 320.0, (20, 20, 20), 7)
            put_centered(canvas, args.title, W / 2, y_vid + vid_h * 0.5,
                         vid_w / 320.0, TEXT, 6)

        if writer is not None:
            writer.write(canvas)
        last = canvas
        if args.debug and (i + 1) % 150 == 0:
            sys.stderr.write(f"player_heatmap: composited {i + 1} frames\n")

    cap.release()
    if writer is not None:
        writer.release()
    if last is None:
        sys.stderr.write("player_heatmap: no frames composited\n")
        return 4
    if args.poster:
        cv2.imwrite(args.poster, last)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"player_heatmap: unexpected error: {exc}\n")
        sys.exit(1)
