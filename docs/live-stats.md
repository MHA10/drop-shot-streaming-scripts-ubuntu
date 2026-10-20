# Near-live player stats & heatmap (`live_stats.py`)

**Status:** v1, built 2026-10-09 · pairs with [`docs/v1-stats-spec.md`](./v1-stats-spec.md)

## What this is, in one breath

A second program that, **while the match is streaming**, keeps two files on disk up to date:

- `stats.json` — the numbers (how far each player ran, time at the net, the team's shape…)
- `heatmap.png` — the four "where did they stand" court maps

It never touches the live broadcast. ffmpeg keeps pushing the video to YouTube exactly as
before; this just does the counting on the side.

Think of a shop's CCTV: the TV in the back office keeps showing the live feed, and a
separate recorder quietly keeps its own notes. Breaking the recorder doesn't touch the TV.

## Where it gets the video — two sources

It builds everything from **short video chunks**. There are two ways to get them, picked with
`--source`:

### `buffer` — reuse the streamer's own chunks (preferred, no second capture)

The live ffmpeg **already writes** short video chunks to disk for making highlight reels — a
second output of the same streaming process (`NodeFFmpegService.ts`, the "highlight buffer
branch"). Those files are `seg-<run>-<epoch>.ts`, about **2 seconds** each, under
`<HIGHLIGHT_BUFFER_DIR>/<courtId>/`. In this mode the stats reader just **reads those chunks** —
no extra camera connection, no second capture. It never deletes or renames them (the
highlight/reel system owns them); it only reads and remembers which it has done.

**This needs the buffer turned on in the streamer.** On this box it's off today. To turn it on,
set in the *streamer's* environment:

```
HIGHLIGHT_ENABLED=true
HIGHLIGHT_BUFFER_DIR=./highlight-buffer       # chunks land in ./highlight-buffer/<courtId>/
# HIGHLIGHT_BUFFER_SEGMENT_SEC=2              # chunk length, default 2s
```

Turning it on adds a **light second compression** to ffmpeg (ultrafast, 800k, no sound — not a
free copy, because the buffer video is the filtered broadcast picture). Cheap, but not nothing.

### `camera` — slice the camera yourself (fallback, buffer off)

The reader runs its **own** ffmpeg that cuts the camera into 30-second clips. Use this only when
the buffer is off. It opens its **own** camera connection, so point it at the camera's **low-res
second stream** (`…/Streaming/Channels/102`), not the HD one the stream uses.

## Why it's built the way it is (the short version)

- **The box keeps no recording of the match** — the stream only goes out to YouTube. So we
  can't "process the video afterwards"; the stats have to be built *as the match happens*.
- **It reuses the tools we already trust.** Finding the players is `track_players.py`; the
  numbers are `player_stats.py`. This program is the conductor feeding them chunks and adding
  up the results.
- **The player-finder is loaded once and kept in memory.** Loading it takes a few seconds; the
  buffer chunks are only ~2 seconds long, so reloading it per chunk would cost more than the
  chunk itself. Keeping it resident is what makes reusing the 2-second buffer chunks viable.
- **It runs the finder slowly** (default 3 looks/sec), never every frame — that's what lets it
  share this graphics-card-less box with ffmpeg.
- **It is capped to a couple of CPU cores** (`--threads`, default 2) so it can never crowd out
  the live video encoder. The broadcast is the priority; the stats are allowed to be slow.
- **It does the counting without falling behind as the match grows.** The numbers and the
  heatmap are worked out directly in memory (no relaunching a separate program every couple of
  seconds), the "where they stood" picture is a running tally rather than a from-scratch
  re-count each time, and the save-to-disk only happens on a timer. Early versions redid all of
  this every chunk, which looked fine for the first few minutes and then choked an hour in.
- **One bad moment can't take it down.** A chunk where it can't see all four players (normal
  between points), a glitchy frame, a hiccup in the number-crunching — each is logged and
  skipped, never crashes the whole reader.
- **A restart in the middle of a match picks up cleanly.** It remembers how far it got, so after
  a restart it doesn't re-count clips it already added (which used to roughly double that
  stretch), and if it notices a *different* match has started it begins fresh on its own.
- **If it falls behind it jumps back to live** instead of grinding through stale clips the match
  has long moved past (and that may be deleted before it reaches them).

## Reading the "are we keeping up?" line

Each chunk logs something like:

```
[live_stats] seg-abc-1760012345.ts: 2s play @ 3.0fps | track=0.7s stats=0.3s total=1.1s (x1.8 realtime) | master=540 samples | seen A=0.91 B=0.88 C=0.73 D=0.95 | backlog=0
```

- **`x1.8 realtime`** — it processed 2 seconds of play in 1.1 seconds, i.e. **1.8× faster than
  real time**. Above 1.0 with room to spare = comfortably keeping up.
- **`backlog=0`** — finished chunks still waiting. **0 is healthy.** If it keeps climbing, the
  box is falling behind — lower `--target-fps` (3 → 2) or `--imgsz` (960 → 832). It prints a
  loud warning once backlog passes 3.
- **`seen A=0.91 …`** — how often the camera actually saw each player (the trust score). A low
  one means **that player's numbers under-count** — the product should hide or caveat them below
  ~0.60 (spec §5).

> These numbers are illustrative. **The real figures come from the first run on the box** — the
> whole point of that logged line is to measure it on the actual processor.

## Run it from the streamer (the v1 way)

Since 2026-10-18 the streamer app runs the reader itself, so nobody starts it by hand:

1. **Court goes live** (backend's start event) → the streamer starts a reader for that court,
   in a new match folder under `STATS_OUTPUT_DIR/<courtId>/`. It reads the camera's **low-res
   stream**, worked out from the stream's camera address (Hikvision `…/Channels/101` → `…/102`,
   Dahua `subtype=0` → `subtype=1`). Unknown camera brand → no stats for that court, logged.
2. **Court stops** (backend's stop event) → the reader is asked to finish, writes its final
   `stats.json` + `heatmap.png`, and the folder joins the **outbox**. While it runs, the
   backend's `match_state` events tell it which scored match is on the court; that id goes
   in the record so the stats land on the right game.
3. **Outbox** → uploads the heatmap to Cloudinary, sends the numbers + picture link to the
   backend (`docs/stats-db-handoff.md`), and deletes the folder once the backend says "got it".
   No answer, or an error → it keeps the folder and tries again (1 min, doubling up to 1 h).

Safe by design: stream retries and repeated start events don't restart the reader (that would
split the match); an app restart mid-match picks the same folder back up; a reader that keeps
crashing gives up for that match without touching the stream.

**Settings** (the streamer's environment; everything is off unless `STATS_ENABLED=true`):

| setting | default | what it does |
|---|---|---|
| `STATS_ENABLED` | `false` | master switch — off means no readers, no outbox, nothing |
| `STATS_PYTHON` | `python3` | the Python that has `ultralytics`/`opencv`/`numpy` (usually a venv) |
| `STATS_MODEL_PATH` | `./yolo11s.pt` | the player-finder weights (not shipped in the npm package) |
| `STATS_OUTPUT_DIR` | `./match-stats` | match folders + outbox |
| `STATS_TARGET_FPS` / `STATS_IMGSZ` / `STATS_THREADS` / `STATS_CLIP_SEC` | `3` / `960` / `2` / `30` | reader dials (ds-box result) |
| `STATS_MAX_READERS` | `1` | courts that may run a reader at once — **raise only after a speed check on that box** |
| `STATS_ALLOW_MAIN_STREAM` | `false` | if the low-res address can't be worked out, read the HD stream instead (heavier) |
| `STATS_MAX_MATCH_MIN` | `240` | finish a reader whose stop event never came |
| `STATS_SEND_ENABLED` | `false` | send to the backend. **Leave off until the backend route exists** — matches wait in the outbox meanwhile |
| `STATS_SEND_PATH` | `/api/v1/padel-grounds/{groundId}/courts/{courtId}/stats` | backend route; change it here if the backend names it differently |
| `STATS_KEEP_DAYS` | `14` | outbox entries older than this are deleted unsent (protects the disk) |

Heatmap upload uses the existing `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET`; without them the
numbers still go, with `heatmapUrl: null`.

**Don't also run the pm2 reader below on a box with `STATS_ENABLED=true`** — that's two readers
on one court, double the CPU.

Each match folder holds `reader.log` (the reader's own log, including the "are we keeping up?"
lines) while the match runs — the first place to look if a court's stats look wrong.

## Run it by hand (testing)

**One-time setup on the box:** install the same Python vision libraries `track_players.py` needs
(`ultralytics` + `opencv`) and have `yolo11s.pt` present.

**Reuse the streamer's buffer chunks:**

```bash
python3 scripts/live_stats.py --source buffer \
  --buffer-dir ./highlight-buffer/<courtId> \
  --out-dir ./live-stats-out --target-fps 3 --imgsz 960
```

**Standalone off the camera (buffer off), bounded test — 4 chunks then stop:**

```bash
python3 scripts/live_stats.py --source camera \
  --camera "rtsp://admin:PASS@192.168.18.220:554/Streaming/Channels/102" \
  --out-dir ./live-stats-out --clip-sec 30 --target-fps 3 --imgsz 960 --max-clips 4
```

**Under pm2 (keeps running, auto-restarts):**

```bash
# set SOURCE + BUFFER_DIR (or CAMERA_URL) in scripts/live-stats.ecosystem.config.js first
pm2 start scripts/live-stats.ecosystem.config.js
pm2 save
pm2 logs dropshot-live-stats
```

Outputs land in `--out-dir` (default `./live-stats-out/`): `stats.json`, `heatmap.png`,
`court.json` (the one-time court calibration — reused on every later run), and
`master-tracks.json` (the running record). A pm2 restart mid-match **resumes** from
`master-tracks.json` if it's newer than `--resume-window` (default 15 min); older than that it's
treated as a previous match and it starts fresh.

## The knobs

| Flag / env | Default | What it does |
|---|---|---|
| `--source` / `SOURCE` | `camera` | `buffer` (reuse streamer chunks) or `camera` (slice camera) |
| `--buffer-dir` / `BUFFER_DIR` | — | (buffer mode) the court's chunk folder, `<HIGHLIGHT_BUFFER_DIR>/<courtId>` |
| `--camera` / `CAMERA_URL` | — | (camera mode) RTSP URL — use `…/Channels/102` |
| `--clip-sec` / `CLIP_SEC` | 30 | (camera mode) seconds per captured slice |
| `--target-fps` / `TARGET_FPS` | 3 | Finder rate — **the main processor dial** |
| `--imgsz` / `IMGSZ` | 960 | Finder input size. 640 loses far players, 1280 is heavy, 960 is the middle |
| `--threads` / `THREADS` | 2 | **Cap on detector CPU threads** so the live ffmpeg keeps its cores. **Do not raise blindly** — the stream matters more than the stats |
| `--stats-every` / `STATS_EVERY` | 0 (auto) | Recompute stats + heatmap every N chunks. Auto = 12 in buffer mode (~2s chunks → refresh ~25s), 1 in camera mode (~30s chunks) |
| `--checkpoint-sec` / `CHECKPOINT_SEC` | 60 | How often the crash-resume file is saved (it is **not** rewritten every chunk any more) |
| `--drop-backlog` / `DROP_BACKLOG` | 6 | If more than this many chunks are queued, jump to the newest and drop the stale ones to **stay live** |
| `--static-refresh` / `STATIC_REFRESH` | 60 | Re-scan the empty-court background every N chunks (cached in between to save one look per chunk) |
| `--swap-margin` / `SWAP_MARGIN` | 0.15 | Only un-cross two partners when it's clearly better by this fraction (stops coin-flip identity swaps) |
| `--names` / `NAMES` | — | `A=ALI,B=OMAR,C=ZAIN,D=BILAL` to label the cards |
| `--resume-window` / `RESUME_WINDOW` | 900 | Resume a master newer than this many seconds; older = new match |
| `--fresh` | off | Ignore any existing master and start a brand-new match (use when starting a fresh match on the same court) |
| `--max-clips` / `MAX_CLIPS` | 0 | Stop after N chunks (0 = forever); use for a bounded test |

## Known limits for v1

- **Depth is an estimate (±10–15%); width is exact.** Present metres/speeds as comparisons
  between players and rallies, not as line calls. (Spec §5.)
- **A low `seen` score means under-counted numbers** for that player — gate at ~0.60 in the
  product.
- **The fancy share-card** (the 9:16 card with a highlight clip playing in the middle) is still
  made the old way, from a saved clip at match end (`player_heatmap.py`). This live card is the
  four court maps only — no centre clip — because it spans the whole match and keeps no video.
- **Sending is built but off.** The streamer queues each finished match and sends it to the
  backend once `STATS_SEND_ENABLED=true`. The backend's receiving route is on staging since
  2026-10-20; the streamer names the match from the backend's `match_state` events
  (`docs/stats-db-handoff.md` §3).
- **One label can hold different people over a full match.** Pairs change ends every two games
  and the reader labels players by which end they're on, so after a changeover slot `C` holds a
  player from the other pair. Open; needs a full continuous match recording to build and test.
