#!/usr/bin/env python3
"""
match_debug.py — a watchable review reel of what the point/serve detector
decided, so its output can be checked by eye and ear instead of on trust.

── IN SIMPLE WORDS ──
The analysis scripts emit numbers. This turns those numbers back into a video:
every detected point, back to back, with the machine's reading printed on top.
You watch it with the sound on. Each time the detector thinks the ball was
struck, a tick lights up — so if the ticks line up with the cracks you can hear,
strike detection is working. The banner says which end it thinks served, and the
server it picked is boxed. The strip along the bottom is the whole match, so you
can see where you are.

Dead time between points is cut out. 39 minutes of stream becomes ~15 minutes of
review, all of it the part worth checking.

── BUSINESS RULES ──
- Shows every detected point in order, `--pre` seconds before the first strike
  to `--post` after the last, so both boundaries are visible and judgeable.
- Original audio is carried through, time-aligned to the frames. This is the
  point of the tool: strike detection is an AUDIO claim and cannot be checked
  from pictures.
- Shows where the Viterbi smoothing OVERRODE the raw geometry, rather than
  hiding it. Those points are where the answer is least trustworthy and are
  exactly what a reviewer should spend their attention on.

── WHY IT'S BUILT THIS WAY (change at your peril) ──
- **Frames are piped from ffmpeg as rawvideo, not extracted as JPEGs.** A
  review reel is ~20k frames; going via JPEG files costs an encode and a decode
  per frame plus a few GB of temp, for output that is then re-encoded anyway.
- **Audio is cut to the frame count actually rendered, not to the requested
  duration.** ffmpeg's seek lands on whole frames, so a segment can come back a
  frame or two short. Cutting audio to the request instead of to reality drifts
  the tick away from the crack it is meant to line up with, which would make a
  working detector look broken.
- **Segments are concatenated as encoded files, not accumulated in memory.**
  A whole match of review video does not fit in RAM at 1280 wide.

── DO NOT ──
- Do NOT judge strike detection with the sound off. The ticks are a claim about
  audio; muting removes the only ground truth in the tool.
- Do NOT read the server box as a named player. It marks the court POSITION the
  serve was attributed to. Identity across a match is not solved (see
  match_serves.py).
- Do NOT treat a missing point as proof no point happened. Points ending in two
  strikes are dropped upstream on purpose (see match_points.py), so this reel
  shows what WAS detected, never what was missed. To hunt misses, watch the
  gaps in the source, not this file.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile

try:
    import cv2
    import numpy as np
except Exception as exc:  # noqa: BLE001
    sys.stderr.write(f"match_debug: dependencies unavailable: {exc}\n")
    sys.exit(2)

FG = (255, 255, 255)
DIM = (150, 150, 150)
NEAR_C = (98, 232, 127)      # mint
FAR_C = (56, 168, 255)       # amber
WARN = (60, 90, 255)         # red-orange for overridden points
PANEL = (34, 28, 24)


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                          "-show_entries", "stream=width,height,r_frame_rate",
                          "-of", "default=nw=1:nk=1", path],
                         capture_output=True, text=True).stdout.split()
    w, h = int(out[0]), int(out[1])
    num, den = out[2].split("/")
    return w, h, float(num) / float(den)


def read_segment(video, t0, dur, w, h):
    """Pipe a time range out of ffmpeg as raw BGR frames."""
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


def text(img, s, x, y, scale=0.5, col=FG, thick=1):
    cv2.putText(img, s, (int(x), int(y)), cv2.FONT_HERSHEY_DUPLEX, scale, col,
                thick, cv2.LINE_AA)


def draw_radar(canvas, x0, y0, w, h, v_net, players, server, side):
    """Top-down court; the serving half is tinted and the chosen server ringed."""
    cv2.rectangle(canvas, (x0, y0), (x0 + w, y0 + h), (70, 60, 52), -1)
    yn = int(y0 + v_net * h)
    tint = FAR_C if side == "far" else NEAR_C
    if side == "far":
        sub = canvas[y0:yn, x0:x0 + w]
        cv2.addWeighted(np.full_like(sub, tint), 0.22, sub, 0.78, 0, sub)
    else:
        sub = canvas[yn:y0 + h, x0:x0 + w]
        cv2.addWeighted(np.full_like(sub, tint), 0.22, sub, 0.78, 0, sub)
    cv2.rectangle(canvas, (x0, y0), (x0 + w, y0 + h), DIM, 1)
    cv2.line(canvas, (x0, yn), (x0 + w, yn), FG, 2)
    cv2.line(canvas, (x0 + w // 2, y0), (x0 + w // 2, y0 + h), (100, 90, 80), 1)
    for p in players:
        cx = int(x0 + np.clip(p["u"], 0, 1) * w)
        cy = int(y0 + np.clip(p["v"], 0, 1) * h)
        cv2.circle(canvas, (cx, cy), 4, (220, 220, 220), -1)
    if server:
        cx = int(x0 + np.clip(server["u"], 0, 1) * w)
        cy = int(y0 + np.clip(server["v"], 0, 1) * h)
        cv2.circle(canvas, (cx, cy), 7, tint, -1)
        cv2.circle(canvas, (cx, cy), 9, FG, 2)
    text(canvas, "SERVE END", x0 + 4, y0 + h + 14, 0.38, DIM)


def draw_strike_strip(canvas, x0, y0, w, h, p, now):
    """Ticks at each detected strike; the playhead sweeps across."""
    t0, t1 = p["start"], p["end"]
    span = max(0.5, t1 - t0)
    cv2.rectangle(canvas, (x0, y0), (x0 + w, y0 + h), (60, 52, 46), -1)
    cv2.rectangle(canvas, (x0, y0), (x0 + w, y0 + h), DIM, 1)
    for k, st in enumerate(p["strike_times"]):
        x = int(x0 + (st - t0) / span * w)
        hot = abs(now - st) < 0.10
        cv2.line(canvas, (x, y0 + 2), (x, y0 + h - 2),
                 (90, 255, 255) if hot else (200, 200, 200), 3 if hot else 1)
        if hot:
            cv2.circle(canvas, (x, y0 - 6), 5, (90, 255, 255), -1)
    px = int(x0 + np.clip((now - t0) / span, 0, 1) * w)
    cv2.line(canvas, (px, y0), (px, y0 + h), (90, 200, 255), 2)
    text(canvas, f"{len(p['strike_times'])} strikes", x0, y0 - 10, 0.42, DIM)


def draw_match_timeline(canvas, x0, y0, w, h, pts, cur, dur):
    cv2.rectangle(canvas, (x0, y0), (x0 + w, y0 + h), (52, 46, 40), -1)
    for i, p in enumerate(pts):
        x = int(x0 + p["start"] / dur * w)
        col = FAR_C if p["serve_side"] == "far" else NEAR_C
        cv2.line(canvas, (x, y0 + 1), (x, y0 + h - 1), col, 1)
        if i == cur:
            cv2.line(canvas, (x, y0 - 3), (x, y0 + h + 3), FG, 2)
    text(canvas, "match timeline  amber=far end serving  mint=near end",
         x0, y0 - 6, 0.38, DIM)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--input", required=True, help="letterbox-stripped match video")
    ap.add_argument("--audio-from", default="",
                    help="take audio from this file instead (the cropped working "
                         "copy is usually encoded without an audio track, and the "
                         "ticks are worthless without sound). Same timeline as --input.")
    ap.add_argument("--serves", required=True, help="JSON from match_serves.py")
    ap.add_argument("--points", required=True, help="JSON from match_points.py")
    ap.add_argument("--output", required=True)
    ap.add_argument("--pre", type=float, default=3.0)
    ap.add_argument("--post", type=float, default=1.5)
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--limit", type=int, default=0, help="only the first N points")
    ap.add_argument("--only-overridden", action="store_true",
                    help="just the points where smoothing overrode geometry")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()

    sv = json.load(open(args.serves))
    pj = {p["point"]: p for p in json.load(open(args.points))["points"]}
    v_net = sv["court"]["v_net"]
    pts = sv["points"]
    for p in pts:
        p["strike_times"] = pj[p["point"]]["strike_times"]

    sel = [p for p in pts if (not args.only_overridden or p["smoothed_agrees_raw"] is False)]
    if args.limit:
        sel = sel[:args.limit]
    if not sel:
        sys.stderr.write("match_debug: nothing to render\n")
        return 4

    sw, sh, fps = probe(args.input)
    VW = args.width
    VH = int(round(sh * VW / sw)) // 2 * 2
    PANEL_H = 200
    W, H = VW, VH + PANEL_H
    scale = VW / sw
    dur_total = max(p["end"] for p in pts) + 10

    tmpdir = tempfile.mkdtemp(prefix="matchdbg.")
    seg_files = []
    try:
        for n, p in enumerate(sel):
            t0 = max(0.0, p["start"] - args.pre)
            t1 = p["end"] + args.post
            vpath = os.path.join(tmpdir, f"v{n:04d}.mp4")
            writer = cv2.VideoWriter(vpath, cv2.VideoWriter_fourcc(*"mp4v"), fps, (W, H))
            if not writer.isOpened():
                raise SystemExit("match_debug: cannot open segment writer")
            nf = 0
            for frame in read_segment(args.input, t0, t1 - t0, VW, VH):
                now = t0 + nf / fps
                canvas = np.zeros((H, W, 3), np.uint8)
                canvas[:VH] = frame
                canvas[VH:] = PANEL

                live = p["start"] - 0.05 <= now <= p["end"] + 0.05
                side_c = FAR_C if p["serve_side"] == "far" else NEAR_C

                # Boxes are the positions from ONE sampled frame, so they are only
                # true at that frame's timestamp. Drawn across the whole pre-serve
                # window they float next to the players and read as a bad
                # detection when nothing is wrong.
                ft = p.get("serve_frame_t")
                show_boxes = (abs(now - ft) < 0.25 if ft is not None
                              else now <= p["start"] + 0.4)
                if show_boxes:
                    for q in p["players_at_serve"]:
                        x1, y1, x2, y2 = [int(v * scale) for v in q["box"]]
                        cv2.rectangle(canvas, (x1, y1), (x2, y2), (170, 170, 170), 1)
                    if p["server"]:
                        x1, y1, x2, y2 = [int(v * scale) for v in p["server"]["box"]]
                        cv2.rectangle(canvas, (x1, y1), (x2, y2), side_c, 3)
                        text(canvas, "SERVER", x1, max(14, y1 - 8), 0.6, side_c, 2)

                # banner
                cv2.rectangle(canvas, (0, 0), (VW, 34), (0, 0, 0), -1)
                text(canvas, f"POINT {p['point']}/{len(pts)}", 12, 24, 0.66, FG, 2)
                text(canvas, f"t={now:7.2f}s   {p['strikes']} strikes   "
                             f"{p['end']-p['start']:.1f}s", 210, 24, 0.5, DIM)
                text(canvas, f"SERVE: {p['serve_side'].upper()} END", VW - 330, 24, 0.62,
                     side_c, 2)
                if live:
                    cv2.circle(canvas, (VW - 22, 17), 8, (90, 255, 120), -1)
                    text(canvas, "RALLY", VW - 100, 24, 0.5, (90, 255, 120))

                # panel
                py = VH + 14
                rv = p["raw_vote"]
                geo = "n/a" if rv is None else ("FAR" if rv > 0.5 else "NEAR")
                gv = "" if rv is None else f" (vote {rv:.2f})"
                text(canvas, f"geometry says {geo}{gv}   ->   using "
                             f"{p['serve_side'].upper()}", 14, py + 8, 0.48, DIM)
                if p["smoothed_agrees_raw"] is False:
                    text(canvas, "RULE-SMOOTHING OVERRODE THE GEOMETRY  <-- verify this one",
                         14, py + 34, 0.5, WARN, 2)
                elif p["smoothed_agrees_raw"] is None:
                    text(canvas, "no usable geometry (fewer than 2 players detected)",
                         14, py + 34, 0.5, WARN)
                else:
                    text(canvas, "geometry agrees with the two-game rule", 14, py + 34,
                         0.5, (140, 220, 140))
                text(canvas, f"{len(p['players_at_serve'])} players detected at serve"
                             "   |   listen: each tick should land on a crack you hear",
                     14, py + 58, 0.42, DIM)

                draw_strike_strip(canvas, 14, VH + 96, 620, 34, p, now)
                draw_radar(canvas, VW - 210, VH + 20, 150, 140, v_net,
                           p["players_at_serve"], p["server"], p["serve_side"])
                draw_match_timeline(canvas, 14, H - 26, VW - 250, 14, pts,
                                    pts.index(p), dur_total)
                writer.write(canvas)
                nf += 1
            writer.release()
            if nf == 0:
                continue

            apath = os.path.join(tmpdir, f"a{n:04d}.wav")
            asrc = args.audio_from or args.input
            if _has_audio(asrc):
                subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", f"{t0:.3f}",
                                "-t", f"{nf/fps:.3f}", "-i", asrc,
                                "-vn", "-ac", "2", "-ar", "44100", apath], check=False)
            mpath = os.path.join(tmpdir, f"m{n:04d}.mp4")
            if os.path.exists(apath) and os.path.getsize(apath) > 1000:
                subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", vpath, "-i", apath,
                                "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
                                "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", mpath],
                               check=True)
            else:
                subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", vpath,
                                "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
                                "-pix_fmt", "yuv420p", mpath], check=True)
            seg_files.append(mpath)
            if args.debug and (n + 1) % 10 == 0:
                sys.stderr.write(f"match_debug: rendered {n+1}/{len(sel)} points\n")

        listf = os.path.join(tmpdir, "list.txt")
        with open(listf, "w") as fh:
            for f in seg_files:
                fh.write(f"file '{f}'\n")
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0",
                        "-i", listf, "-c", "copy", "-movflags", "+faststart",
                        args.output], check=True)
    finally:
        for f in os.listdir(tmpdir):
            try:
                os.remove(os.path.join(tmpdir, f))
            except OSError:
                pass
        os.rmdir(tmpdir)

    if args.debug:
        sys.stderr.write(f"match_debug: wrote {args.output} ({len(seg_files)} points)\n")
    return 0


def _has_audio(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a",
                          "-show_entries", "stream=index", "-of", "csv=p=0", path],
                         capture_output=True, text=True).stdout.strip()
    return bool(out)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"match_debug: unexpected error: {exc}\n")
        sys.exit(1)
