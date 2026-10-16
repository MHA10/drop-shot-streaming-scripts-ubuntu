# Staging test — near-live player stats (`live_stats.py`)

**Goal:** the one thing we cannot learn off the box — *how fast the player-finder actually
runs on this streamer's CPU* — and a check that running it does **not** disturb the live
YouTube stream. Everything else (the logic, the crash-safety, the maths) is already covered by
the off-box test suite; this is purely the on-the-box reality check.

**Where:** the live streamer box (the only machine with the camera). The highlight buffer is
**off** on this box today, so staging uses **camera mode** — the reader opens its *own* camera
connection, pointed at the low-res second stream (`…/Channels/102`), so it does not touch the
HD stream going to YouTube.

**You need:** the camera's real RTSP password (do **not** commit it anywhere).

---

## 1. One-time setup on the box

In the repo directory on the box:

```bash
python3 -m venv .venv-stats && . .venv-stats/bin/activate
pip install ultralytics opencv-python-headless
# make sure yolo11s.pt is at the repo root (or pass MODEL=/path/to/yolo11s.pt below)
```

## 2. Bounded smoke test — 4 chunks then stop

```bash
python3 scripts/live_stats.py --source camera \
  --camera "rtsp://admin:REALPASS@192.168.18.220:554/Streaming/Channels/102" \
  --out-dir ./live-stats-out --clip-sec 30 --target-fps 3 --imgsz 960 \
  --threads 2 --max-clips 4
```

Each processed chunk prints a line like:

```
[live_stats] clip_...: 30s play @ 3.0fps | track=16.0s stats=0.4s total=16.5s (x1.8 realtime) | master=360 samples | seen A=0.91 B=0.88 C=0.73 D=0.95 | backlog=0
```

### What "healthy" looks like
- **`(x… realtime)` is above 1.0 with room to spare.** That is the headline number — it means
  it processed 30 seconds of play in less than 30 seconds, so it keeps up. This is what we came
  here to measure.
- **`backlog=0`** (or small and not climbing).
- **`seen A/B/C/D`** are mostly reasonable (a low one just means that player's numbers
  under-count — expected for a player the camera keeps losing).
- **`./live-stats-out/stats.json` and `heatmap.png` look sane** after it finishes.
- **The live YouTube stream did NOT hitch** while it ran. ← the most important check.

### If it's not keeping up (`x` below ~1.2, or backlog climbing)
Turn the dials down, in this order, and re-run the bounded test:
1. `--target-fps 3` → `2` (fewer looks per second — the main CPU dial).
2. `--imgsz 960` → `832` (smaller input to the finder).
Leave `--threads 2` as is — raising it risks the live stream.

### If the live stream stutters while it runs
Lower `--threads` to `1` and re-test. The broadcast is the priority; the stats are allowed to
be slow.

## 3. Real-match soak (once the smoke test is clean)

Run it under pm2 for a full match (drop `--max-clips`), with the real password set in the
box's shell/env — **not** in the tracked ecosystem file:

```bash
# set CAMERA_URL (with the real password), SOURCE=camera, THREADS, etc. in the environment
pm2 start scripts/live-stats.ecosystem.config.js
pm2 save
pm2 logs dropshot-live-stats          # watch the x-realtime + backlog line over the match
```

Watch across the whole match, not just the first minute — the earlier version looked fine
early and fell behind later; this version is built not to, but the soak is how we confirm it.

## 4. Stopping / rolling back
- `Ctrl-C` (or `pm2 stop dropshot-live-stats`) — it finishes the current chunk and writes the
  final `stats.json` + `heatmap.png` on the way out.
- Nothing it does touches the ffmpeg stream, so stopping it never affects the broadcast.

## 5. What to report back
- The `(x… realtime)` figures you saw, and the `--target-fps` / `--imgsz` that held up.
- Whether the live stream was undisturbed.
- Anything odd in `stats.json` / `heatmap.png`.

That tells us the frame-rate/size to lock in for v1, and whether near-live is a go on this box.

---

## 6. Results so far

### Processing speed — ground `75097349…` (2026-10-16)

**Box:** the `ds` streamer (Dell OptiPlex 5050 class — 4 CPU cores, Intel HD 530, no
separate graphics card). Setup was done in an isolated git worktree (`~/stats-test` on
`feat/player-abcd-tracking`), separate from the live streamer, which kept running throughout.

**Measured:** the player-finder runs at **~6.5 frames/sec** on this CPU at `--imgsz 960`
with `--threads 2`. At the planned `--target-fps 3` (three looks per second) that is
**×2.18 realtime** — it does the finding in well under half the time it has, so it keeps up
with roughly **2× headroom**.

**How this figure was taken (important):** the court was empty at test time, and the full
reader deliberately skips any clip where it can't see all four players — so it never printed
its own `(x… realtime)` line. The number above is from a **detector-only micro-benchmark**
(timing the finder over 60 live sub-stream frames) at the same `imgsz`/`threads`. It's a safe
stand-in for two reasons: the finder's time per frame is essentially fixed no matter how many
people are in frame, and the detector is by far the heaviest part of processing a clip. The
true end-to-end figure is a touch lower (it adds the light stats/heatmap step) but lands in
the same ballpark, ~×2.

**Verdict:** near-live stats are a **go** on this box. Lock in `--imgsz 960` +
`--target-fps 3` as the v1 default for this hardware class — there's headroom to spare, and
since the spec measured ~3 free CPU cores while streaming, the 2-thread finder should hold
this pace during a live match too.

### Still to confirm (needs a real 4-player match)

The speed question is answered. These three need an actual match on court and have **not** been
done yet:
- **Per-player `seen` trust-scores** look reasonable (how often the camera actually sees each
  of the four players).
- **`stats.json` + `heatmap.png`** come out populated and sane.
- **The live YouTube stream stays smooth** while the reader runs alongside it.

Run the §3 soak command (drop `--max-clips`) during a match, pointed at the court that has
players, to close these out.
