# Rolling Ad Overlays (2-of-N, shuffled, staggered)

> **Final implementation (shipped):** native motion was required, so the poster-frame
> "Option A" below was extended. Pools that contain any animated ad (mp4/gif/webm)
> now take a **pre-composed concat** path: each ad is normalized to a uniform 220×500
> clip of its (clamped) duration, and all clips are concatenated into ONE looping MP4
> per slot. The main ffmpeg reads each slot with `-stream_loop -1`, so the rotation is
> baked into the looping video and the main encoder never restarts — animation is
> preserved. Still-only pools keep the live file-swap `AdRotator` (Option A) described
> below. The rotation order is shuffled per stream-start (not live mid-stream).

## Goal

Replace the static `ads: { left, right }` payload with a pool of N ads (expected 6)
that rotate through the two on-screen slots while the stream stays live. Two ads are
visible at any time (left + right 220×500 strips, unchanged positions). Each slot
advances independently on its own timer; the two slots never show the same ad at the
same instant; the pool is reshuffled each time it is fully consumed.

Hard constraint: **the YouTube encoder (main ffmpeg) must never restart for a rotation.**
A restart re-buffers the YouTube ingest and viewers see a stall.

## Payload change

Old (static):
```jsonc
"ads": { "left": "https://...", "right": "https://..." }
```

New (rolling pool):
```jsonc
"ads": [
  { "url": "https://...1", "duration": 15 },
  { "url": "https://...2", "duration": 10 },
  { "url": "https://...3" },               // duration optional → fallback
  ... (expected 6)
]
```

- `duration` is seconds the ad stays in its slot before rotating. Optional.
- Missing/invalid `duration` → `DEFAULT_AD_DURATION_SECONDS` (config, e.g. 12).
- `duration` clamped to `[MIN_AD_DURATION_SECONDS, MAX_AD_DURATION_SECONDS]`
  (e.g. 5..120) to avoid file-swap thrash / flicker and runaway values.
- Back-compat: if `ads` arrives as the legacy `{ left, right }` object, keep today's
  static path. If it arrives as an array, use the rolling path. (Lets the server roll
  out gradually; can be dropped once the server always sends the array.)

### Touch points for the payload
- `SSEStreamEvent.ads` (`src/domain/events/StreamEvent.ts`)
- `StartStreamRequest.ads` (`src/application/interfaces/StartStreamUseCase.types.ts`)
- Parse/normalize in `NodeSSEService.processStreamEvent`
  (`src/infrastructure/services/NodeSSEService.ts`)

Normalize to a single internal shape regardless of legacy/new:
```ts
type AdSpec = { url: string; durationSec: number };
type AdsPayload = AdSpec[];   // [] when no ads
```

## The core problem: rotating across all formats without restarting

ffmpeg's score overlay already rotates "live" with zero restart: it reads the PNG via
`-f image2 -loop 1` and re-reads the file on every loop, so Node just overwrites the
file on disk and the picture changes. This works **only for still images**.

For `-stream_loop -1` video/gif inputs, the input is opened once and its content
cannot be hot-swapped — rotating a video slot would require restarting the main ffmpeg.
That is exactly what we must avoid.

So the format strategy is the one real decision in this plan:

### Option A — Poster-frame normalization (RECOMMENDED, Phase 1)
At download time, reduce **every** ad to a single still PNG:
- `png`/`jpg` → use as-is (re-encode to PNG for a uniform slot format).
- `gif`/`mp4`/`webm`/`mov` → extract one representative frame to PNG (first keyframe,
  or a configurable timestamp) with a one-shot `ffmpeg -i ad -frames:v 1 out.png`.

Then rotation = the proven file-swap-of-stills mechanism. One unified, robust engine;
zero main-encoder restarts; supports all formats as **inputs**. Tradeoff: animated ads
play as a static frame (motion is lost).

### Option B — Per-slot sidecar pipe (Phase 2, only if motion is required)
Each slot is fed by a lightweight sidecar ffmpeg that decodes the current ad and pipes
raw frames into the main encoder through a fifo. The rotator restarts only the
**sidecar** (cheap, off-screen) when a slot changes; the YouTube encoder keeps running.
Preserves motion but adds two extra ffmpeg processes per court plus pipe plumbing and
teardown handling. Defer unless motion playback is a hard product requirement.

**Recommendation:** ship Option A first. It satisfies the rotation/shuffle/staggering
requirements end-to-end and is small and testable. Revisit Option B if/when motion
matters.

The rest of this plan assumes Option A.

## Components

### 1. AdDownloaderService (extend) — download + normalize the pool
`src/infrastructure/services/AdDownloaderService.ts`

- New `downloadPool(ads: AdSpec[], courtId): Promise<NormalizedAd[]>`:
  - Download all ads in parallel (reuse existing URL-sidecar cache + 10s timeout +
    fail-soft per ad).
  - Normalize each to `./ad/<courtId>/norm-<index>.png` (poster frame for video).
  - Drop any ad whose download **or** normalization fails (logged), so the returned
    pool contains only usable stills.
- `NormalizedAd = { pngPath: string; durationSec: number }`.
- Keep the existing single-file `download()` for the legacy static path.
- Store per court under `./ad/<courtId>/` so courts don't collide.

### 2. AdRotator (new) — the rotation engine
`src/infrastructure/services/AdRotator.ts`

State per court:
- `pool: NormalizedAd[]` (normalized, ≥0).
- `queue: number[]` — shuffled indices into `pool`; a cursor walks it; on wrap →
  reshuffle and continue (reshuffle-per-cycle).
- Two slots `left`/`right`, each with `{ currentPoolIndex, timer }`.
- Two fixed slot files on disk: `./ad/<courtId>/slot-left.png`,
  `./ad/<courtId>/slot-right.png` — these are what the main ffmpeg reads.

Lifecycle:
- `start()`:
  - If `pool.length === 0` → no-op (no ad inputs were added; nothing to do).
  - If `pool.length === 1` → write the one ad to the left slot only, no timers
    (right slot gets no input — see ffmpeg section).
  - Else: shuffle, seed left = `next()`, right = `next()` (skipping left's index),
    write both slot files, then schedule each slot's timer to its ad's duration.
    Stagger by giving the right slot an initial offset (e.g. half its first
    duration) so the two slots never swap on the same tick.
- On a slot timer fire:
  - `next()` → advance cursor, skipping the index currently shown in the **other**
    slot (guarantees the two visible ads differ).
  - Atomically replace that slot's file: write `slot-left.png.tmp` then
    `fs.renameSync` over `slot-left.png`. Rename is atomic on Linux; ffmpeg's next
    `image2` loop `open()` picks up the new inode — never reads a half-written file.
  - Reschedule the timer to the new ad's `durationSec`.
- `stop()`: clear both timers, mark stopped. Idempotent. Optionally remove slot files.

`next()` semantics:
- Pull `queue[cursor++]`; if `cursor` reached `queue.length` → reshuffle pool indices
  into `queue`, reset cursor. Skip the value currently in the other slot; if the pool
  is so small that the only candidate equals the other slot, allow it (degenerate
  ≤2 unique case).

Shuffle: Fisher–Yates. (Note: runtime randomness is fine here; the `Math.random`
restriction only applies inside Workflow scripts, not the app.)

### 3. NodeFFmpegService (adjust) — read fixed slot files
`src/infrastructure/services/NodeFFmpegService.ts`

- Today `buildAdInputFlags` branches on extension for video vs still. Under Option A
  both slots are always PNG, so each ad input is the score-overlay pattern:
  `-f image2 -loop 1 -i ./ad/<courtId>/slot-<side>.png`.
- `AdOverlayPaths` already carries `{ left, right }`; pass the **fixed slot file
  paths** (not the per-ad files). The existing overlay graph (220×500 bbox, left at
  `10:(main_h-overlay_h)/2`, right at `main_w-overlay_w-10:(main_h-overlay_h)/2`,
  explicit `-map`) is unchanged.
- Slot files must exist before ffmpeg launches → AdRotator seeds them first, or
  StartStreamUseCase writes the initial two frames before `startStream`.
- Slot presence drives inputs: 2 ads → both slots; 1 ad → left only; 0 → no ad inputs
  (matches existing `fs.existsSync` guards).

### 4. StartStreamUseCase (wire) — own the rotator's lifetime
`src/application/use-cases/StartStreamUseCase.ts`

- Replace `adDownloader.download(left)/download(right)` with
  `adDownloader.downloadPool(request.ads, courtId)`.
- Seed the two slot files (first two pool entries), pass slot paths to
  `ffmpegService.startStream(..., { left: slotLeftPath, right: slotRightPath })`.
- After ffmpeg starts, create + `start()` an `AdRotator`, and register it in a
  `Map<courtId, AdRotator>` (an `AdRotationRegistry`).
- **Critical lifecycle hooks** — a leaked `setTimeout`/rotator keeps swapping files
  for a dead stream:
  - `StopStreamUseCase` → look up rotator by court, `stop()`, remove from registry.
  - Retry path (`onRetryStream`) and failure (`markAsFailed`) → `stop()` old rotator
    before the new process starts; the re-`execute()` rebuilds it (fresh shuffle).
  - `killAllProcesses` / shutdown → stop all rotators.

### 5. Config (add)
`src/infrastructure/config/Config.ts`
- `DEFAULT_AD_DURATION_SECONDS` (e.g. 12)
- `MIN_AD_DURATION_SECONDS` / `MAX_AD_DURATION_SECONDS` (e.g. 5 / 120)
- (slot bbox 220×500 stays in NodeFFmpegService)

## End-to-end flow

```
SSE start event { ads: [{url,duration}, ...] }
  → NodeSSEService normalizes → AdSpec[]
  → StartStreamUseCase.execute
      → AdDownloaderService.downloadPool   (parallel download + poster-frame normalize, fail-soft)
      → seed slot-left.png / slot-right.png (first two)
      → NodeFFmpegService.startStream      (image2-loop inputs on the two fixed slot files)
      → AdRotator.start                    (shuffle; per-slot staggered timers)
      → register rotator by courtId
  ... stream runs; rotator overwrites slot files on each slot's timer ...
StopStream / retry / failure / shutdown
  → AdRotator.stop (clear timers) + deregister
```

## Edge cases
- **0 ads** → no ad inputs, no rotator (current behavior).
- **1 usable ad** → static left slot, no rotation, right slot empty.
- **2+ but some downloads fail** → rotate over whatever normalized successfully.
- **Duplicate-avoidance with a tiny pool (=2)** → left/right pin to the two; with the
  skip rule they simply hold (no thrash).
- **duration missing/invalid/out-of-range** → fallback + clamp.
- **Stream retry/restart** → tear down rotator, rebuild from same payload (reshuffled).
- **Atomic writes** → temp-file + rename so ffmpeg never reads a partial PNG.
- **Court isolation** → per-court `./ad/<courtId>/` dir and registry key.

## Open decision (needs sign-off)
**Motion vs simplicity.** Option A (poster frame) flattens animated ads to a still but
gives a small, robust, zero-restart rotation engine now. Option B (sidecar pipes)
preserves motion at real complexity cost. Recommend A for v1; add B later only if
motion is required.

## Rollout / testing
- Unit: AdRotator `next()` shuffle + reshuffle-on-wrap + duplicate-skip + timer
  scheduling (inject a fake clock); AdDownloaderService poster-frame normalize.
- Integration: 6-ad payload on one court — confirm both slots advance independently,
  never show the same ad simultaneously, reshuffle after a full cycle, and the main
  ffmpeg PID never changes across many rotations.
- Manual: run a real court; watch left/right swap on their own cadence with no YouTube
  stall; verify cleanup leaves no orphan timers after stop.
```

