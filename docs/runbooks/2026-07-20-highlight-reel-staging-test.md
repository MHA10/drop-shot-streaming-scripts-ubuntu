# Runbook — Testing Highlight Reel Capture on Staging

> **Audience**: Engineer/DevOps validating the highlight-reel feature on a staging streamer box before it goes to production.
> **Feature branch / PR**: `feat/highlight-clip-capture` → `staging` (PR #28)
> **Ships**: OFF by default — this runbook turns it on for one box and proves the end-to-end path.
> **Box layout**: repo at `~/Documents/drop-shot-streaming-scripts-ubuntu`, `.env` at repo root, PM2 process `streamer-<DROPSHOT_GROUND_ID>`, app runs via `npx streamer-node@latest`.

There is **no ESP32 button on staging**, so this runbook uses the built-in debug knobs (`HIGHLIGHT_FORCE_PRESENT` + `HIGHLIGHT_TRIGGER_FILE`) to simulate a hardware press. Everything downstream of the press (buffer → extract → reframe → render) is the real production path.

---

## Table of Contents

1. [What you are proving](#1-what-you-are-proving)
2. [Prerequisites](#2-prerequisites)
3. [Deploy the build to the box](#3-deploy-the-build-to-the-box)
4. [Configure `.env`](#4-configure-env)
5. [Restart and verify a clean boot](#5-restart-and-verify-a-clean-boot)
6. [Test A — the rolling buffer records](#6-test-a--the-rolling-buffer-records)
7. [Test B — fire a highlight and get a reel](#7-test-b--fire-a-highlight-and-get-a-reel)
8. [Test C — player-follow (ball-tracking) reel (optional)](#8-test-c--player-follow-ball-tracking-reel-optional)
9. [What to watch while it runs](#9-what-to-watch-while-it-runs)
10. [Success criteria](#10-success-criteria)
11. [Troubleshooting](#11-troubleshooting)
12. [Disable / rollback](#12-disable--rollback)

---

## 1. What you are proving

| # | Claim under test |
|---|---|
| A | With the feature on, the live YouTube stream is **unaffected** (no restart loop, no quality change). |
| B | The rolling buffer records the raw feed and stays **bounded** on disk (old segments pruned). |
| C | A simulated button press cuts a ~30s window and produces a **branded reel** file on disk. |
| D | (Optional) With ball tracking on, the reel is a **vertical player-follow crop**; if CV fails it falls back to full-frame — never loses the clip. |

---

## 2. Prerequisites

| Requirement | Verify |
|---|---|
| SSH to the staging box | `ssh <user>@<staging-host>` |
| Streamer already running a live stream | `pm2 status` → `streamer-<ground>` is `online` |
| `ffmpeg` + `ffprobe` present | `ffmpeg -version`, `ffprobe -version` |
| Disk headroom (buffer needs a few hundred MB) | `df -h .` |
| For Test C only: python3 + OpenCV | `python3 -c "import cv2, numpy"` (installed non-fatally by `setup.sh`) |

Set a shell var for convenience (used throughout):

```bash
export GID="$(grep -E '^DROPSHOT_GROUND_ID=' ~/Documents/drop-shot-streaming-scripts-ubuntu/.env | cut -d= -f2-)"
echo "$GID"   # sanity check — should print the ground id
```

---

## 3. Deploy the build to the box

The streamer runs the **published npm package**, not this git branch. The feature reaches the box only after a new version is published.

1. **Merge PR #28 into `staging`** (review first).
2. **Publish a new version** of `streamer-node` (whoever owns releases). `prepublishOnly` rebuilds, so `dist/` — including `dist/scripts/reframe_ball.py` — is included.
   - ⚠️ If publishing to the `latest` tag, **every** box on `@latest` picks this up on its next restart, not just staging. If staging must be isolated from production, publish under a separate dist-tag (e.g. `@next`) and point the staging runner at it. Confirm this with whoever owns publishing before proceeding.
3. On the box, pull the new version by restarting (the runner invokes `npx streamer-node@latest`):

```bash
pm2 restart streamer-$GID
pm2 logs streamer-$GID --lines 40   # confirm it booted the new version
```

> The `git clone` in `setup.sh` only provides PM2 tooling, `.env`, and `lib/highlight-trigger.sh` — it does **not** provide the app code. Make sure the box's checkout is on the merged `staging` commit so `lib/highlight-trigger.sh` is present.

---

## 4. Configure `.env`

Edit `~/Documents/drop-shot-streaming-scripts-ubuntu/.env` and add:

```bash
# --- Highlight reel (staging test) ---
HIGHLIGHT_ENABLED=true
HIGHLIGHT_FORCE_PRESENT=true                    # no ESP32 → pretend present so the buffer records
HIGHLIGHT_TRIGGER_FILE=/tmp/hl-trigger          # `touch` this to simulate a button press
HIGHLIGHT_BUFFER_DIR=/home/<user>/hl-buffer     # ABSOLUTE — see note below
HIGHLIGHT_OUTPUT_DIR=/home/<user>/hl-out        # ABSOLUTE — where reels land
# HIGHLIGHT_BALL_TRACKING_ENABLED=true          # enable only for Test C
```

> **Use absolute paths.** The defaults (`./highlight-buffer`, `./highlights`) are relative to the runner's working directory, which is not pinned by the PM2 launcher — so a relative path can land somewhere unexpected. Absolute paths remove all doubt and make the files easy to find.

**Why `HIGHLIGHT_FORCE_PRESENT=true` matters:** the rolling buffer only records when a highlight device is *present*. With no ESP32 attached, presence would be false and the buffer would stay empty — so there'd be nothing to cut. This knob forces presence on for the test. (Remove it in production; the ESP32 provides real presence.)

Apply the config:

```bash
pm2 restart streamer-$GID
```

---

## 5. Restart and verify a clean boot

```bash
pm2 logs streamer-$GID --lines 80
```

Expected within the first ~15s:

- ✅ `Highlight manual trigger file watch enabled` `{ triggerFile: /tmp/hl-trigger }`
- ✅ the normal live-stream startup logs (RTMP push to YouTube) — unchanged from before
- ✅ **no** repeated `stall detected` / `SIGKILL` / restart lines (see §9)

If you see `serialport module unavailable ...` that is **fine** on staging — presence is being forced, so serial isn't needed.

---

## 6. Test A — the rolling buffer records

Watch the buffer directory fill and self-prune:

```bash
watch -n 2 'ls -la /home/<user>/hl-buffer | tail'
```

Expected:
- ✅ New `.ts` (or `.mp4`) segments appear every ~2s (`HIGHLIGHT_BUFFER_SEGMENT_SEC`, floor 2s).
- ✅ After the retention window (default 45s = 25 pre + 5 post + 5 lag + 10 pad, `HIGHLIGHT_BUFFER_RETENTION_SEC`), the **oldest segments get deleted** — total count/size plateaus, it does **not** grow forever.

If the directory stays empty → presence isn't on (check `HIGHLIGHT_FORCE_PRESENT=true` and that you restarted).

---

## 7. Test B — fire a highlight and get a reel

Let a real rally play (or just let the stream run ~30s so the buffer has content), then fire the manual trigger with the helper script:

```bash
cd ~/Documents/drop-shot-streaming-scripts-ubuntu
bash lib/highlight-trigger.sh
```

The script checks the feature is enabled + a trigger file is configured, touches it, and prints where the reel will land. Then follow the logs:

```bash
pm2 logs streamer-$GID | grep -i highlight
```

Expected sequence:
1. ✅ `Highlight signal received (manual trigger file)`
2. ✅ `Highlight capture starting` `{ windowStartMs, windowEndMs }`
3. ✅ `Highlight reel rendered` (logos composited — if brand logos are present)
4. ✅ `Highlight captured` `{ finalPath: <...>, reframed: false, branded: true }`

Then inspect the output:

```bash
ls -la /home/<user>/hl-out/$GID/
ffprobe /home/<user>/hl-out/$GID/<file>.mp4   # confirm duration ~30s, playable
```

Copy it off the box (`scp`) and eyeball it: it should be the last ~30s of play with logos. Fire the trigger a few times to confirm repeatability.

---

## 8. Test C — player-follow (ball-tracking) reel (optional)

Only after Test B passes. Requires `python3 -c "import cv2, numpy"` to succeed.

```bash
# in .env:
HIGHLIGHT_BALL_TRACKING_ENABLED=true
pm2 restart streamer-$GID
bash lib/highlight-trigger.sh
pm2 logs streamer-$GID | grep -iE "reframe|highlight"
```

Expected:
- ✅ `Ball reframe complete` then `Highlight captured` with `{ reframed: true }` → the reel is a vertical (9:16) crop that follows the players.
- ✅ If CV fails for any reason (`Ball reframe failed; using full frame`, `Ball reframer script missing ...`), you still get a full-frame reel with `reframed: false`. **A failed reframe must never lose the clip** — verify a file still lands.

---

## 9. What to watch while it runs

| Watch-item | How | Bad sign | If it happens |
|---|---|---|---|
| **Live stream unaffected** | YouTube Studio / the live URL | Stream drops, stutters, or quality changes | Disable the feature (§12); this is a blocker for prod. |
| **Stall-detector false-fire** | `pm2 logs streamer-$GID \| grep -iE "stall\|SIGKILL\|restart"` | The 2nd (buffer) output makes the stall detector think the stream froze and it kills/restarts ffmpeg in a loop | Known watch-item. A high-water-mark fix is ready — apply it and re-publish if this trips. |
| **CPU headroom** | `pm2 monit` / `top` | CPU pinned ~100%, especially during a reframe | Keep ball tracking OFF; the CV pass is the heaviest step. |
| **Disk bounded** | `du -sh /home/<user>/hl-buffer` over time | Grows without bound | Retention isn't pruning — check `HIGHLIGHT_BUFFER_RETENTION_SEC` and dir permissions. |

---

## 10. Success criteria

- [ ] Feature enabled with the live stream **still healthy** for 10+ minutes (Claim A).
- [ ] Buffer records and **prunes** — size plateaus (Claim B).
- [ ] `bash lib/highlight-trigger.sh` produces a playable ~30s branded reel on disk, repeatably (Claim C).
- [ ] (Optional) Ball tracking yields a player-follow crop, and a forced failure still yields a full-frame reel (Claim D).
- [ ] No stall-detector restart loop observed (§9).

---

## 11. Troubleshooting

| Symptom / log line | Likely cause | Fix |
|---|---|---|
| Script: `HIGHLIGHT_ENABLED is not 'true'` | Feature off in `.env` | Set it, `pm2 restart streamer-$GID`. |
| Script: `HIGHLIGHT_TRIGGER_FILE is not set` | Knob missing | Add it to `.env`, restart. |
| Trigger file created but nothing happens | App not watching / not restarted after adding the knob | Confirm `Highlight manual trigger file watch enabled` is in the logs; restart. |
| `Highlight capture aborted: no active buffer for court` | Buffer empty at trigger time | Ensure `HIGHLIGHT_FORCE_PRESENT=true`; let the stream run ≥30s before triggering. |
| `Highlight capture failed: extraction produced no clip` | Requested window not on disk (buffer too short / retention < window) | Wait for the buffer to fill; keep `HIGHLIGHT_BUFFER_RETENTION_SEC` ≥ the full window. |
| `Highlight render skipped: no logo files present` | Brand logo assets missing | Non-fatal — you still get an un-branded reel. Add logos if branding is required. |
| `Ball reframer script missing; using full frame` | `dist/scripts/reframe_ball.py` not shipped | Confirm the published version was built with the updated `build` step; re-publish. |
| `serialport module unavailable ...` | Native module not installed | Fine on staging (presence forced). Only matters once real ESP32 hardware is used. |
| Stream restart loop | Stall detector + 2nd output | See §9 — apply the high-water-mark fix and re-publish. |

---

## 12. Disable / rollback

Feature is gated entirely behind `HIGHLIGHT_ENABLED`. To turn it off, comment/remove the highlight block in `.env` (or set `HIGHLIGHT_ENABLED=false`) and restart:

```bash
pm2 restart streamer-$GID
```

The live path returns to exactly its prior behavior — no buffer output, no serial, no reel pipeline. To roll the code back entirely, publish/point the box at the previous npm version and restart.

Clean up test artifacts:

```bash
rm -rf /home/<user>/hl-buffer/* /home/<user>/hl-out/* /tmp/hl-trigger
```
