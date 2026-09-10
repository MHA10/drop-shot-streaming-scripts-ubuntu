#!/usr/bin/env python3
"""
match_shots_debug.py — a watchable overlay that puts the shot detector's output
back onto the footage, so its count and its team/end/zone tags can be checked by
eye and ear instead of on trust.

── IN SIMPLE WORDS ──
The shot detector (match_shots.py) says, for each rally: how many shots there
were, which team hit each one, and whether each was played at the net or back by
the glass. This turns those numbers into a video. Watch it with the SOUND ON:
every time the detector thinks a shot was struck, a coloured box flashes on the
player it blamed and a label lights up — SHOT 5 · TEAM B · FAR · attack. If the
flash lands on a real crack you can hear, and on a real player at the right end,
the detection is working. A tick-strip along the bottom is the whole rally, so
you can see the count build.

── BUSINESS RULES ──
- One rally at a time, `--pre` s before its first strike to `--post` s after the
  last, so the serve and the finish are both on screen.
- Shot k's marker is a SHORT flash CENTRED on the strike (a touch before, gone
  just after), not a long forward hold — a hold lingered through the follow-
  through into the next swing and read as "always on the last hitter".
- Team, end and zone are read straight from the cached JSON, index-aligned to the
  strikes — no re-analysis. The panel prints the honest confidence: the COUNT is
  solid, team/end past the serve is only directional (see the DO NOT section).

── WHY IT'S BUILT THIS WAY (change at your peril) ──
- **Frames are piped from ffmpeg as rawvideo, audio cut to the frames actually
  rendered.** Same reasons as match_debug.py: JPEG round-trips are wasteful, and
  cutting audio to the request instead of to reality would drift the flash off
  the crack it is meant to sit on — making a working detector look broken.
- **Strike boxes are in the letterbox-stripped court frame's own pixels** (they
  were divided back out of proc-width in match_lastshot.py), so `--input` MUST be
  the SAME crop the analysis ran on, or every box lands off its player.

── DO NOT ──
- Do NOT read a shot marker as a per-PLAYER claim. The box marks the end/side the
  shot came from; which of the two teammates it was is not established past the
  serve (identity is solved only at the serve instant). The team tag inherits
  that — trustworthy on the serve, directional deep in a rally.
- Do NOT judge the count with the sound off. The flash is a claim about audio.
- Do NOT read the count as the score. It counts audible contacts, not points.
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
    sys.stderr.write(f"match_shots_debug: dependencies unavailable: {exc}\n")
    sys.exit(2)

FG = (255, 255, 255)
DIM = (150, 150, 150)
PANEL = (34, 28, 24)
NEAR_C = (98, 232, 127)      # mint  = near end
FAR_C = (56, 168, 255)       # amber = far end
# team colours (BGR) — deliberately far apart so A vs B reads at a glance
TEAM_C = {"Team A": (255, 208, 40), "Team B": (0, 165, 255)}
NEUTRAL = (170, 170, 170)
# zone colours (BGR)
ZONE_C = {"attack": (70, 70, 255), "mid": (60, 200, 255), "defence": (235, 190, 90)}
ZONE_LABEL = {"attack": "NET / attack", "mid": "mid-court", "defence": "glass / defence"}


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                          "-show_entries", "stream=width,height,r_frame_rate",
                          "-of", "default=nw=1:nk=1", path],
                         capture_output=True, text=True).stdout.split()
    w, h = int(out[0]), int(out[1])
    num, den = out[2].split("/")
    return w, h, float(num) / float(den)


def has_audio(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a",
                          "-show_entries", "stream=index", "-of", "csv=p=0", path],
                         capture_output=True, text=True).stdout.strip()
    return bool(out)


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


def chip(img, s, x, y, col, scale=0.5, pad=5):
    """A filled label chip; returns the x just past it, for laying chips in a row."""
    (tw, th), _ = cv2.getTextSize(s, cv2.FONT_HERSHEY_DUPLEX, scale, 1)
    cv2.rectangle(img, (int(x), int(y - th - pad)), (int(x + tw + 2 * pad), int(y + pad)),
                  col, -1)
    lum = 0.114 * col[0] + 0.587 * col[1] + 0.299 * col[2]
    text(img, s, x + pad, y - 1, scale, (0, 0, 0) if lum > 140 else FG, 1)
    return x + tw + 2 * pad


def draw_strike_strip(canvas, x0, y0, w, h, strikes, teams, t0, t1, now, fps):
    """Ticks at each detected shot, coloured by team; the playhead sweeps across."""
    span = max(0.5, t1 - t0)
    cv2.rectangle(canvas, (x0, y0), (x0 + w, y0 + h), (60, 52, 46), -1)
    cv2.rectangle(canvas, (x0, y0), (x0 + w, y0 + h), DIM, 1)
    for k, s in enumerate(strikes):
        x = int(x0 + (s["t"] - t0) / span * w)
        tc = TEAM_C.get(teams[k] if k < len(teams) else None, NEUTRAL)
        hot = abs(now - s["t"]) < 0.10
        cv2.line(canvas, (x, y0 + 2), (x, y0 + h - 2), tc, 3 if hot else 2)
        if hot:
            cv2.circle(canvas, (x, y0 - 6), 5, tc, -1)
    px = int(x0 + np.clip((now - t0) / span, 0, 1) * w)
    cv2.line(canvas, (px, y0), (px, y0 + h), (90, 200, 255), 2)
    text(canvas, f"{len(strikes)} shots", x0, y0 - 9, 0.42, DIM)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--input", required=True, help="letterbox-stripped match video (same crop the analysis ran on)")
    ap.add_argument("--audio-from", default="", help="take audio from this file instead (same timeline)")
    ap.add_argument("--lastshot", required=True, help="lastshot.json (per-strike t + box + end)")
    ap.add_argument("--shots", required=True, help="shots.json (per-shot team + zone)")
    ap.add_argument("--refined", required=True, help="refined.json (rally start/end)")
    ap.add_argument("--players", default="", help="players.json (teams, for the legend)")
    ap.add_argument("--labels", default="", help="P1=NAME,... for the team legend")
    ap.add_argument("--points", default="", help="comma list of point numbers to render, e.g. 4,7,18,29")
    ap.add_argument("--limit", type=int, default=0, help="if no --points: the N rallies with most shots")
    ap.add_argument("--output", required=True)
    ap.add_argument("--pre", type=float, default=2.5)
    ap.add_argument("--post", type=float, default=1.5)
    ap.add_argument("--offset", type=float, default=0.0,
                    help="shift the box EARLIER than the audio strike by this many seconds "
                         "(audio/video alignment nudge). Positive = box appears sooner.")
    ap.add_argument("--flash-pre", type=float, default=0.10, help="box appears this long before the strike")
    ap.add_argument("--flash-post", type=float, default=0.22, help="box clears this long after the strike")
    ap.add_argument("--width", type=int, default=1280)
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()

    ls = {p["point"]: p for p in json.load(open(args.lastshot))["points"]}
    sh = {p["point"]: p for p in json.load(open(args.shots))["points"]}
    rf = {p["point"]: p for p in json.load(open(args.refined))["points"]}

    lab = {}
    for part in filter(None, args.labels.split(",")):
        k, _, v = part.partition("=")
        lab[k.strip()] = v.strip()
    teams = None
    if args.players:
        teams = json.load(open(args.players)).get("teams")

    # which rallies
    if args.points:
        want = [int(x) for x in args.points.split(",") if x.strip()]
    else:
        cand = sorted(sh.values(), key=lambda p: -p.get("shots", 0))
        want = [p["point"] for p in cand[:max(1, args.limit or 4)]]
    sel = [pt for pt in want if pt in ls and pt in sh and pt in rf and ls[pt].get("strikes")]
    if not sel:
        sys.stderr.write("match_shots_debug: none of the requested rallies have strike data\n")
        return 4

    sw, sh_h, fps = probe(args.input)
    VW = args.width
    VH = int(round(sh_h * VW / sw)) // 2 * 2
    PANEL_H = 150
    W, H = VW, VH + PANEL_H
    scale = VW / sw

    tmpdir = tempfile.mkdtemp(prefix="shotsdbg.")
    seg_files = []
    total_shots_seen = 0
    try:
        for n, pt in enumerate(sel):
            strikes = ls[pt]["strikes"]
            s_teams = sh[pt].get("shot_teams", [])
            s_zones = sh[pt].get("shot_zones", [])
            server = sh[pt].get("server")
            r = rf[pt]
            first_t = strikes[0]["t"]
            last_t = strikes[-1]["t"]
            t0 = max(0.0, min(r.get("start", first_t), first_t) - args.pre)
            t1 = max(r.get("end", last_t), last_t) + args.post

            vpath = os.path.join(tmpdir, f"v{n:04d}.mp4")
            writer = cv2.VideoWriter(vpath, cv2.VideoWriter_fourcc(*"mp4v"), fps, (W, H))
            if not writer.isOpened():
                raise SystemExit("match_shots_debug: cannot open segment writer")

            nf = 0
            for frame in read_segment(args.input, t0, t1 - t0, VW, VH):
                now = t0 + nf / fps
                canvas = np.zeros((H, W, 3), np.uint8)
                canvas[:VH] = frame
                canvas[VH:] = PANEL

                done = sum(1 for s in strikes if s["t"] <= now + 0.5 / fps)
                # last shot resolved so far (for the persistent HUD chip)
                last_k = done - 1

                # A tight flash CENTRED on each strike — NOT a long forward hold.
                # A 0.45s forward hold made the box linger through the follow-through
                # and into the next player's swing, so it read as "always on the last
                # hitter" (feedback 2026-09-06). Centring a short pop on the contact
                # fixes that; --offset nudges for any audio/video lead in the stream.
                for k, s in enumerate(strikes):
                    ts = s["t"] - args.offset
                    dt = now - ts
                    if dt < -args.flash_pre or dt > args.flash_post:
                        continue
                    tm = s_teams[k] if k < len(s_teams) else None
                    zn = s_zones[k] if k < len(s_zones) else None
                    tc = TEAM_C.get(tm, NEUTRAL)
                    box = s.get("box")
                    fresh = abs(dt) < 0.5 / fps       # the contact frame itself
                    if box:
                        x1, y1, x2, y2 = [int(v * scale) for v in box]
                        th = 4 if abs(dt) < 0.10 else 2
                        cv2.rectangle(canvas, (x1, y1), (x2, y2), tc, th)
                        if fresh:                     # ring pop on the contact frame
                            cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
                            cv2.circle(canvas, (cx, cy), 26, (90, 255, 255), 3)
                        cap = f"SHOT {k+1}  {tm or 'team ?'}  {s['end'].upper()}"
                        cx = chip(canvas, cap, x1, max(20, y1 - 8), tc, 0.5)
                        if zn:
                            chip(canvas, ZONE_LABEL.get(zn, zn), x1, min(VH - 4, y2 + 20),
                                 ZONE_C.get(zn, DIM), 0.46)
                    if fresh:                          # brief full-frame flash
                        ov = canvas[:VH].copy()
                        cv2.rectangle(ov, (0, 0), (VW, VH), tc, -1)
                        cv2.addWeighted(ov, 0.10, canvas[:VH], 0.90, 0, canvas[:VH])

                # top banner
                cv2.rectangle(canvas, (0, 0), (VW, 34), (0, 0, 0), -1)
                text(canvas, f"RALLY {pt}", 12, 24, 0.66, FG, 2)
                srv = f"  server {lab.get(server, server)}" if server else ""
                text(canvas, f"t={now:7.2f}s   shot {done}/{len(strikes)}{srv}",
                     190, 24, 0.5, DIM)
                live = first_t - 0.05 <= now <= last_t + 0.05
                if live:
                    cv2.circle(canvas, (VW - 22, 17), 8, (90, 255, 120), -1)
                    text(canvas, "RALLY", VW - 100, 24, 0.5, (90, 255, 120))
                elif now < first_t:
                    text(canvas, "SERVE", VW - 100, 24, 0.5, (120, 190, 255))
                else:
                    text(canvas, "OVER", VW - 90, 24, 0.5, DIM)

                # panel
                py = VH + 22
                if 0 <= last_k < len(strikes):
                    tm = s_teams[last_k] if last_k < len(s_teams) else None
                    zn = s_zones[last_k] if last_k < len(s_zones) else None
                    x = chip(canvas, f"last: SHOT {last_k+1}", 14, py, (70, 62, 56), 0.5)
                    x = chip(canvas, f"{tm or 'team ?'}", x + 8, py, TEAM_C.get(tm, NEUTRAL), 0.5)
                    x = chip(canvas, strikes[last_k]["end"].upper() + " end", x + 8, py,
                             FAR_C if strikes[last_k]["end"] == "far" else NEAR_C, 0.5)
                    if zn:
                        chip(canvas, ZONE_LABEL.get(zn, zn), x + 8, py, ZONE_C.get(zn, DIM), 0.5)
                else:
                    text(canvas, "waiting for first strike...", 14, py, 0.5, DIM)

                draw_strike_strip(canvas, 14, VH + 44, VW - 28, 30, strikes, s_teams,
                                  t0, t1, now, fps)

                # honest footer: what to trust
                text(canvas, "count = solid (each flash should land on a crack you hear)   |   "
                             "team & end past the serve = directional, not proven",
                     14, VH + PANEL_H - 26, 0.42, DIM)
                if teams:
                    lx = chip(canvas, "Team A " + "+".join(lab.get(x, x) for x in teams[0]),
                              14, VH + PANEL_H - 6, TEAM_C["Team A"], 0.42)
                    chip(canvas, "Team B " + "+".join(lab.get(x, x) for x in teams[1]),
                         lx + 8, VH + PANEL_H - 6, TEAM_C["Team B"], 0.42)

                writer.write(canvas)
                nf += 1
            writer.release()
            if nf == 0:
                continue
            total_shots_seen += len(strikes)

            apath = os.path.join(tmpdir, f"a{n:04d}.wav")
            asrc = args.audio_from or args.input
            if has_audio(asrc):
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
            if args.debug:
                sys.stderr.write(f"match_shots_debug: rally {pt} — {len(strikes)} shots\n")

        if not seg_files:
            sys.stderr.write("match_shots_debug: nothing rendered\n")
            return 4
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
        sys.stderr.write(f"match_shots_debug: wrote {args.output} "
                         f"({len(seg_files)} rallies, {total_shots_seen} shots)\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"match_shots_debug: unexpected error: {exc}\n")
        sys.exit(1)
