# Runbook — Testing Highlight Reel Capture on Staging

> **Audience**: Engineer/DevOps validating the highlight-reel feature on a staging streamer box before it goes to production.
> **Feature branch / PR**: `feat/highlight-clip-capture` → `staging` (PR #28)
> **Ships**: OFF by default — this runbook turns it on for one box and proves the end-to-end path.
> **Box layout**: repo at `/home/ds/Documents/drop-shot-streaming-scripts-ubuntu`, `.env` at repo root.
> **Staging runs from the git checkout** via `lib/pm2/run-staging.sh` (`npm run dev` = build + start), PM2 process **`dropshot-staging`**, working dir pinned to the repo dir. This means **no `npm publish` is needed to test here** — you deploy by pulling the branch and restarting. (Production is different: it runs `npx streamer-node@latest` as `streamer-<ground>`; that path is only relevant after staging passes — see §3.)
> First, confirm which runner your box uses: `pm2 status`. This runbook assumes **`dropshot-staging`**; if instead you see `streamer-<ground>`, your box uses the npx/publish path and you must follow §3B.

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
| Streamer already running a live stream | `pm2 status` → `dropshot-staging` is `online` |
| `ffmpeg` + `ffprobe` present | `ffmpeg -version`, `ffprobe -version` |
| Disk headroom (buffer needs a few hundred MB) | `df -h .` |
| For Test C only: python3 + OpenCV | `python3 -c "import cv2, numpy"` (installed non-fatally by `setup.sh`) |

Set shell vars for convenience (used throughout). `PROC` is the PM2 process name — confirm it against `pm2 status`:

```bash
export REPO=/home/ds/Documents/drop-shot-streaming-scripts-ubuntu
export PROC=dropshot-staging     # from `pm2 status`; use streamer-<ground> if that's what you see
export GID="$(grep -E '^DROPSHOT_GROUND_ID=' "$REPO/.env" | cut -d= -f2-)"
echo "$PROC / $GID"   # sanity check
```

---

## 3. Deploy the build to the box

### 3A. Staging (`dropshot-staging` — runs from the git checkout)

This is the normal staging path. The service runs `lib/pm2/run-staging.sh`, which `cd`s into the repo and runs `npm install && npm run dev` (`dev` = `build` + `start`). So the box runs **whatever the checkout is on** — no `npm publish`, no effect on production boxes. `npm run build` copies `scripts/ → dist/`, so `reframe_ball.py` ships automatically.

```bash
cd "$REPO"
git fetch origin
git checkout feat/highlight-clip-capture && git pull    # or `staging` once PR #28 is merged
# restart re-runs run-staging.sh → npm install + build + start
pm2 restart "$PROC"
pm2 logs "$PROC" --lines 60    # watch it install → build → boot
```

> Restart re-runs `npm install`, which also (re)installs the optional `serialport`. If that native build fails on the box it is **non-fatal** — highlights just can't use real hardware; the forced-presence test path still works.

### 3B. Production-style boxes (`streamer-<ground>` — runs `npx @latest`)

Only if `pm2 status` showed `streamer-<ground>` instead. These run the **published npm package**, so the feature reaches them only after a publish:

1. Merge PR #28, then **publish a new `streamer-node` version** (whoever owns releases; `prepublishOnly` rebuilds `dist/` incl. `dist/scripts/reframe_ball.py`).
2. ⚠️ Publishing to the `latest` tag means **every** `@latest` box picks it up on its next restart — not just this one. To isolate, publish under a separate dist-tag (e.g. `@next`) and point only this box's runner at it. Confirm with whoever owns publishing first.
3. `pm2 restart "$PROC"` then `pm2 logs "$PROC" --lines 40` to confirm the new version booted.

---

## 4. Configure `.env`

Edit `$REPO/.env` and add:

```bash
# --- Highlight reel (staging test) ---
HIGHLIGHT_ENABLED=true
HIGHLIGHT_FORCE_PRESENT=true                    # no ESP32 → pretend present so the buffer records
HIGHLIGHT_TRIGGER_FILE=/tmp/hl-trigger          # `touch` this to simulate a button press
HIGHLIGHT_BUFFER_DIR=/home/ds/hl-buffer         # absolute — see note below
HIGHLIGHT_OUTPUT_DIR=/home/ds/hl-out            # absolute — where reels land
# HIGHLIGHT_BALL_TRACKING_ENABLED=true          # enable only for Test C
```

> **Paths.** On `dropshot-staging` the working dir is pinned to `$REPO`, so the defaults (`./highlight-buffer`, `./highlights`) resolve predictably *inside the repo* — fine, but they'll clutter the checkout. Absolute paths (as above) keep test artifacts out of the repo and are unambiguous on any runner. Either works; absolute is recommended.

**Why `HIGHLIGHT_FORCE_PRESENT=true` matters:** the rolling buffer only records when a highlight device is *present*. With no ESP32 attached, presence would be false and the buffer would stay empty — so there'd be nothing to cut. This knob forces presence on for the test. (Remove it in production; the ESP32 provides real presence.)

Apply the config:

```bash
pm2 restart $PROC
```

---

## 5. Restart and verify a clean boot

```bash
pm2 logs $PROC --lines 80
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
watch -n 2 'ls -la /home/ds/hl-buffer | tail'
```

Expected:
- ✅ New `.ts` (or `.mp4`) segments appear every ~2s (`HIGHLIGHT_BUFFER_SEGMENT_SEC`, floor 2s).
- ✅ After the retention window (default 45s = 25 pre + 5 post + 5 lag + 10 pad, `HIGHLIGHT_BUFFER_RETENTION_SEC`), the **oldest segments get deleted** — total count/size plateaus, it does **not** grow forever.

If the directory stays empty → presence isn't on (check `HIGHLIGHT_FORCE_PRESENT=true` and that you restarted).

---

## 7. Test B — fire a highlight and get a reel

Let a real rally play (or just let the stream run ~30s so the buffer has content), then fire the manual trigger with the helper script:

```bash
cd $REPO
bash lib/highlight-trigger.sh
```

The script checks the feature is enabled + a trigger file is configured, touches it, and prints where the reel will land. Then follow the logs:

```bash
pm2 logs $PROC | grep -i highlight
```

Expected sequence:
1. ✅ `Highlight signal received (manual trigger file)`
2. ✅ `Highlight capture starting` `{ windowStartMs, windowEndMs }`
3. ✅ `Highlight reel rendered` (logos composited — if brand logos are present)
4. ✅ `Highlight captured` `{ finalPath: <...>, reframed: false, branded: true }`

Then inspect the output:

```bash
ls -la /home/ds/hl-out/$GID/
ffprobe /home/ds/hl-out/$GID/<file>.mp4   # confirm duration ~30s, playable
```

Copy it off the box (`scp`) and eyeball it: it should be the last ~30s of play with logos. Fire the trigger a few times to confirm repeatability.

---

## 8. Test C — player-follow (ball-tracking) reel (optional)

Only after Test B passes. Requires `python3 -c "import cv2, numpy"` to succeed.

```bash
# in .env:
HIGHLIGHT_BALL_TRACKING_ENABLED=true
pm2 restart $PROC
bash lib/highlight-trigger.sh
pm2 logs $PROC | grep -iE "reframe|highlight"
```

Expected:
- ✅ `Ball reframe complete` then `Highlight captured` with `{ reframed: true }` → the reel is a vertical (9:16) crop that follows the players.
- ✅ If CV fails for any reason (`Ball reframe failed; using full frame`, `Ball reframer script missing ...`), you still get a full-frame reel with `reframed: false`. **A failed reframe must never lose the clip** — verify a file still lands.

---

## 9. What to watch while it runs

| Watch-item | How | Bad sign | If it happens |
|---|---|---|---|
| **Live stream unaffected** | YouTube Studio / the live URL | Stream drops, stutters, or quality changes | Disable the feature (§12); this is a blocker for prod. |
| **Stall-detector false-fire** | `pm2 logs $PROC \| grep -iE "stall\|SIGKILL\|restart"` | The 2nd (buffer) output makes the stall detector think the stream froze and it kills/restarts ffmpeg in a loop | Known watch-item. A high-water-mark fix is ready — apply it and re-publish if this trips. |
| **CPU headroom** | `pm2 monit` / `top` | CPU pinned ~100%, especially during a reframe | Keep ball tracking OFF; the CV pass is the heaviest step. |
| **Disk bounded** | `du -sh /home/ds/hl-buffer` over time | Grows without bound | Retention isn't pruning — check `HIGHLIGHT_BUFFER_RETENTION_SEC` and dir permissions. |

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
| Script: `HIGHLIGHT_ENABLED is not 'true'` | Feature off in `.env` | Set it, `pm2 restart $PROC`. |
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
pm2 restart $PROC
```

The live path returns to exactly its prior behavior — no buffer output, no serial, no reel pipeline. To roll the code back entirely, publish/point the box at the previous npm version and restart.

Clean up test artifacts:

```bash
rm -rf /home/ds/hl-buffer/* /home/ds/hl-out/* /tmp/hl-trigger
```
