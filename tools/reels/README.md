# Marketing Reel Toolkit

Turn match footage into upload-ready vertical highlight reels — cropped to follow
the players, branded with the DropShot + ground logos, with the original sound.

Built for marketing use on a laptop. **Nothing here runs on a streamer box and
nothing here ships to npm** (the published package is only `dist/`).

---

## Contents

| File | What it's for |
|---|---|
| `setup.sh` | One-time: creates a local Python venv with yt-dlp + OpenCV |
| `make-reel.sh` | **The main one.** Footage + a moment → finished reel |
| `find-rally.py` | Scores a **local** video, tells you where the good rallies are |
| `score-audio.py` | Scores just the audio (step 1 for big/remote videos) |
| `fetch-sections.sh` | Downloads only candidate sections of a YouTube VOD (step 2) |
| `debug-overlay.sh` | Renders the tracking guides, to see what the crop is following |

---

## 1. One-time setup

```bash
bash tools/reels/setup.sh
```

Needs `ffmpeg`, `ffprobe` and `python3` already installed:

- **macOS:** `brew install ffmpeg python`
- **Ubuntu:** `sudo apt-get install -y ffmpeg python3 python3-venv`

It creates `tools/reels/.venv` (gitignored, ~80 MB) with `yt-dlp`,
`opencv-python-headless` and `numpy`. It does not touch system Python.

> **Branch note:** this toolkit calls `scripts/reframe_ball.py`, which currently
> lives only on `feat/highlight-clip-capture` (PR #28, not yet merged). If you
> branch from `master` or `staging` the tracking step will fail with "script
> missing". Once #28 merges this stops mattering.

---

## 2. Make a reel (the common case)

You have a video file and you know roughly when the good bit happens:

```bash
bash tools/reels/make-reel.sh \
  --input ~/footage/match.mp4 \
  --moment 3509 \
  --out local-reels/my-reel.mp4
```

`--moment` is **the second in the source where the highlight happened**. The reel
covers `[moment − 25s, moment + 5s]` — mostly *before* the moment, because you
notice a great point just after it finishes.

That's it. Output is 1080×1350 (4:5), branded, with audio.

---

## 3. Don't know where the good rally is?

### A. Local video file

```bash
tools/reels/.venv/bin/python tools/reels/find-rally.py ~/footage/match.mp4
```

It scores the **whole** recording and prints a ranked shortlist ending in:

```
BEST_MOMENT=3509   # feed to: make-reel.sh --moment 3509
```

Then run `make-reel.sh` with that moment. Takes a few minutes on a 2-hour match.

### B. YouTube VOD (don't download 2 GB)

A 2-hour stream is ~2 GB; you only need 30 seconds of it. Three steps:

```bash
# 1. audio only (~100 MB) — fast
tools/reels/.venv/bin/yt-dlp -f "ba[ext=m4a]/ba" -o audio.m4a "<youtube-url>"

# 2. score it → prints candidate start seconds
tools/reels/.venv/bin/python tools/reels/score-audio.py audio.m4a 30 6

# 3. fetch ONLY those 30s sections (~5-10 MB each) and rank them by motion
bash tools/reels/fetch-sections.sh "<youtube-url>" ./sections 608 2278 4392 4447 2461 4932
```

Then render the highest-motion one. The section file **is** the window, so use
`--moment 25`:

```bash
bash tools/reels/make-reel.sh --input ./sections/sec_608.mp4 \
  --moment 25 --out local-reels/reel.mp4
```

### How the scoring works (and why to trust the motion number)

- **Audio RMS** per second — rallies are dense ball hits plus player calls, and
  good points end in a reaction.
- **Motion energy** — mean absolute frame difference on a tiny greyscale decode.

Combined **60% motion / 40% audio**. That weighting earns its keep: in a real
match the *loudest* window was music during a break — loud but static (motion
0.07 vs 0.98 for the actual best rally). Audio alone would have picked the dud.

**Rule of thumb:** motion **> 0.8** is a strong rally, **0.4–0.8** is decent,
**< 0.3** is probably not live play.

---

## 4. Options

```
--input FILE      source video                                  [required]
--moment SEC      the highlight second within the source        [required]
--out FILE        output path                                   [required]
--aspect W:H      crop aspect                                   [4:5]
--pre SEC         seconds kept before the moment                [25]
--post SEC        seconds kept after the moment                 [5]
--width PX        output width (height follows the aspect)      [1080]
--logo FILE       ground/client logo            [public/client.png]
--ds-logo FILE    DropShot logo                 [public/ds.png]
--no-track        skip tracking → full-frame reel
--no-audio        don't mux audio
--keep-bars       don't auto-strip letterbox bars
--keep-temp       leave intermediates for debugging
```

### Aspect ratios

| Aspect | Output at `--width 1080` | Use |
|---|---|---|
| `4:5` **(default)** | 1080×1350 | Best all-rounder. Native on Instagram/Facebook, uploads clean to Shorts/TikTok, and crops less aggressively so more of the court stays in frame. |
| `9:16` | 1080×1920 | Full-screen Reels/Shorts/TikTok. Tighter crop — more chance of losing a player. |
| `1:1` | 1080×1080 | Square feed posts. |

---

## 5. Logos

Two logos are burned in: **ground/client top-right**, **DropShot bottom-right**,
sized as a fraction of the canvas so they scale with any aspect.

Defaults come from the repo (`public/client.png`, `public/ds.png`). Override with
`--logo` / `--ds-logo`.

**Transparent vs plate.** A logo with real alpha floats over the video and looks
more premium. A JPEG (no alpha) renders as a solid rectangle. To key a black
background out of a logo:

```bash
ffmpeg -i logo.jpg -vf "format=rgba,colorkey=0x000000:0.30:0.05" logo.png
```

Trim dead padding first, or the logo will look small inside its box:

```bash
ffmpeg -loop 1 -i logo.jpg -t 1 -vf cropdetect=8:2:0 -f null -   # prints crop=W:H:X:Y
ffmpeg -i logo.jpg -vf "crop=W:H:X:Y" logo-trimmed.png
```

> ⚠️ **`public/client.png` is not a fixed asset.** The streamer overwrites it from
> Cloudinary on every stream start. Don't edit it expecting the change to stick —
> to change a ground's real logo, upload it to Cloudinary under
> `dropshot/padel-courts/<groundId>/`. And note Cloudinary assets are often
> `.jpg`, which **cannot hold transparency**, so live streams render the plate
> look regardless.

---

## 6. Checking the tracking

If a reel pans strangely, or you're trying a new camera angle:

```bash
bash tools/reels/debug-overlay.sh \
  --input ~/footage/match.mp4 --moment 3509 --out guides.mp4
```

Full-frame video with **green boxes** (accepted player blobs), a **red dot** (the
chosen crop centre) and a **yellow rectangle** (the crop window that becomes the
reel).

### What "good" looks like

`make-reel.sh` prints a line like:

```
reframe_ball: mode=action frames=900 hit_rate=0.96 max_step_px=8 mean_step_px=1.88
```

| Field | Meaning | Healthy |
|---|---|---|
| `hit_rate` | fraction of analysed frames where **at least one** player was found | > 0.9 |
| `mean_step_px` | average pan speed | < 3 — higher feels jittery |
| `max_step_px` | worst single jump | ≤ 8 (hard-clamped) |

**Important:** `hit_rate` is *not* "found all players". It means *a* blob was
found. In the overlay you'll often see only one or two green boxes while four
players are on court — that's expected.

### Why (worth understanding before you file a bug)

Tracking is **classical computer vision, not an AI model**: OpenCV MOG2
background subtraction finds what *moved*, then contours are filtered to
player-sized blobs and the crop centres on their area-weighted average.

Consequences:

- A player **standing still** is absorbed into the background and disappears.
- There is **no identity** — it doesn't follow a specific player, just "where the
  motion is".
- It follows **players, not the ball** (despite the filename `reframe_ball.py`
  — there is a `--mode ball` but it's unreliable and unused; it locked onto
  plants and orange paddles in testing).
- Panning is **horizontal only**.
- The smooth result comes from the smoothing chain (median filter → moving
  average → velocity clamp), not from dense detection.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Logos sit in black bands, not on the picture | Source is letterboxed; logos are inset from the *frame* edge | Automatic — bars are stripped by default. Don't pass `--keep-bars`. |
| `letterbox check:` reports a size smaller than the output | Usually **dark picture** at a frame edge (night match, shadowed court) — not a bar. Occasionally a real residual bar, when a logo or scoreboard sits *inside* the bar region so cropdetect can't see it as black. | Look at a frame: `ffmpeg -ss 15 -i out.mp4 -frames:v 1 /tmp/check.jpg`. If it really is a bar, use `--keep-bars` and crop by hand, or pick a window without the overlay. |
| Output has no sound | Source has no audio track | Check: `ffprobe -show_streams input.mp4 \| grep audio`. Streamer-recorded clips are always silent (see below). |
| `venv missing — run setup.sh` | Setup not run, or run from the wrong directory | `bash tools/reels/setup.sh` from the repo root |
| `reframe_ball: dependencies unavailable: No module named 'cv2'` | Using system python instead of the venv | Use `tools/reels/.venv/bin/python`, or just use `make-reel.sh` which picks it up |
| "script missing" on the reframe step | On a branch without `scripts/reframe_ball.py` | See the branch note in §1 |
| Low `hit_rate` (< 0.5) | Camera sees little movement (empty court, distant/dark footage) | Pick a livelier window; check with `debug-overlay.sh` |
| Reel is very slow to build | 3 encodes + a 2-pass CV analysis | Normal: ~1-3 min per reel on a laptop. Lower `--width` to speed up. |
| Aspect is 0.7988 not exactly 0.8 | Even-pixel rounding | Harmless (0.15% off). Platforms accept it. |

---

## 8. How this relates to the streamer's own reels

The streamer generates highlight reels on-box (ESP32 button → rolling buffer →
reel). **The tracking step here is literally the same code** —
`scripts/reframe_ball.py`, same `--mode action`. But this toolkit adds three
things production does not have:

| Step | This toolkit | Streamer (production) |
|---|---|---|
| Tracking | `reframe_ball.py` | **identical** |
| Letterbox strip | ✅ auto | ✗ not needed — camera is scaled to fill |
| Upscale to delivery size | ✅ | ✗ outputs the native crop |
| **Audio** | ✅ muxed | ✗ **always silent** |

Production reels are silent by construction: the rolling buffer, the extract and
the render all use `-an`. Even after removing those, a court only gets sound if
its camera actually carries audio — several report `hasAudio: false`, and the
live pipeline substitutes a silent track.

So: **use this toolkit for marketing reels with sound.** Don't expect a
streamer-generated reel to have any.
