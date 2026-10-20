#!/usr/bin/env python3
"""
live_stats.py — build the player heatmap + stats NEAR-LIVE, from the stream's own
video chunks, while the match is being streamed, without touching the ffmpeg pipeline.

── IN SIMPLE WORDS ──
While the match is streaming, this program keeps these files on disk up to date: a
numbers file (how far each player ran, time at the net, the team's shape), a
picture of the four "where did they stand" court maps, the same map for each player
on its own, and a small photo sheet of each player (a few cut-outs of them from the
first minutes of play) so a person can later say "player A is me". It builds them from
short video chunks — ideally the SAME chunks the stream already writes for making
highlight reels, so nothing is captured twice. If those chunks aren't being written
(the highlight buffer is off), it can instead grab its own short slices straight
off the camera. Either way it runs the player-finder slowly (a few looks per second,
not every frame) so it fits on this graphics-card-less box next to ffmpeg, and it
prints how long each chunk took to process versus how long the chunk was — so you
can see at a glance whether the box is keeping up.

── BUSINESS RULES ──
- v1 near-live path (decision 2026-10-09): a standalone reader, deployed like the
  live-score script, because this box keeps NO recording of the match to process
  afterwards. See docs/v1-stats-spec.md §6 and docs/live-stats.md.
- TWO SOURCES of video chunks:
    * buffer  — REUSE the streamer's highlight-buffer chunks (seg-<run>-<epoch>.ts),
                a second output of the live ffmpeg (NodeFFmpegService.ts). No second
                camera connection, no second capture. Needs the buffer turned on.
    * camera  — this program runs its OWN ffmpeg that slices the camera into clips.
                A fallback for when the buffer is off; opens its own camera connection,
                so point it at the low-res second stream (…/Channels/102).
- The player-finder runs at a REDUCED rate (default ~3 looks/sec), never every frame.
- Outputs are LOCAL FILES in --out-dir: stats.json, heatmap.png (all four maps),
  heatmap-A..D.png (one map per player) and photo-A..D.jpg (one photo sheet per player).
  The streamer uploads the pictures and sends the links with the numbers
  (MatchStatsOutbox.ts); the product shows each player's own map and photo sheet, and
  the venue/players use the photos to put real names on A–D (2026-10-20).
- Player photos come only from the FIRST PHOTO_WINDOW_SEC of tracked play. Labels A–D
  follow the end of the court a player is on, and pairs change ends every two games, so
  later in the match a label can hold a different person. Early crops keep each sheet to
  one person in the usual case (a player not seen until after the first change of ends
  can still end up on the wrong sheet — same root cause as memory 'stats-end-change-bug').
- Court calibration is done ONCE and saved to court.json; reused on every later chunk.

── WHY IT'S BUILT THIS WAY (change at your peril) ──
- THE DETECTOR IS LOADED ONCE AND KEPT RESIDENT. Loading yolo11s costs a few seconds.
  The highlight-buffer chunks are only a few seconds long each, so reloading the model
  per chunk would cost more than the chunk itself and the reader could never keep up.
  We load it once at startup and feed every chunk to the same model (track_players.
  detect_all(..., model=resident)). This is THE reason buffer-reuse is viable.
- THE DETECTOR'S THREADS ARE CAPPED (default 2). Without a cap, torch/OpenCV grab every
  core; on this 4-core box they would fight the live ffmpeg encode for CPU and the
  BROADCAST ITSELF would hitch. We leave cores for ffmpeg + the OS on purpose. If you
  ever see the stream stutter when stats run, lower --threads, do not raise it.
- STATS + HEATMAP ARE COMPUTED IN-PROCESS, NOT by shelling out. We already hold the
  tracks in memory; re-launching a python and re-reading the growing file every few
  seconds was pure wasted startup+parse cost that grew with the match. We call
  player_stats.compute_stats(...) and build the heat grid directly instead.
- THE HEAT GRID IS KEPT RUNNING, NOT RE-WALKED. Each new chunk's foot points are added
  to a per-player grid as they arrive (one cell += 1 per sample); the picture is just
  that grid divided by the sample count and blurred. Re-accumulating the whole match on
  every redraw was O(match-length²) — fine at minute 1, choking by minute 90.
- THE MASTER FILE IS A CRASH CHECKPOINT, written on a TIMER (default 60s), not every
  chunk. Resume reads it; the live numbers come from memory. Rewriting the whole growing
  file every 2-second chunk was the single worst scaling cost.
- WE DO NOT RE-COUNT ON RESTART. The master carries a HIGH-WATER MARK (newest chunk epoch
  already folded in) and, in buffer mode, the ffmpeg RUN TOKEN from the chunk names. On
  restart we skip any chunk at or before the high-water mark, so a crash-resume never adds
  the same clips twice (which used to roughly DOUBLE that window's distance and scramble
  identity). A different run token means a new match → we start fresh.
- WE NEVER TOUCH THE CHUNK FILE STILL BEING WRITTEN. The newest chunk (by timestamp) is
  mid-write; a half-written file decodes to garbage. We only process chunks that are no
  longer the newest. In buffer mode we also NEVER delete a chunk — the streamer/buffer
  manager owns their lifecycle (retention + pinning); we only read. In camera mode we own
  the files and delete each after processing.
- A CAMERA THAT KEEPS REFUSING US IS RETRIED WITH A GROWING WAIT (3 s doubling to
  SEGMENTER_MAX_WAIT_SEC, back to 3 s after a run that stayed connected for at least one
  full chunk). A flat 3 s retry against a
  camera that refuses the low-res address is ~1,200 connection attempts an hour on the
  same camera the broadcast reads, plus a warning line each time. The wait is cut short
  by a stop request, so a stop is never held up by it.
- WE STAY LIVE WHEN WE FALL BEHIND. If the queue of ready chunks grows past --drop-backlog,
  we JUMP to the newest ready chunk and drop the stale ones (the stats are cumulative, so a
  few dropped sample-chunks cost almost nothing; staleness costs the whole point). In buffer
  mode dropped chunks may anyway be evicted by the reel system before we would reach them.
- THE MASTER IS DOWNSAMPLED to the detection rate and its fps set to match. track_players
  holds each detection across skipped frames (sample-and-hold), so slicing to the real
  detection points keeps the file small AND keeps player_stats' speed/time windows honest.
- IDENTITY IS STITCHED ACROSS CHUNKS per team, WITH A MARGIN. Each chunk labels players
  A/B/C/D on its own; between chunks the two partners on a side can come back swapped. We
  un-swap by nearest last-known position — but only when the swap is CLEARLY better (by
  --swap-margin), because partners often stand close and a coin-flip swap permanently
  crosses their heatmaps. When it's within noise we leave it. Teams never cross the net in
  padel, so only left/right within a half can flip — that is all we correct.
- PHOTO CROPS ARE CUT WHILE THE CHUNK IS STILL ON DISK and saved as files under photos/.
  Camera mode deletes each chunk right after processing, so a crop can't be taken later;
  and keeping the crops on disk (not in memory) means a restart mid-match keeps them.
  At most one crop per player per chunk, at least PHOTO_GAP_SEC apart, never a box that
  overlaps another player — so each cut-out shows one person in different moments, not
  six near-copies of the same frame. The frame is reached by READING FORWARD, the way
  detect_all counted frames, not by seeking to a frame number: OpenCV turns a frame number
  into a time using the average frame rate, and a camera's uneven timing would land on a
  different frame than the box came from.
- PHOTO SHEETS ARE REDRAWN ONLY WHEN A CUT-OUT WAS ADDED, and the logo is loaded once
  (player_heatmap._logo_for). Both run every chunk next to the live encode; nothing reads
  the pictures before the match ends, so redrawing unchanged ones was pure waste.
- A CROP MUST BE ON ITS LABEL'S SIDE OF THE NET (A/B far, C/D near; teams never cross the
  net) AND OF TYPICAL SIZE for that player in the chunk, not the biggest. Tested 2026-10-20:
  picking the biggest box put a near player on far player A's sheet — when the tracker
  briefly jumps a label onto the wrong person, that box is unusually big (near players are
  closer to the camera), so "biggest" selects exactly the glitches.
- A RECENT MASTER IS RESUMED ON RESTART. pm2 restarts (crash, OOM) would otherwise drop the
  whole match. On startup, if master-tracks.json is newer than --resume-window seconds we
  continue from it; older than that it's a previous match and we start fresh.

── DO NOT ──
- Do NOT delete or rename buffer chunks (buffer mode) — the highlight/reel system depends on
  them. We read-only there.
- Do NOT run camera mode against the SAME HD URL ffmpeg already pulls and assume it is free —
  it opens its OWN connection. Use the low-res second stream (…/Channels/102).
- Do NOT raise --threads to "go faster" — every core you take is a core ffmpeg may need for
  the live broadcast. The stats are allowed to be slow; the stream is not.
- Do NOT widen PHOTO_WINDOW_SEC to "get better photos" — after a change of ends the label
  holds the other pair's player, and the photo sheet would show two different people.
- Do NOT trust a player's stats when their detection_rate is low (camera kept losing them) —
  distance/times under-count. Gate in the product (~0.60, spec §5); the per-chunk log prints
  it so a low one is visible here too.
- Do NOT raise --target-fps/--imgsz blindly — every bump costs CPU shared with ffmpeg. Watch
  the "xN realtime" and backlog in the log and stop while there is still headroom. Judge
  keep-up LATE in a match, not in the first minute.

RUN — reuse the streamer's buffer chunks (preferred, no second capture):
  python3 scripts/live_stats.py --source buffer \
    --buffer-dir /path/to/streamer/highlight-buffer --out-dir ./live-stats-out \
    --target-fps 3 --imgsz 960

RUN — standalone off the camera (buffer off):
  python3 scripts/live_stats.py --source camera \
    --camera "rtsp://admin:PASS@192.168.18.220:554/Streaming/Channels/102" \
    --out-dir ./live-stats-out --clip-sec 30 --target-fps 3 --imgsz 960 --max-clips 4

RUN under pm2: see scripts/live-stats.ecosystem.config.js
"""

import argparse
import glob
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
LABELS = ("A", "B", "C", "D")
_EPOCH_RE = re.compile(r"-(\d+)\.ts$")           # seg-<run>-<epoch>.ts → epoch
_SEG_RE = re.compile(r"seg-(.+)-(\d+)\.ts$")     # seg-<run>-<epoch>.ts → (run, epoch)


# ── chunk naming (buffer mode) ──
def _epoch_of(path):
    """Epoch seconds from a seg-<run>-<epoch>.ts name, or None for other names."""
    m = _EPOCH_RE.search(os.path.basename(path))
    return int(m.group(1)) if m else None


def _run_of(path):
    """ffmpeg run token from a seg-<run>-<epoch>.ts name, or None. Identifies the match."""
    m = _SEG_RE.search(os.path.basename(path))
    return m.group(1) if m else None


def _sort_key(path):
    e = _epoch_of(path)
    return (0, e) if e is not None else (1, os.path.basename(path))


# ── cross-chunk identity stitch ──
def _last_foot(seq):
    for s in reversed(seq):
        if s and s.get("solid"):
            return s["foot"]
    return None


def _first_foot(seq):
    for s in seq:
        if s and s.get("solid"):
            return s["foot"]
    return None


def _sqdist(a, b):
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2


def _maybe_swap(master_tracks, clip_tracks, p, q, margin):
    """
    Un-flip a side's two partners if they came back left/right swapped — but ONLY when
    swapping is clearly better, not just marginally (header: 'WITH A MARGIN').

    Returns True if it swapped. `margin` is the fraction by which the swapped cost must
    beat the straight cost; partners often stand close, so near-ties are left alone to
    avoid a coin-flip that permanently crosses the two players' trails.
    """
    ml, mr = _last_foot(master_tracks[p]), _last_foot(master_tracks[q])
    cl, cr = _first_foot(clip_tracks[p]), _first_foot(clip_tracks[q])
    if None in (ml, mr, cl, cr):
        return False
    straight = _sqdist(ml, cl) + _sqdist(mr, cr)
    swapped = _sqdist(ml, cr) + _sqdist(mr, cl)
    if swapped < straight * (1.0 - margin):
        clip_tracks[p], clip_tracks[q] = clip_tracks[q], clip_tracks[p]
        return True
    return False


# ── the resident detector: track_players' tested pipeline, model loaded once ──
class TrackEngine:
    """Hold yolo11s in memory and run the track_players pipeline per chunk in-process."""

    def __init__(self, model_path, conf, imgsz, device, court_hsv, court_json,
                 lock_sec, max_jump_frac, coast_frames, smooth_win, threads,
                 static_refresh, verbose=False):
        self.model_path = model_path
        self.conf, self.imgsz = conf, imgsz
        self.lock_sec, self.max_jump_frac = lock_sec, max_jump_frac
        self.coast_frames, self.smooth_win = coast_frames, smooth_win
        self.verbose, self.court_json = verbose, court_json
        self.static_refresh = max(1, static_refresh)
        hv = [int(v) for v in court_hsv.split(",")]
        self.hsv_lo, self.hsv_hi = hv[:3], hv[3:6]
        self.device = device or ("mps" if sys.platform == "darwin" else "")
        sys.path.insert(0, SCRIPTS_DIR)
        # Cap threads BEFORE/at model load so torch's pools size small (see header).
        import cv2
        cv2.setNumThreads(max(1, threads))
        try:
            import torch
            torch.set_num_threads(max(1, threads))
        except Exception:   # noqa: BLE001 — torch may be absent on some builds
            pass
        from ultralytics import YOLO
        sys.stderr.write(f"[live_stats] loading detector {model_path} "
                         f"(device='{self.device or 'cpu'}', threads={threads})…\n")
        self.model = YOLO(model_path)
        self._court = None
        self._static = None          # cached empty-court "people" (banners, seated ref)
        self._static_count = 0       # chunks since the static scan was refreshed
        self._load_court_if_present()

    def _load_court_if_present(self):
        from track_players import CourtModel
        if self._court is None and os.path.exists(self.court_json):
            with open(self.court_json) as fh:
                cj = json.load(fh)
            self._court = CourtModel(cj["mL"], cj["bL"], cj["mR"], cj["bR"],
                                     cj["y_top"], cj["y_bot"], cj["y_net"])
            sys.stderr.write(f"[live_stats] court calibration loaded from {self.court_json}\n")

    def _court_dict(self):
        c = self._court
        return None if c is None else {"mL": c.mL, "bL": c.bL, "mR": c.mR, "bR": c.bR,
                                       "y_top": c.y_top, "y_bot": c.y_bot, "y_net": c.y_net}

    def process_clip(self, path, target_fps):
        """
        Return a dump-tracks-shaped payload for one chunk, or None if the chunk is
        unusable for ANY reason. This must NEVER raise: the caller is a long-running
        loop, and track_players uses `raise SystemExit(...)` as a soft "couldn't find
        4 players / couldn't open" signal, which on a near-live feed happens constantly
        (players off-screen between points). One bad chunk is skipped, not fatal.
        """
        try:
            import cv2
            from track_players import (LABELS as TL, detect_all, assign_slots,
                                       smooth_tracks, calibrate, median_frame,
                                       _static_people)
            cap = cv2.VideoCapture(path)
            if not cap.isOpened():
                return None
            fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
            w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            ok, _probe = cap.read()        # confirm it actually decodes — do NOT trust
            cap.release()                  # CAP_PROP_FRAME_COUNT, which is garbage on .ts
            if w == 0 or h == 0 or not ok:
                return None

            every = max(1, round(fps / target_fps)) if target_fps > 0 else 1
            sampled_fps = round(fps / every, 3)

            med = median_frame(path)
            if self._court is None:
                self._load_court_if_present()
            if self._court is None:                  # calibrate once, then reuse forever
                court, note = calibrate(path, self.hsv_lo, self.hsv_hi, "", med)
                if court is not None:
                    self._court = court
                    with open(self.court_json, "w") as fh:
                        json.dump(self._court_dict(), fh, indent=2)
                    sys.stderr.write(f"[live_stats] calibrated court from "
                                     f"{os.path.basename(path)}: {note}\n")
                else:
                    sys.stderr.write(f"[live_stats] no court yet ({note}); retrying next chunk\n")
            court = self._court
            poly = court.polygon() if court is not None else None

            # Refresh the static-background scan only every N chunks (header): the empty
            # court barely changes between adjacent 2s chunks, so reusing it saves ~1
            # YOLO inference per chunk.
            if self._static is None or self._static_count >= self.static_refresh:
                self._static = _static_people(med, self.model, self.imgsz, self.device or None)
                self._static_count = 0
            else:
                self._static_count += 1

            per_frame = detect_all(path, self.model_path, self.conf, self.imgsz,
                                   self.device or None, court, poly, every,
                                   self.verbose, med, model=self.model, static=self._static)
            if not per_frame:
                return None
            lock_idx = min(len(per_frame) - 1, max(0, int(self.lock_sec * fps)))
            tracks, used_lock = assign_slots(per_frame, lock_idx, w, h,
                                             self.max_jump_frac * w, self.coast_frames)
            tracks = smooth_tracks(tracks, self.smooth_win)
            return {
                "video": path, "fps": fps, "width": w, "height": h,
                "frames": len(per_frame), "lock_frame": used_lock,
                "every": every, "sampled_fps": sampled_fps,
                "court": self._court_dict(),
                "tracks": {
                    L: [None if s is None else {
                        "box": [round(float(v), 1) for v in s["box"]],
                        "foot": [round(float(s["foot"][0]), 1), round(float(s["foot"][1]), 1)],
                        "solid": bool(s["solid"]),
                    } for s in tracks[L]]
                    for L in TL
                },
            }
        except (Exception, SystemExit) as exc:   # noqa: BLE001 — one chunk must never kill the loop
            sys.stderr.write(f"[live_stats] skipping {os.path.basename(path)} "
                             f"({type(exc).__name__}: {str(exc)[:160]})\n")
            return None


# ── player photos: a few cut-outs of each player, so a person can say "A is me" ──
SEGMENTER_MAX_WAIT_SEC = 300   # longest wait between camera reconnects (header)

PHOTO_MAX = 6              # cut-outs per player on the photo sheet
PHOTO_GAP_SEC = 20.0       # min tracked-play seconds between two cut-outs of one player
PHOTO_WINDOW_SEC = 360.0   # only from the first 6 min of tracked play (header: DO NOT)
PHOTO_MIN_H = 40           # px; a smaller box is too blurry to recognise anyone
PHOTO_PAD = 0.15           # margin around the box, as a share of its size
PHOTO_MAX_OVERLAP = 0.10   # skip a box this much covered by another player's box
PHOTO_CELL = (120, 220)    # (w, h) of one cut-out on the sheet
FAR_LABELS = ("A", "B")    # same split as player_stats.TEAMS


def _covered(a, b):
    """Share of box a covered by box b."""
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    return ix * iy / max(1e-6, (a[2] - a[0]) * (a[3] - a[1]))


def _crop(frame, box):
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = box
    px, py = (x2 - x1) * PHOTO_PAD, (y2 - y1) * PHOTO_PAD
    x1, y1 = max(0, int(x1 - px)), max(0, int(y1 - py))
    x2, y2 = min(w, int(x2 + px)), min(h, int(y2 + py))
    if x2 - x1 < 4 or y2 - y1 < 4:
        return None
    return frame[y1:y2, x1:x2]


def _fit(img, w, h):
    """Scale img to fit inside w×h and centre it on a dark cell."""
    import cv2
    import numpy as np
    cell = np.full((h, w, 3), 24, np.uint8)
    ih, iw = img.shape[:2]
    k = min(w / iw, h / ih)
    nw, nh = max(1, int(iw * k)), max(1, int(ih * k))
    small = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA if k < 1 else cv2.INTER_CUBIC)
    x, y = (w - nw) // 2, (h - nh) // 2
    cell[y:y + nh, x:x + nw] = small
    return cell


class PhotoState:
    """Cut-outs of each player, saved under <out-dir>/photos/<label>/NN.jpg."""

    def __init__(self, out_dir):
        self.out_dir = out_dir
        self.dir = os.path.join(out_dir, "photos")
        self.count = {}
        self.last_t = {}
        self.drawn = {}            # cut-out count each photo sheet was last drawn with
        self._scan()

    def _scan(self):
        for L in LABELS:
            self.count[L] = len(glob.glob(os.path.join(self.dir, L, "*.jpg")))
            self.last_t[L] = float("-inf")
            self.drawn[L] = -1

    def reset(self):
        """New match: drop the previous match's cut-outs and photo sheets."""
        shutil.rmtree(self.dir, ignore_errors=True)
        for L in LABELS:
            try:
                os.remove(os.path.join(self.out_dir, f"photo-{L}.jpg"))
            except OSError:
                pass
        self._scan()

    def collect(self, clip_path, new_samples, every, start_sample, fps, court):
        """Cut at most one new cut-out per player from this chunk. Never raises."""
        try:
            if not fps or not court or all(self.count[L] >= PHOTO_MAX for L in LABELS):
                return            # no court yet = can't check the side of the net
            y_net = court["y_net"]
            picks = {}                 # frame index in the chunk -> [(label, box, t)]
            for L in LABELS:
                if self.count[L] >= PHOTO_MAX:
                    continue
                far = L in FAR_LABELS
                ok = []
                for k, s in enumerate(new_samples[L]):
                    if not s or not s.get("solid") or not s.get("box"):
                        continue
                    t = (start_sample + k) / fps
                    if t > PHOTO_WINDOW_SEC or t - self.last_t[L] < PHOTO_GAP_SEC:
                        continue
                    box = s["box"]
                    tall = box[3] - box[1]
                    if tall < PHOTO_MIN_H:
                        continue
                    if (s["foot"][1] < y_net) != far:     # wrong side of the net
                        continue
                    others = (new_samples[O][k] for O in LABELS
                              if O != L and k < len(new_samples[O]))
                    if any(o and o.get("box") and _covered(box, o["box"]) > PHOTO_MAX_OVERLAP
                           for o in others):
                        continue
                    ok.append((tall, k, box, t))
                if ok:
                    mid = sorted(c[0] for c in ok)[len(ok) // 2]
                    _, k, box, t = min(ok, key=lambda c: abs(c[0] - mid))
                    picks.setdefault(k * every, []).append((L, box, t))
            if not picks:
                return
            import cv2
            cap = cv2.VideoCapture(clip_path)
            try:
                pos = 0                    # next frame index the decoder will return
                for idx in sorted(picks):
                    while pos < idx and cap.grab():   # read forward (header 'PHOTO CROPS')
                        pos += 1
                    ok, frame = cap.read() if pos == idx else (False, None)
                    if not ok:
                        break
                    pos += 1
                    for L, box, t in picks[idx]:
                        crop = _crop(frame, box)
                        if crop is None:
                            continue
                        d = os.path.join(self.dir, L)
                        os.makedirs(d, exist_ok=True)
                        cv2.imwrite(os.path.join(d, f"{self.count[L]:02d}.jpg"), crop,
                                    [cv2.IMWRITE_JPEG_QUALITY, 92])
                        self.count[L] += 1
                        self.last_t[L] = t
            finally:
                cap.release()
        except Exception as exc:   # noqa: BLE001 — a photo error must not kill the loop
            sys.stderr.write(f"[live_stats] player photo failed: {exc}\n")


def render_photo_sheets(photos, out_dir, names_map):
    """photo-<L>.jpg: that player's cut-outs side by side, labelled. Never raises."""
    try:
        import cv2
        sys.path.insert(0, SCRIPTS_DIR)
        from player_heatmap import background, put_centered
        cw, ch = PHOTO_CELL
        gap, head = 8, 44
        for L in LABELS:
            out = os.path.join(out_dir, f"photo-{L}.jpg")
            if photos.drawn[L] == photos.count[L] and os.path.exists(out):
                continue                   # nothing new (header 'PHOTO SHEETS')
            files = sorted(glob.glob(os.path.join(photos.dir, L, "*.jpg")))[:PHOTO_MAX]
            imgs = [im for im in (cv2.imread(f) for f in files) if im is not None]
            if not imgs:
                continue
            cols = min(3, len(imgs))
            rows = (len(imgs) + cols - 1) // cols
            W = cols * cw + (cols + 1) * gap
            H = head + rows * ch + (rows + 1) * gap
            base = background(W, H)
            put_centered(base, _player_title(L, names_map), W / 2, head * 0.72, 0.8,
                         (255, 255, 255), 2)
            for i, img in enumerate(imgs):
                r, c = divmod(i, cols)
                x, y = gap + c * (cw + gap), head + gap + r * (ch + gap)
                base[y:y + ch, x:x + cw] = _fit(img, cw, ch)
            tmp = out + ".tmp.jpg"
            cv2.imwrite(tmp, base, [cv2.IMWRITE_JPEG_QUALITY, 90])
            os.replace(tmp, out)
            photos.drawn[L] = photos.count[L]
        return True
    except Exception as exc:   # noqa: BLE001
        sys.stderr.write(f"[live_stats] photo sheet failed: {exc}\n")
        return False


def _player_title(label, names_map):
    name = names_map.get(label, label)
    return name if name != label else f"PLAYER {label}"


# ── master accumulation + running heat ──
def merge_into_master(master, clip_payload, swap_margin):
    """Append one chunk's downsampled tracks; return the new per-label samples added."""
    every = clip_payload["every"]
    ct = clip_payload["tracks"]
    ds = {L: ct[L][::every] for L in LABELS}
    if master["tracks"] is None:
        master["tracks"] = {L: [] for L in LABELS}
        master["court"] = clip_payload.get("court")
        master["width"] = clip_payload.get("width")
        master["height"] = clip_payload.get("height")
        master["fps"] = clip_payload.get("sampled_fps")
    else:
        if master.get("court") is None and clip_payload.get("court"):
            master["court"] = clip_payload["court"]
        _maybe_swap(master["tracks"], ds, "A", "B", swap_margin)
        _maybe_swap(master["tracks"], ds, "C", "D", swap_margin)
    for L in LABELS:
        master["tracks"][L].extend(ds[L])
    master["frames"] = len(master["tracks"]["A"])
    return ds


def _court_model(master):
    c = master.get("court")
    if not c:
        return None
    from track_players import CourtModel
    return CourtModel(c["mL"], c["bL"], c["mR"], c["bR"], c["y_top"], c["y_bot"], c["y_net"])


def _solid_counts(master):
    tr = master.get("tracks") or {}
    return {L: sum(1 for s in tr.get(L, []) if s and s.get("solid")) for L in LABELS}


def _grid_consts():
    from player_heatmap import GRID_U, GRID_V
    return GRID_U, GRID_V


class HeatState:
    """
    Running per-player heat grid + solid-sample counts.

    Keeping a running grid (one cell += 1 per solid foot-point, divided by the sample
    count at draw time) is mathematically identical to re-accumulating the whole match
    each redraw — player_heatmap weights every splat by 1/total_samples — but it is
    O(1) per chunk instead of O(match-length). See header 'THE HEAT GRID IS KEPT RUNNING'.
    """

    def __init__(self):
        self.court_model = None
        self.grids = None          # {L: np.ndarray} once the court is known
        self.solid = {L: 0 for L in LABELS}
        self._gu = self._gv = None

    def _ensure_grids(self, master):
        if self.grids is not None:
            return True
        cm = _court_model(master)
        if cm is None:
            return False
        import numpy as np
        self.court_model = cm
        self._gu, self._gv = _grid_consts()
        self.grids = {L: np.zeros((self._gv, self._gu), np.float32) for L in LABELS}
        # First time the court is known, fold in everything the master already holds
        # (the first chunk or two before calibration, and a resumed master).
        self.solid = {L: 0 for L in LABELS}
        for L in LABELS:
            self._add(L, master["tracks"][L])
        return True

    def _add(self, label, samples):
        import numpy as np
        g = self.grids[label]
        c = 0
        for s in samples:
            if not s or not s.get("solid"):
                continue
            u, v = self.court_model.uv(s["foot"][0], s["foot"][1])
            gu = int(np.clip(u, 0, 0.999) * self._gu)
            gv = int(np.clip(v, 0, 0.999) * self._gv)
            g[gv, gu] += 1.0
            c += 1
        self.solid[label] += c

    def absorb(self, master, new_samples):
        """Fold one chunk's new samples into the running grid + counts."""
        if self.grids is None:
            # No court yet: still count solids so the 'seen' line is live; the grid is
            # rebuilt from the full master the moment the court appears.
            if not self._ensure_grids(master):
                for L in LABELS:
                    self.solid[L] += sum(1 for s in new_samples[L] if s and s.get("solid"))
                return
            return   # _ensure_grids just folded in everything, new samples included
        for L in LABELS:
            self._add(L, new_samples[L])

    def rebuild(self, master):
        """Drop and rebuild from the master (after a resume or a match reset)."""
        self.court_model = None
        self.grids = None
        self.solid = {L: 0 for L in LABELS}
        if master.get("tracks"):
            self._ensure_grids(master)

    def detection_summary(self, frames):
        if not frames:
            return "—"
        return " ".join(f"{L}={self.solid[L] / frames:.2f}" for L in LABELS)


def write_master(master, path):
    payload = {
        "video": "", "fps": master["fps"], "width": master.get("width"),
        "height": master.get("height"), "frames": master["frames"],
        "court": master.get("court"), "tracks": master["tracks"],
        # bookkeeping for a safe crash-resume (player_stats ignores unknown keys):
        "high_water": master.get("high_water", 0),
        "run_token": master.get("run_token"),
    }
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(payload, fh)
    os.replace(tmp, path)   # atomic — a reader never sees a half-written master


def load_master_if_recent(master, path, window_sec):
    """Resume a crash-interrupted match; ignore a stale one from a previous match (header)."""
    if not os.path.exists(path):
        return False
    age = time.time() - os.path.getmtime(path)
    if age > window_sec:
        sys.stderr.write(f"[live_stats] found a master {age / 60:.0f} min old (> resume window) — "
                         f"treating as a previous match, starting fresh\n")
        return False
    try:
        with open(path) as fh:
            d = json.load(fh)
        if not d.get("tracks") or not d.get("frames"):
            return False
        master["tracks"] = {L: d["tracks"].get(L, []) for L in LABELS}
        master["court"] = d.get("court")
        master["fps"] = d.get("fps")
        master["width"] = d.get("width")
        master["height"] = d.get("height")
        master["frames"] = d.get("frames", len(master["tracks"]["A"]))
        master["high_water"] = d.get("high_water", 0)
        master["run_token"] = d.get("run_token")
        sys.stderr.write(f"[live_stats] resumed master ({master['frames']} samples, "
                         f"{age / 60:.0f} min old, high_water={master['high_water']})\n")
        return True
    except Exception as exc:   # noqa: BLE001
        sys.stderr.write(f"[live_stats] could not resume master: {exc}\n")
        return False


# ── stats (in-process) + heat card (in-process) ──
def write_stats(master, out_json, names):
    """Compute the numbers in-process and write stats.json. Never raises."""
    try:
        sys.path.insert(0, SCRIPTS_DIR)
        from player_stats import compute_stats
        data = {
            "video": "", "fps": master["fps"], "frames": master["frames"],
            "court": master.get("court"), "tracks": master["tracks"],
        }
        payload = compute_stats(data, names)
        if payload is None:
            return False
        tmp = out_json + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(payload, fh, indent=2)
        os.replace(tmp, out_json)
        return True
    except Exception as exc:   # noqa: BLE001 — a stats error must not kill the loop
        sys.stderr.write(f"[live_stats] stats failed: {exc}\n")
        return False


def render_heat_card(master, heat, out_png, names_map, logo):
    """Draw the four court maps from the RUNNING grid (no re-accumulation). Never raises."""
    try:
        import cv2
        sys.path.insert(0, SCRIPTS_DIR)
        from player_heatmap import (heat_lut, draw_court_panel,
                                     background, draw_legend, put_centered, _blit_logo)
        if heat.grids is None or heat.court_model is None:
            return False
        court = heat.court_model
        final, vmax = _heat_layers(heat)
        lut, alpha = heat_lut()

        W, M, gap, label_h = 1080, 36, 24, 44
        header_h = 80 if logo else 0
        legend_h = 78
        panel_w = (W - 2 * M - gap) // 2
        court_w = panel_w - 2 * gap
        court_h = int(court_w * 1.75)
        row_h = label_h + court_h
        H = M + header_h + 2 * row_h + gap + legend_h + M

        base = background(W, H)
        if header_h:
            _blit_logo(base, logo, W, M, header_h)
        draw_legend(base, M + int((W - 2 * M) * 0.15), H - M - legend_h,
                    int((W - 2 * M) * 0.70), legend_h, lut, alpha)
        cols = {"A": (M, 0), "B": (M + panel_w + gap, 0),
                "C": (M, 1), "D": (M + panel_w + gap, 1)}
        y_top = M + header_h
        for L in LABELS:
            px, row = cols[L]
            py = y_top + row * (row_h + gap)
            put_centered(base, names_map.get(L, L), px + panel_w / 2, py + label_h * 0.6,
                         min(1.0, panel_w / 480.0), (255, 255, 255), 2)
            panel = draw_court_panel(court_w, court_h, court, final[L], vmax, lut, alpha)
            cx = px + (panel_w - court_w) // 2
            cy = py + label_h
            base[cy:cy + court_h, cx:cx + court_w] = panel
            cv2.rectangle(base, (cx - 1, cy - 1), (cx + court_w, cy + court_h), (220, 190, 150), 1)

        tmp = out_png + ".tmp.png"
        cv2.imwrite(tmp, base)
        os.replace(tmp, out_png)
        return True
    except Exception as exc:   # noqa: BLE001 — a draw error must not kill the loop
        sys.stderr.write(f"[live_stats] heat card failed: {exc}\n")
        return False


def _heat_layers(heat):
    """Each player's blurred share-of-time grid, and one colour scale for all four."""
    from player_heatmap import blur_heat
    final = {L: blur_heat(heat.grids[L] / max(1, heat.solid[L])) for L in LABELS}
    vmax = max(float(g.max()) for g in final.values()) or 1.0
    return final, vmax


def render_player_heatmaps(heat, out_dir, names_map, logo):
    """
    heatmap-<L>.png: one player's court map on its own, for that player's card in the
    product. Same colour scale as the four-map picture, so colours compare across players.
    A player never clearly seen gets no picture. Never raises.
    """
    try:
        import cv2
        sys.path.insert(0, SCRIPTS_DIR)
        from player_heatmap import (heat_lut, draw_court_panel, background, draw_legend,
                                     put_centered, _blit_logo)
        if heat.grids is None or heat.court_model is None:
            return False
        final, vmax = _heat_layers(heat)
        lut, alpha = heat_lut()
        W, M, label_h, legend_h = 540, 28, 48, 70
        header_h = 64 if logo else 0
        court_w = W - 2 * M
        court_h = int(court_w * 1.75)
        H = M + header_h + label_h + court_h + 16 + legend_h + M
        for L in LABELS:
            if heat.solid[L] == 0:
                continue
            base = background(W, H)
            if header_h:
                _blit_logo(base, logo, W, M, header_h)
            top = M + header_h
            put_centered(base, _player_title(L, names_map), W / 2, top + label_h * 0.6, 0.9,
                         (255, 255, 255), 2)
            panel = draw_court_panel(court_w, court_h, heat.court_model, final[L], vmax, lut, alpha)
            cy = top + label_h
            base[cy:cy + court_h, M:M + court_w] = panel
            cv2.rectangle(base, (M - 1, cy - 1), (M + court_w, cy + court_h), (220, 190, 150), 1)
            draw_legend(base, M + int(court_w * 0.1), cy + court_h + 16, int(court_w * 0.8),
                        legend_h, lut, alpha)
            out = os.path.join(out_dir, f"heatmap-{L}.png")
            tmp = out + ".tmp.png"
            cv2.imwrite(tmp, base)
            os.replace(tmp, out)
        return True
    except Exception as exc:   # noqa: BLE001 — a draw error must not kill the loop
        sys.stderr.write(f"[live_stats] player heatmap failed: {exc}\n")
        return False


# ── capture (camera mode only) ──
def start_segmenter(camera, seg_dir, clip_sec, reencode, loglevel):
    pattern = os.path.join(seg_dir, "clip_%Y%m%d_%H%M%S.mp4")
    vcodec = (["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]
              if reencode else ["-c:v", "copy"])
    cmd = ["ffmpeg", "-nostdin", "-loglevel", loglevel, "-rtsp_transport", "tcp",
           "-i", camera, "-an", *vcodec, "-f", "segment", "-segment_time", str(clip_sec),
           "-reset_timestamps", "1", "-strftime", "1", pattern]
    sys.stderr.write(f"[live_stats] camera segmenter → {pattern}\n")
    # Own process group so a hard kill can take the whole ffmpeg down with us and we do
    # not orphan a second ffmpeg holding the camera after a pm2 SIGKILL (header/DO NOT).
    return subprocess.Popen(cmd, start_new_session=True)


def _stop_segmenter(seg):
    if seg is None:
        return
    try:
        os.killpg(os.getpgid(seg.pid), signal.SIGTERM)
        seg.wait(timeout=5)
    except Exception:   # noqa: BLE001
        try:
            os.killpg(os.getpgid(seg.pid), signal.SIGKILL)
        except Exception:   # noqa: BLE001
            pass


def _names_map(names_arg):
    m = {L: L for L in LABELS}
    for part in filter(None, (names_arg or "").split(",")):
        k, _, v = part.partition("=")
        if k.strip().upper() in m:
            m[k.strip().upper()] = v.strip().upper()
    return m


def env_default(name, fallback):
    v = os.environ.get(name)
    return v if v not in (None, "") else fallback


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--source", choices=["buffer", "camera"],
                    default=env_default("SOURCE", "camera"),
                    help="buffer = reuse the streamer's highlight chunks; camera = slice the camera myself")
    ap.add_argument("--buffer-dir", default=env_default("BUFFER_DIR", ""),
                    help="(buffer mode) folder where the streamer writes seg-*.ts chunks")
    ap.add_argument("--camera", default=env_default("CAMERA_URL", ""),
                    help="(camera mode) RTSP URL — use the low-res second stream (…/Channels/102)")
    ap.add_argument("--out-dir", default=env_default("OUT_DIR", "./live-stats-out"))
    ap.add_argument("--clip-sec", type=int, default=int(env_default("CLIP_SEC", "30")),
                    help="(camera mode) seconds per captured slice")
    ap.add_argument("--target-fps", type=float, default=float(env_default("TARGET_FPS", "3")),
                    help="detector rate (looks/sec). The main CPU dial")
    ap.add_argument("--imgsz", type=int, default=int(env_default("IMGSZ", "960")),
                    help="detector input size; 640 loses far players, 1280 is heavy, 960 is the middle")
    ap.add_argument("--threads", type=int, default=int(env_default("THREADS", "2")),
                    help="cap detector CPU threads so ffmpeg keeps its cores (DO NOT raise blindly)")
    ap.add_argument("--stats-every", type=int, default=int(env_default("STATS_EVERY", "0")),
                    help="recompute stats+heatmap every N chunks (0 = auto: buffer 12, camera 1)")
    ap.add_argument("--checkpoint-sec", type=float, default=float(env_default("CHECKPOINT_SEC", "60")),
                    help="how often to save the crash-resume master to disk")
    ap.add_argument("--drop-backlog", type=int, default=int(env_default("DROP_BACKLOG", "6")),
                    help="when more than this many chunks are queued, jump to the newest to stay live")
    ap.add_argument("--static-refresh", type=int, default=int(env_default("STATIC_REFRESH", "60")),
                    help="re-scan the empty-court background every N chunks")
    ap.add_argument("--swap-margin", type=float, default=float(env_default("SWAP_MARGIN", "0.15")),
                    help="only un-swap partners when it beats the straight match by this fraction")
    ap.add_argument("--names", default=env_default("NAMES", ""),
                    help="label players, e.g. 'A=ALI,B=OMAR,C=ZAIN,D=BILAL'")
    ap.add_argument("--court-json", default=env_default("COURT_JSON", ""),
                    help="calibration file (default <out-dir>/court.json)")
    ap.add_argument("--logo", default=env_default("LOGO", "public/ds.png"))
    ap.add_argument("--model", default=env_default("MODEL", "yolo11s.pt"))
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--device", default=env_default("DEVICE", ""))
    ap.add_argument("--court-hsv", default="90,40,40,130,255,255")
    ap.add_argument("--lock-sec", type=float, default=2.0)
    ap.add_argument("--max-jump-frac", type=float, default=0.06)
    ap.add_argument("--coast-frames", type=int, default=25)
    ap.add_argument("--smooth-win", type=int, default=7)
    ap.add_argument("--resume-window", type=float, default=float(env_default("RESUME_WINDOW", "900")),
                    help="resume a master newer than this many seconds (crash restart); older = new match")
    ap.add_argument("--fresh", action="store_true",
                    help="ignore any existing master and start a brand-new match")
    ap.add_argument("--reencode", action="store_true",
                    help="(camera mode) re-encode segments instead of stream-copy")
    ap.add_argument("--keep-clips", action="store_true",
                    help="(camera mode) keep each processed clip (default: delete)")
    ap.add_argument("--max-clips", type=int, default=int(env_default("MAX_CLIPS", "0")),
                    help="process this many chunks then stop (0 = forever)")
    ap.add_argument("--poll-sec", type=float, default=2.0)
    ap.add_argument("--ffmpeg-loglevel", default="error")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()

    if args.source == "camera" and not args.camera:
        sys.stderr.write("[live_stats] FATAL: camera mode needs --camera (or CAMERA_URL)\n")
        return 1
    if args.source == "buffer" and not args.buffer_dir:
        sys.stderr.write("[live_stats] FATAL: buffer mode needs --buffer-dir (or BUFFER_DIR)\n")
        return 1

    # Keep torch/OpenBLAS thread pools small (belt-and-suspenders with the explicit caps
    # in TrackEngine). setdefault so the pm2 ecosystem env can still override.
    for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
               "VECLIB_MAXIMUM_THREADS", "NUMEXPR_NUM_THREADS"):
        os.environ.setdefault(_v, str(max(1, args.threads)))

    stats_every = args.stats_every if args.stats_every > 0 else (1 if args.source == "camera" else 12)

    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    court_json = args.court_json or os.path.join(out_dir, "court.json")
    master_path = os.path.join(out_dir, "master-tracks.json")
    stats_path = os.path.join(out_dir, "stats.json")
    heat_path = os.path.join(out_dir, "heatmap.png")
    names_map = _names_map(args.names)

    if args.source == "camera":
        src_dir = os.path.join(out_dir, "segments")
        os.makedirs(src_dir, exist_ok=True)
        src_glob = "clip_*.mp4"
        own_files = True
        # Clear clips left behind by a previous (perhaps SIGKILLed) run so we neither
        # reprocess yesterday's footage nor confuse a leftover with a live one.
        for f in glob.glob(os.path.join(src_dir, src_glob)):
            try:
                os.remove(f)
            except OSError:
                pass
    else:
        src_dir = os.path.abspath(args.buffer_dir)
        src_glob = "seg-*.ts"
        own_files = False

    master = {"tracks": None, "court": None, "fps": None, "frames": 0,
              "width": None, "height": None, "high_water": 0, "run_token": None}
    resumed = False
    if not args.fresh:
        resumed = load_master_if_recent(master, master_path, args.resume_window)

    heat = HeatState()
    heat.rebuild(master)      # fold a resumed master into the running grid once
    photos = PhotoState(out_dir)
    if not resumed:
        photos.reset()        # a fresh match must not inherit an older match's cut-outs

    engine = TrackEngine(args.model, args.conf, args.imgsz, args.device, args.court_hsv,
                         court_json, args.lock_sec, args.max_jump_frac, args.coast_frames,
                         args.smooth_win, args.threads, args.static_refresh, verbose=args.debug)

    stop = {"flag": False}

    def _stop(_s, _f):
        sys.stderr.write("[live_stats] stop requested — finishing up\n")
        stop["flag"] = True
    signal.signal(signal.SIGINT, _stop)
    signal.signal(signal.SIGTERM, _stop)

    seg = None
    if own_files:
        seg = start_segmenter(args.camera, src_dir, args.clip_sec, args.reencode, args.ffmpeg_loglevel)
    sys.stderr.write(f"[live_stats] source={args.source} dir={src_dir} target_fps={args.target_fps} "
                     f"imgsz={args.imgsz} threads={args.threads} stats_every={stats_every} out={out_dir}\n")

    processed = set()          # camera mode: names consumed (buffer mode uses high_water)
    done = 0
    last_ckpt = time.time()
    seg_fails = 0              # segmenter exits in a row that didn't last one full chunk
    seg_started = time.time()
    try:
        while not stop["flag"]:
            if own_files and seg.poll() is not None:
                # Healthy = stayed connected for a full chunk. Not "a clip file
                # appeared" (a camera that sends a moment then drops leaves a tiny
                # one), and not "players found" (an empty court is not a broken
                # camera) — header.
                seg_fails = 0 if time.time() - seg_started >= args.clip_sec else seg_fails + 1
                wait = min(SEGMENTER_MAX_WAIT_SEC, 3 * 2 ** max(0, seg_fails - 1))
                sys.stderr.write(f"[live_stats] camera segmenter exited rc={seg.returncode}; "
                                 f"restarting in {wait}s\n")
                until = time.time() + wait
                while time.time() < until and not stop["flag"]:
                    time.sleep(0.5)
                if stop["flag"]:
                    break
                seg = start_segmenter(args.camera, src_dir, args.clip_sec, args.reencode, args.ffmpeg_loglevel)
                seg_started = time.time()

            files = sorted(glob.glob(os.path.join(src_dir, src_glob)), key=_sort_key)
            ready = files[:-1]     # never the newest — it is still being written

            # Buffer mode: a changed ffmpeg run token means a new match → start fresh.
            if not own_files and ready:
                cur_run = _run_of(ready[-1])
                if cur_run and master.get("run_token") and cur_run != master["run_token"]:
                    sys.stderr.write(f"[live_stats] new match detected (run {cur_run} != "
                                     f"{master['run_token']}) — starting fresh\n")
                    master.update({"tracks": None, "court": None, "fps": None, "frames": 0,
                                   "width": None, "height": None, "high_water": 0, "run_token": None})
                    heat.rebuild(master)
                    photos.reset()
                    done = 0

            if own_files:
                todo = [f for f in ready if os.path.basename(f) not in processed]
            else:
                todo = [f for f in ready if (_epoch_of(f) or 0) > master["high_water"]]

            if not todo:
                if not own_files and not files:
                    sys.stderr.write(f"[live_stats] no chunks in {src_dir} yet — is the highlight buffer on?\n")
                time.sleep(args.poll_sec)
                continue

            # Stay live: if we've fallen behind, jump to the newest ready chunk and drop
            # the stale ones (header 'WE STAY LIVE WHEN WE FALL BEHIND').
            if len(todo) > args.drop_backlog:
                dropped = todo[:-1]
                for f in dropped:
                    if own_files:
                        processed.add(os.path.basename(f))
                        if not args.keep_clips:
                            os.path.exists(f) and os.remove(f)
                    else:
                        master["high_water"] = max(master["high_water"], _epoch_of(f) or 0)
                sys.stderr.write(f"[live_stats] behind by {len(todo)} chunks — dropping {len(dropped)} "
                                 f"stale to stay live\n")
                todo = todo[-1:]

            clip = todo[0]
            backlog = len(todo) - 1
            t0 = time.time()

            t_track0 = time.time()
            payload = engine.process_clip(clip, args.target_fps)
            t_track = time.time() - t_track0

            def _advance(c):
                if own_files:
                    processed.add(os.path.basename(c))
                    if not args.keep_clips:
                        os.path.exists(c) and os.remove(c)
                else:
                    master["high_water"] = max(master["high_water"], _epoch_of(c) or 0)
                    if master.get("run_token") is None:
                        master["run_token"] = _run_of(c)

            if payload is None:
                _advance(clip)
                continue

            new_samples = merge_into_master(master, payload, args.swap_margin)
            heat.absorb(master, new_samples)
            # Before _advance: camera mode deletes the chunk there (header 'PHOTO CROPS').
            photos.collect(clip, new_samples, payload["every"],
                           master["frames"] - len(new_samples["A"]), master["fps"],
                           master.get("court"))
            _advance(clip)
            done += 1

            # Save the crash-resume checkpoint on a timer, NOT every chunk.
            if time.time() - last_ckpt >= args.checkpoint_sec:
                write_master(master, master_path)
                last_ckpt = time.time()

            t_stats = 0.0
            if done % max(1, stats_every) == 0:
                ts0 = time.time()
                write_stats(master, stats_path, args.names)
                render_heat_card(master, heat, heat_path, names_map, args.logo)
                render_player_heatmaps(heat, out_dir, names_map, args.logo)
                render_photo_sheets(photos, out_dir, names_map)
                t_stats = time.time() - ts0

            clip_dur = payload["frames"] / payload["fps"] if payload["fps"] else 0.0
            total = time.time() - t0
            rate = (clip_dur / total) if total > 0 else 0.0
            sys.stderr.write(
                f"[live_stats] {os.path.basename(clip)}: {clip_dur:.0f}s play @ {payload['sampled_fps']}fps "
                f"| track={t_track:.1f}s stats={t_stats:.1f}s total={total:.1f}s (x{rate:.1f} realtime) "
                f"| master={master['frames']} samples | seen {heat.detection_summary(master['frames'])} "
                f"| backlog={backlog}\n")
            if backlog > 3:
                sys.stderr.write(f"[live_stats] WARNING: {backlog} chunks queued — falling behind; "
                                 f"lower --target-fps or --imgsz\n")

            if args.max_clips and done >= args.max_clips:
                sys.stderr.write(f"[live_stats] reached --max-clips={args.max_clips}\n")
                break
    finally:
        _stop_segmenter(seg)
        if master["frames"] > 0:
            write_master(master, master_path)
            write_stats(master, stats_path, args.names)
            render_heat_card(master, heat, heat_path, names_map, args.logo)
            render_player_heatmaps(heat, out_dir, names_map, args.logo)
            render_photo_sheets(photos, out_dir, names_map)
        sys.stderr.write(f"[live_stats] done. stats={stats_path} heatmap={heat_path}\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
