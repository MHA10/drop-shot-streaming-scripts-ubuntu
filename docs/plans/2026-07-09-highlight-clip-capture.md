# Highlight Clip Capture Implementation Plan

## Overview

Add a highlight-clip capture feature to the streamer: an ESP32 device (already
wired into an existing Arduino → ESP8266 mesh → ESP32 → USB-serial hardware
pipeline) sends a signal to the streamer when a referee/operator marks a
highlight moment during a match. The streamer extracts a ~30 second video
window around that moment from a continuously-recorded rolling buffer (since
we cannot rewind live video after the fact), then runs it through a
post-processing pipeline — ball-tracking-driven dynamic crop and logo overlay
— to produce a social-media-ready clip, without disrupting the live YouTube
RTMP stream.

## Current State Analysis

- The streamer runs exactly one `ffmpeg` process per active stream
  (`NodeFFmpegService.startStream`, `src/infrastructure/services/NodeFFmpegService.ts:42`),
  which connects directly to the court's RTSP camera and encodes straight to
  the YouTube RTMP endpoint. Nothing buffers or records raw video anywhere.
- **The court camera supports only one concurrent RTSP connection** (confirmed
  with the team) — a hard constraint on any design that needs a second reader
  of the camera. This rules out a second, independent `ffmpeg -i <camera-url>`
  process for the buffer. It does **not** require new infrastructure, though
  — see Implementation Approach: the existing single connection can be
  branched *inside* the one process that already holds it.
- Live overlays (DropShot logo, client logo, ad slots, scorecard) are
  composited in-process via `-filter_complex` (`NodeFFmpegService.ts:307-483`).
  There is a well-established "live-reload" trick used three times already
  (score overlay, ad slots): write a PNG/MP4 to a fixed path, have ffmpeg read
  it with `-f image2 -loop 1` or `-stream_loop -1`, and the running encoder
  reflects file changes with **zero process restart**.
- `AdDownloaderService` (`src/infrastructure/services/AdDownloaderService.ts`)
  already establishes the pattern for a **separate, one-shot ffmpeg
  post-processing pipeline** that is fully decoupled from the live encoder:
  download → normalize → clip → concat, all via temp-file+rename atomic
  writes, with a concurrency cap (`clipConcurrency = 3`) so it never starves
  the live encoder. This plan reuses that pattern for highlight processing
  *after* extraction (Phases 4–5) — but not for the buffer itself, which has
  to live inside the live process for the reason above.
- `docs/plans/bounding-box-sizing.md` documents the exact pixel geometry of
  every live overlay in the 1920×1080 output space (logos, ad slots). This
  geometry is **not** reused for highlight clips — see Key Discoveries.
- Lifecycle of per-court auxiliary processes (start/stop/retry/shutdown) is
  already solved once for the ad rotator: `AdRotationRegistry`, wired through
  `StartStreamUseCase.execute` (`src/application/use-cases/StartStreamUseCase.ts:266-321`)
  and torn down in `StopStreamUseCase`, the retry path (`onRetryStream`), and
  `StreamManagerService.stopAllStreams`/shutdown. The buffer's manifest/
  cleanup bookkeeping (Phase 2) follows the same registry shape, but — unlike
  the ad rotator — it manages no child process of its own; the recording
  itself is just another output of the existing live ffmpeg process.
- **No hardware/serial/GPIO code exists in this repo.** Confirmed via
  `lib/NEW-STREAMER-SETUP-07-04-26/setup.sh` (stock Ubuntu provisioning, no
  serial/GPIO deps) and `package.json` (no `serialport` or similar).
- **The hardware transport already exists**, just not yet consumed by this
  repo. Three sibling repos define an existing pipeline:
  - `arduino-scoreboard` (Arduino Pro Mini): reads RF remote buttons, sends
    pipe-delimited packets like `TENNIS|15|40|1|0` over hardware serial to the
    ESP8266. **All 4 RF input pins (A0–A3) are already assigned** to score
    up/down/mode/reset (`Input.cpp`) — there is no spare physical button for a
    highlight trigger today.
  - `esp8266`: relays those packets over a `painlessMesh` wireless mesh
    network to the ESP32.
  - `esp32-leader`: the mesh root node, physically connected to the streamer
    box via USB. It reprints whatever it receives from the mesh verbatim over
    **USB serial at 115200 baud, newline-terminated** — no framing, no JSON,
    just the same pipe-delimited ASCII lines (`esp32-leader.ino`). This is
    exactly the mechanism this plan's serial listener consumes.
- **No packet in the existing protocol carries a timestamp.** The mesh hop
  (Arduino → ESP8266 → ESP32) is wireless and has unbounded, uncharacterized
  latency. The only timestamp available to the streamer is its own receipt
  time.

### Key Discoveries

- The camera's single-RTSP-connection limit does **not** require any new
  proxy/relay infrastructure. `ffmpeg` can branch an already-decoded input
  stream inside a single process via the `split` filter — one branch
  continues into the existing overlay chain unchanged, the other becomes a
  second output (the buffer writer). This keeps the connection count to
  exactly one, identical to today, with no new system dependency to install,
  monitor, or provision on every streamer box.
- Because that buffer branch is tapped **before the overlay filter chain**,
  highlight clips never contain ads or logos in the first place — "remove the
  ads area" is satisfied structurally by *where* the split happens, not by an
  active cropping/masking step. `bounding-box-sizing.md`'s overlay geometry is
  therefore not needed for highlight processing.
- **Cost of this approach, stated plainly:** the buffer branch is *decoded,
  raw* video by the time it reaches the split point — it cannot be written
  with `-c copy` (that only works on already-encoded bitstreams). It needs its
  own (deliberately cheap — low resolution, `ultrafast` preset, no audio)
  second x264 encode, running continuously alongside the live encode in the
  same process. This is a real, bounded CPU cost to validate on staging
  against a live stream (Phase 1's manual verification), not a free operation.
  The tradeoff for accepting this cost is avoiding an entirely new
  infrastructure component (a local RTSP relay) with its own install, health
  monitoring, and dynamic-path-registration surface.
- Adding a second output to the existing ffmpeg invocation also means a
  second question to validate empirically on staging: whether the existing
  stall-detection heuristic (`NodeFFmpegService.startStream`'s stderr
  `time=` regex, `NodeFFmpegService.ts:99-128`) still reflects the **live
  RTMP output's** progress once a second output exists, since ffmpeg's
  default human-readable progress line can shift which output it reports on
  when there are multiple. Flagged as an explicit manual-verification item in
  Phase 1 rather than assumed.
- Because the highlight window is only ever known *after* the match moment has
  already happened (the referee reacts to something that already occurred),
  ball-tracking analysis can run **offline, with no live-latency budget** —
  it operates on an already-recorded ~30s file, not a real-time stream. This
  is the basis for treating ball-tracking as a batch/offline stage rather
  than a real-time CV problem squeezed onto a box that's already busy
  live-encoding.
- `AdDownloaderService.runFfmpegToFile` (`AdDownloaderService.ts:533-580`)
  establishes the exact "temp file + rename, timeout, fail-soft" pattern every
  new one-shot ffmpeg call in this plan (Phases 4–5) should follow.

## Desired End State

A referee presses a highlight button (hardware TBD — see Assumptions &
Dependencies). Within the configured pre/post-roll window plus a short
processing delay, a finished MP4 highlight clip appears in
`./highlights/<courtId>/<timestamp>.mp4`: framed by a ball-tracking-driven
crop when tracking succeeds (falling back to a safe static frame when it
doesn't), with the DropShot and client logos freshly overlaid on the final
canvas. A structured log trail exists from "signal received" through to
"clip written" or a specific failure reason. None of this affects the
concurrently running live YouTube stream — verified by the live stream's PID
never restarting and its bitrate/frame-time staying stable while a highlight
is being processed or the buffer is recording.

**Verification:** trigger a highlight signal (or, before hardware exists, a
manual test trigger — see Phase 3) during a live stream on staging and
confirm a valid, correctly-windowed, logo-overlaid MP4 is produced, while
`pm2 monit`/the existing stall-detection logs show no impact on the live
encoder.

## What We're NOT Doing

- **Not** introducing a local RTSP relay/proxy (e.g. `mediamtx`) or any new
  standing infrastructure service for the buffer. The buffer is a second
  output of the existing single ffmpeg process — see Implementation Approach.
- **Not** designing or building the Arduino/ESP8266/ESP32 firmware change that
  produces a `HIGHLIGHT` packet. That is hardware/firmware work coordinated
  with Hassan's team (see Assumptions & Dependencies). This plan defines the
  packet contract the streamer expects and is otherwise firmware-agnostic.
- **Not** solving physical placement of a highlight button (spare RF channel,
  new transmitter, or a debug-serial keystroke) — hardware decision, out of
  scope for this repo.
- **Not** shipping a production-grade ball-tracking model in the first cut.
  Phase 5 includes a bounded prototype/validation spike; if classical CV
  doesn't clear the bar, the fallback (static crop/full-frame) ships instead,
  and real tracking becomes a follow-up.
- **Not** building clip delivery/upload to the backend, Cloudinary, or any
  CDN. Clips are written to local disk with a structured log entry; wiring
  delivery is a follow-up once we know where clips should land.
- **Not** supporting multiple concurrent cameras/courts per streamer box.
  Matches today's deployment model (one `DROPSHOT_GROUND_ID`, one camera, one
  active stream per box) — the highlight signal is always routed to "the"
  currently running stream on this box, not disambiguated by courtId in the
  packet.
- **Not** changing the existing live overlay system (scorecard, ads, logos) in
  any way. The buffer branch taps the feed before overlays are applied and
  otherwise leaves the existing filter graph and outputs untouched.
- **Not** running a separate server/service to listen for the ESP32 highlight
  signal. "Something needs to listen for the button press" is a
  responsibility, not a deployment unit — it's fulfilled by
  `SerialHighlightListener` (Phase 3), a component living inside the same
  streamer Node process, reading directly off the USB device already
  attached to the box. No new port, no network hop, nothing new to deploy or
  supervise.

## Implementation Approach

Three structural decisions drive this plan, each resolved to avoid the
riskiest or heaviest alternative:

1. **The rolling buffer is a second output of the existing live ffmpeg
   process, not a new process or new infrastructure.** `NodeFFmpegService`
   already owns the single permitted connection to the camera. A `split`
   filter branches the decoded, scaled frame *before* the overlay chain: one
   branch continues into the existing overlay/RTMP path completely unchanged;
   the other becomes a second `-map`'d output that encodes cheaply (low
   resolution, `ultrafast`, no audio) and writes rolling segments to disk.
   This avoids adding any new system dependency, keeps the connection count
   at exactly one (matching the camera's hard limit), and is directly
   testable the way the team already validates changes — push to staging,
   run against a real live stream, and watch that both outputs behave.
2. **The buffer taps the raw feed, pre-overlay**, which is what makes "no ads
   in the highlight clip" automatic rather than an active removal step — the
   split happens before logos/ads/scorecard are composited on, so they simply
   never reach the buffer branch.
3. **Ball-tracking runs offline, after extraction, gated by a prototype.**
   Because the window is only known after the fact, there is no live-latency
   budget — tracking analyzes an already-saved ~30s file. A validation spike
   runs before full integration; a safe static-frame fallback ships
   regardless of whether tracking clears the bar, so highlight delivery is
   never blocked on CV accuracy.

## Assumptions & Dependencies

These are stated explicitly so they can be corrected — resolving them keeps
this plan free of open questions, but several depend on parties outside this
repo:

- **Hardware/firmware dependency (blocks Phase 3 end-to-end testing, not
  Phases 1–2 or 4–6):** the Arduino/ESP8266/ESP32 firmware needs a new
  highlight-trigger input and must emit a new packet type over the existing
  serial line. Proposed minimal contract to hand to Hassan's team:
  ```
  HIGHLIGHT
  ```
  A bare packet type, newline-terminated, matching the existing convention
  (`TENNIS|...`, `HEARTBEAT|ESP32`). No courtId/timestamp fields needed since
  one box runs exactly one stream at a time (see "What We're NOT Doing") and
  the mesh has no reliable clock to stamp with anyway. If the hardware team
  can cheaply add a monotonic sequence number (`HIGHLIGHT|<seq>`), that's
  useful for de-duplicating retransmissions but is not required for v1.
- **Mesh latency is uncharacterized.** The `lagMarginSec` config value
  (Phase 3/4) starts at a conservative default and must be calibrated against
  real hardware once available. This plan cannot determine the true value
  from code.
- **CPU headroom for a second, continuous (cheap) encode is assumed
  sufficient but unverified** — Phase 1's manual verification on staging
  against a real live stream is what actually confirms this, per the box's
  real hardware.
- **One streamer box runs one camera/one active stream at a time** — matches
  current deployment (single `DROPSHOT_GROUND_ID` per box). If this changes,
  the buffer's per-court output path (Phase 1) and highlight routing
  (Phase 3) need a courtId disambiguation step that this plan does not build.
- **Ball tracking (Phase 5) requires `python3` + `opencv-python` provisioned
  on every streamer box** (`lib/NEW-STREAMER-SETUP-07-04-26/setup.sh`, same
  category as the existing `ffmpeg` install step). It runs as a one-shot
  subprocess per highlight, not a standing service — no new server, no new
  port, nothing to supervise between invocations.

---

## Phase 1: In-Process Highlight Buffer Branch

### Overview

Extend the existing single ffmpeg command with a second output: a
continuously-written, rolling set of raw (pre-overlay) video segments. No new
process, no new system dependency — this is a change to
`NodeFFmpegService.buildStreamCommand`'s filter graph and output arguments,
validated directly against a live stream on staging.

### Changes Required

#### 1. FFmpegService domain interface (add an optional param)

**File**: `src/domain/services/FFmpegService.ts`
**Changes**: Add an optional `highlightBufferDir?: string | null` parameter to
both `startStream` and `buildStreamCommand`, following the exact style of the
existing optional `isScorecardActivated`/`adPaths` params. `null`/absent means
"no buffer branch" — the command is generated exactly as it is today.

#### 2. NodeFFmpegService (branch the filter graph, add a second output)

**File**: `src/infrastructure/services/NodeFFmpegService.ts`
**Changes**: In `buildStreamCommand`, split the scaled base frame before any
overlay is applied:

```
// Today:
[0:v] scale=1920:1080 [base];
// ...overlays consume [base]...

// With a buffer dir configured:
[0:v] scale=1920:1080 [scaled];
[scaled] split=2 [base][hlbuf];
// ...overlays consume [base] exactly as before, completely unchanged...
```

`[hlbuf]` is left unfiltered (already at the target resolution) and mapped to
a second output group appended after the existing RTMP output arguments:

```
-map [hlbuf] -c:v libx264 -preset ultrafast -b:v 800k -an \
  -f segment -segment_time 2 -reset_timestamps 1 -strftime 1 \
  <highlightBufferDir>/seg-%s.ts
```

Deliberately cheap encode settings (low bitrate, `ultrafast`, no audio) since
this is an intermediate artifact that gets reframed/re-encoded again later
(Phase 5) — quality parity with the broadcast output is not needed.

#### 3. StartStreamUseCase (pass the buffer dir through)

**File**: `src/application/use-cases/StartStreamUseCase.ts`
**Changes**: When highlight capture is active for this box, resolve the
per-court buffer directory (e.g. `./highlight-buffer/<courtId>/`, created if
missing, `courtId` sanitized) and pass it through to
`ffmpegService.startStream`. No registry/lifecycle object is needed here yet —
the buffer branch lives and dies exactly with the live ffmpeg process, same as
every other overlay input.

**Enablement model (decided 2026-07-18): auto-detect the ESP32, not a per-box
env flag.** Editing `.env`/`setup.sh` on every streamer does not scale, and
the buffer must already be running before a highlight signal arrives (we can't
rewind), so enablement can't wait for an actual button press. Instead the
buffer runs **iff the highlight hardware is present on this box**, determined
at runtime from the serial device: the ESP32 emits `HEARTBEAT|ESP32` every 5s
(`esp32-leader.ino`), so "present" = the known serial device is open and has
produced recognized traffic recently. `StartStreamUseCase` consults a
`HighlightSignalSource.isDevicePresent()` (provided by the Phase 3 serial
listener, started at app boot) at stream start and gates the buffer on that.

Consequences:
- This makes a **minimal serial-presence detector a dependency of the buffer
  gate**, i.e. a slice of Phase 3 moves ahead of / alongside Phase 1's
  enablement. Boxes without the ESP32 plugged in never pay the second-encode
  cost; plugging the device in turns highlights on with zero config.
- `HIGHLIGHT_ENABLED` is the master enable, AND'd with `isDevicePresent()`.
  **It ships default FALSE until Phase 2 exists** — the rolling buffer has no
  retention/cleanup yet, so auto-running it (default-on) could fill the disk,
  and since it's a second output of the live ffmpeg a full disk can take the
  live stream down too. Presence-based auto-enable is already wired; once Phase
  2 bounds the buffer, flip this default to true to get the intended
  zero-config behavior (a box with the ESP32 attached records automatically).
  Until then, set `HIGHLIGHT_ENABLED=true` only on a test box.

### Success Criteria

#### Automated Verification:
- [ ] `npx tsc --noEmit` passes
- [ ] Unit test: `buildStreamCommand` with `highlightBufferDir` set produces
      the expected `split`/second-output args; with it unset, produces
      byte-identical output to today (no regression to the existing overlay
      behavior)

#### Manual Verification:
- [ ] On staging, starting a real stream with the buffer branch enabled
      produces identical live YouTube video/audio as before this change (no
      visible quality change, no latency change)
- [ ] `pm2 monit` shows acceptable CPU/memory headroom with the second encode
      running continuously — this is the actual validation of the "cheap
      encode" assumption above
- [ ] **WATCH ITEM (found in local full-app test 2026-07-20):** the existing
      stall detector (`NodeFFmpegService.startStream`: "10 identical `time=` →
      SIGKILL") can FALSE-POSITIVE with the second output present — ffmpeg
      emits interleaved progress from both outputs and the naive single-value
      `time=` tracker can read a non-advancing value and restart a HEALTHY
      stream in a loop. Locally this was entangled with CPU contention (a
      laptop running the 1080p dual-encode at ~0.5× produced a transient
      startup freeze); the same command run directly (no app killer) was
      healthy (`time=`→24s, segments written). On staging, confirm the live
      stream does NOT enter a stall-restart loop once the buffer is enabled.
      If it does, the ready fix is a monotonic high-water-mark of `time=`
      (flag a stall only when the MAX observed time stops advancing) — this is
      behavior-identical for today's single-output streams and only corrects
      the multi-output case. Do NOT pre-emptively change core retry logic
      without staging evidence.
- [ ] Segment files appear in the configured buffer directory and are valid,
      playable video when inspected with `ffprobe`/`ffplay`

---

## Phase 2: Buffer Manifest & Retention Cleanup

### Overview

Track which segment file covers which wall-clock time range, and continuously
delete segments older than the retention window. This is pure bookkeeping —
no child process to manage, since Phase 1 already made segment *writing* part
of the live ffmpeg process's own lifecycle.

### Changes Required

#### 1. Config additions

**File**: `src/infrastructure/config/Config.ts`
**Changes**: New `highlight` config section:

```ts
highlight: {
  // Master enable, AND'd with isDevicePresent() (Phase 1 §3). Default FALSE
  // until Phase 2 retention bounds the buffer; flip to true afterwards for
  // zero-config presence-driven enablement. Strict: only "true" enables.
  enabled: boolean;               // HIGHLIGHT_ENABLED, default false
  preRollSec: number;             // HIGHLIGHT_PRE_ROLL_SEC, default 25
  postRollSec: number;            // HIGHLIGHT_POST_ROLL_SEC, default 5
  lagMarginSec: number;           // HIGHLIGHT_LAG_MARGIN_SEC, default 5 (conservative; calibrate against real mesh hardware)
  bufferSegmentSec: number;       // HIGHLIGHT_BUFFER_SEGMENT_SEC, default 2
  bufferRetentionSec: number;     // derived: preRoll + postRoll + lagMargin + 10s safety pad, overridable
  outputDir: string;              // HIGHLIGHT_OUTPUT_DIR, default "./highlights"
  bufferDir: string;              // HIGHLIGHT_BUFFER_DIR, default "./highlight-buffer"
  ballTracking: {
    enabled: boolean;             // HIGHLIGHT_BALL_TRACKING_ENABLED, default false until Phase 5 validation passes
  };
}
```

#### 2. HighlightBufferManager (new — bookkeeping only, no process)

**File**: `src/infrastructure/services/HighlightBufferManager.ts`
**Changes**:

```ts
interface SegmentRecord { path: string; startMs: number; endMs: number }

export class HighlightBufferManager {
  // Starts a periodic cleanup timer for this court's buffer directory.
  // Segment start times are read directly from filenames (embedded via
  // -strftime 1 in Phase 1), so the manifest can be rebuilt from disk at any
  // time with no separate persistence needed.
  public start(courtId: string): void { /* setInterval cleanup sweep */ }

  public stop(courtId: string): void { /* clearInterval */ }

  // Returns the ordered segment records overlapping [startMs, endMs], or
  // null if the buffer doesn't have enough history yet.
  public getSegmentsInWindow(courtId: string, startMs: number, endMs: number): SegmentRecord[] | null { /* ... */ }
}
```

The cleanup sweep deletes any segment whose `endMs` is older than
`now - bufferRetentionSec`.

#### 3. HighlightBufferRegistry (new, mirrors AdRotationRegistry's shape)

**File**: `src/infrastructure/services/HighlightBufferRegistry.ts`
**Changes**: `Map<courtId, HighlightBufferManager>` with `set`/`stop`/
`stopAll`, following the exact shape of `AdRotationRegistry` referenced in
`main.ts:21` and `StartStreamUseCase.ts:254,269` — but note this registry
only ever stops a cleanup timer, never a child process, since Phase 1 folded
segment writing into the live ffmpeg process itself.

#### 4. Wire into StartStreamUseCase / StopStreamUseCase / shutdown

**File**: `src/application/use-cases/StartStreamUseCase.ts`,
`src/application/use-cases/StopStreamUseCase.ts`, `src/main.ts`
**Changes**: Start the manifest/cleanup timer right after the live ffmpeg
process starts; stop it in the same three places `AdRotationRegistry.stop` is
already called (stop use case, retry path, `killAllProcesses`/shutdown in
`main.ts`'s `setupGracefulShutdown`).

### Success Criteria

#### Automated Verification:
- [ ] `npx tsc --noEmit` passes
- [ ] Unit test: manifest correctly identifies segments overlapping a given
      window, including partial-overlap edge segments, from filenames alone
- [ ] Unit test: cleanup sweep removes segments older than
      `bufferRetentionSec` and never removes segments still within it

#### Manual Verification:
- [ ] Disk usage in `bufferDir` stabilizes (doesn't grow unbounded) over a
      30+ minute live stream on staging
- [ ] Stopping the stream stops the cleanup timer (no orphaned intervals —
      verify via a memory/handle check after repeated start/stop cycles)

---

## Phase 3: Serial Highlight Signal Ingestion

### Overview

Read the ESP32's USB serial output, recognize the new `HIGHLIGHT` packet type
(alongside the existing `TENNIS`/`AMER`/`HEARTBEAT` types this listener
should otherwise ignore), and timestamp receipt.

**Reordering note:** because enablement is now ESP32-presence-driven (Phase 1
§3), the presence-detection slice of this phase — opening the device and
exposing `isDevicePresent()` — is a **prerequisite of the buffer actually
turning on automatically**, so it lands before the buffer's env scaffold is
removed. The `HIGHLIGHT`-packet handling (the button press itself) is only
needed once Phase 4 consumes it, so it can still follow Phases 1–2; only the
presence detector is pulled forward.

### Changes Required

#### 1. Dependency

**File**: `package.json`
**Changes**: Add `serialport` (the standard, actively maintained Node serial
library).

#### 2. Config additions

**File**: `src/infrastructure/config/Config.ts`
**Changes**:
```ts
highlight: {
  // ...Phase 2 fields...
  serialPortPath: string;   // HIGHLIGHT_SERIAL_PORT, e.g. "/dev/ttyUSB0" or "auto"
  serialBaudRate: number;   // HIGHLIGHT_SERIAL_BAUD, default 115200
}
```
`"auto"` triggers device auto-discovery (via `serialport`'s
`SerialPort.list()`, matching a known vendor/product ID once the hardware
team confirms it) rather than a hardcoded path, since USB enumeration order
on Ubuntu is not guaranteed stable across reboots.

#### 3. SerialHighlightListener (new)

**File**: `src/infrastructure/services/SerialHighlightListener.ts`
**Changes**:

```ts
export class SerialHighlightListener extends EventEmitter {
  // Opens the serial port (or auto-discovers it), reads newline-delimited
  // lines, and parses the existing pipe-delimited protocol. Emits
  // "highlight" with { receivedAtMs } only for the HIGHLIGHT packet type;
  // TENNIS/AMER/HEARTBEAT lines are logged at debug level and otherwise
  // ignored (score data continues to flow via Supabase, unchanged).
  public start(): void { /* ... */ }
  public stop(): void { /* ... */ }

  // Presence detection — drives automatic enablement of the highlight buffer
  // (Phase 1 §3). "Present" = the known device's port is open AND recognized
  // serial traffic (any valid pipe-delimited packet, incl. HEARTBEAT|ESP32
  // every 5s) was seen within a freshness window (e.g. last 15s = 3 missed
  // heartbeats). Tracks lastTrafficAtMs on every parsed line. Returns false
  // when no ESP32 is attached, so that box never runs the buffer.
  //
  // NOT a poll, and NOT a CPU concern: the heartbeat is PUSHED by the ESP32;
  // we passively receive ~16 bytes/5s via the event-driven serial 'data'
  // handler and update a timestamp. isDevicePresent() is an O(1) compare run
  // only at stream start, never on a timer. The only real CPU cost in this
  // feature is the second encode (the buffer), not this.
  //
  // Requires NO ESP32 firmware change: esp32-leader.ino already emits
  // `HEARTBEAT|ESP32` every 5s over USB serial. (The separate HIGHLIGHT button
  // packet — the trigger, not presence — is the only firmware/hardware task,
  // owned by the hardware team.)
  public isDevicePresent(): boolean { /* ... */ }
}
```

Reconnection behavior mirrors `NodeSSEService`'s pattern
(`src/infrastructure/services/NodeSSEService.ts:352-381`): on port error/close,
log the disconnection and retry opening the port with backoff, so an
unplugged/replugged USB cable recovers without a full app restart.

**Buffer-gate rewire (completes Phase 1 §3's enablement):** once this listener
exists, `StartStreamUseCase` gates the buffer on
`highlightSignalSource.isDevicePresent() && !config.highlight.killSwitch`
instead of the interim `config.highlight.enabled` env check. Timing edge case:
if a stream starts in the first seconds after boot before any heartbeat has
arrived, treat a successfully-opened known device as present (port-open on the
matched vendor/product id), so a live-from-boot court still buffers rather than
waiting up to 5s for the first heartbeat — the heartbeat freshness check then
governs ongoing/reconnect liveness. A stream already running when the device is
unplugged keeps its buffer branch until its next (re)start, since the branch is
fixed at ffmpeg-launch time; this is acceptable (unplugging mid-match is not an
expected operation).

#### 4. Manual test trigger (unblocks testing before hardware exists)

**File**: `src/infrastructure/services/SerialHighlightListener.ts` (same file)
**Changes**: Also accept a `HIGHLIGHT` line typed directly into the serial
monitor (or, if no hardware is attached yet, expose a debug-only local HTTP
endpoint or CLI signal — e.g. `pm2 trigger <app> highlight` via a PM2 custom
action, or a `SIGUSR1`-style process signal) so Phases 4–6 can be fully tested
end-to-end before the firmware change lands.

### Success Criteria

#### Automated Verification:
- [ ] `npx tsc --noEmit` passes
- [ ] Unit test: parser correctly extracts a `HIGHLIGHT` event and ignores
      `TENNIS|...`/`AMER|...`/`HEARTBEAT|...` lines
- [ ] Unit test: partial/split lines across two serial reads are reassembled
      correctly (mirrors the SSE buffer-boundary handling already tested
      conceptually in `NodeSSEService.parseSSEEvents`)

#### Manual Verification:
- [ ] Plugging in the real ESP32 and sending a manual `HIGHLIGHT` line (via
      Arduino Serial Monitor debug keystroke, once the firmware supports it,
      or a temporary test packet) triggers the event
- [ ] Unplugging and replugging the USB cable recovers without restarting the
      Node process
- [ ] The manual test trigger (no hardware required) reliably fires the same
      code path

---

## Phase 4: Highlight Window Extraction

### Overview

Turn a highlight signal into a precise, raw (no overlays) MP4 clip covering
`[estimatedEventTime - preRollSec, estimatedEventTime + postRollSec]`, waiting
as needed for the post-roll footage to actually exist in the buffer.

### Changes Required

#### 1. Domain types

**File**: `src/domain/events/HighlightEvent.ts` (new)
**Changes**: Following the existing `DomainEvent` pattern
(`src/domain/events/StreamEvent.ts:8-12`):
```ts
export interface HighlightSignalReceivedEvent extends DomainEvent {
  readonly eventType: "HighlightSignalReceived";
  readonly courtId: string;
  readonly receivedAtMs: number;
}
export interface HighlightCapturedEvent extends DomainEvent { /* courtId, clipPath, windowStartMs, windowEndMs */ }
export interface HighlightFailedEvent extends DomainEvent { /* courtId, reason */ }
```

#### 2. CaptureHighlightUseCase (new)

**File**: `src/application/use-cases/CaptureHighlightUseCase.ts`
**Changes**:
```ts
export class CaptureHighlightUseCase {
  public async execute(request: { courtId: string; receivedAtMs: number }): Promise<void> {
    const estimatedEventMs = request.receivedAtMs - this.config.highlight.lagMarginSec * 1000;
    const windowStartMs = estimatedEventMs - this.config.highlight.preRollSec * 1000;
    const windowEndMs = estimatedEventMs + this.config.highlight.postRollSec * 1000;

    // The post-roll tail may not exist yet — wait until it does, plus a
    // small safety margin for the segmenter to flush its current segment.
    await this.waitUntil(windowEndMs + SEGMENT_FLUSH_SAFETY_MS);

    const segments = this.bufferRegistry.get(request.courtId)?.getSegmentsInWindow(windowStartMs, windowEndMs);
    if (!segments) {
      this.logger.warn("Highlight extraction failed: insufficient buffer history", { courtId: request.courtId });
      return; // logs a HighlightFailedEvent-shaped record
    }

    const rawClipPath = await this.extractor.extractWindow(segments, windowStartMs, windowEndMs, request.courtId);
    await this.processor.execute(rawClipPath, request.courtId); // Phase 5/6
  }
}
```

#### 3. HighlightExtractorService (new)

**File**: `src/infrastructure/services/HighlightExtractorService.ts`
**Changes**: Two-step concat-then-trim, mirroring
`AdDownloaderService.concatClips`/`normalizeClip`
(`AdDownloaderService.ts:381-427`): concat the overlapping `.ts` segments via
`-f concat -c copy`, then trim precisely to the target window with
`-ss`/`-to` (re-encode only if the segment boundaries don't land on a
keyframe; otherwise stream-copy the trim too). All writes go through the
existing temp-file-then-rename pattern.

### Success Criteria

#### Automated Verification:
- [ ] `npx tsc --noEmit` passes
- [ ] Unit test: window math (`estimatedEventMs`, `windowStartMs`,
      `windowEndMs`) is correct given a fixed `receivedAtMs`/config
- [ ] Unit test: "insufficient buffer history" path is hit and logged when
      requested segments don't exist (e.g. signal arrives <30s into a stream)
- [ ] Integration test: given a set of fake segment files with known
      timestamps, extraction produces a clip of the expected duration

#### Manual Verification:
- [ ] Triggering a highlight (real or manual test trigger from Phase 3)
      produces a raw clip whose duration matches `preRollSec + postRollSec`
      and visually contains the expected moment
- [ ] Triggering a highlight within the first 30s of a stream start fails
      gracefully with a clear log line, does not crash the app

---

## Phase 5: Ball-Tracking Prototype, Dynamic Reframe & Logo Overlay

### Overview

Analyze the raw extracted clip offline to produce a ball-following crop path;
render the final clip in one ffmpeg pass that applies the dynamic crop and
overlays the DropShot/client logos on the resulting canvas. Gated by a
validation spike so a bad tracking day never blocks highlight delivery.

### Changes Required

#### 1. Ball-tracking prototype spike (research, not shipped code)

Before writing `BallTracker`'s real implementation: prototype a classical CV
approach (frame differencing + small-moving-blob detection, tuned for a
high-contrast fast-moving ball against a padel court) against a handful of
real recorded clips. Bounded effort — if detection quality doesn't clear a
usable bar (ball found and tracked for a meaningful fraction of the clip,
low false-positive rate), ship with `highlight.ballTracking.enabled = false`
(the static fallback below) and revisit as a follow-up phase with more time
or a small ML model.

#### 2. Domain interfaces

**File**: `src/domain/services/BallTracker.ts` (new)
**Changes**:
```ts
export interface CropBox { atSec: number; x: number; y: number; w: number; h: number }
export interface CropPath { targetWidth: number; targetHeight: number; boxes: CropBox[] }

export interface BallTracker {
  // Returns null when tracking fails/is disabled — callers must handle the
  // fallback themselves, never assume a CropPath is available.
  analyze(clipPath: string): Promise<CropPath | null>;
}
```

#### 3. Implementations

**File**: `src/infrastructure/services/ClassicalBallTracker.ts` (new, real
implementation, only wired in if the Phase 5.1 spike clears the bar)
**File**: `src/infrastructure/services/NullBallTracker.ts` (new, returns
`null` unconditionally — the default while `ballTracking.enabled = false`)

**Language/runtime choice:** the actual detection runs in **Python +
OpenCV** (`opencv-python`), not Node. Node's OpenCV bindings are poorly
maintained and painful to build on Ubuntu boxes, whereas Python's OpenCV is
the mature, well-documented toolchain for this kind of classical CV (frame
differencing, blob/contour detection, Hough circles for a small fast-moving
ball). This is **not a running server** — since tracking is offline/batch
with no live-latency pressure, `ClassicalBallTracker.analyze(clipPath)`
follows the exact same one-shot-subprocess pattern already established for
`ffmpeg` calls (`AdDownloaderService.runFfmpegToFile`):

```ts
export class ClassicalBallTracker implements BallTracker {
  public async analyze(clipPath: string): Promise<CropPath | null> {
    // spawn("python3", ["scripts/track_ball.py", "--input", clipPath, "--output", tmpJsonPath])
    // wait for exit (with a timeout, mirroring clipTimeoutMs), read + parse tmpJsonPath,
    // return null on any non-zero exit / timeout / malformed output — never throws
  }
}
```

The Python script (`scripts/track_ball.py`) is a standalone one-shot tool: it
takes a clip path, does the CV work, writes a small JSON crop-path (`{atSec,
x, y, w, h}` entries) to the given output path, and exits — nothing stays
running in the background. Requires `python3` + `opencv-python` provisioned
via `setup.sh` (same category as the existing `ffmpeg` install step).

The crop path from a real tracker is smoothed/clamped (max pan velocity, e.g.
via a moving average over `atSec`) before being handed to the renderer, so
the final crop pans rather than jitters; any span with low detection
confidence falls back to holding the previous stable box rather than
snapping. This smoothing/clamping can live in either language; keeping it in
the Python script (emitting an already-smoothed crop path) is simplest since
frame-level data never needs to cross the process boundary.

#### 4. HighlightRendererService (new)

**File**: `src/infrastructure/services/HighlightRendererService.ts`
**Changes**: Single ffmpeg pass, applying (a) a time-varying `crop` filter
driven by the `CropPath` (ffmpeg supports `crop=w:h:x='<expr in t>':y='<expr in t>'`)
or, when `cropPath` is `null`, a no-op full-frame pass; then (b) overlaying
DropShot + client logos sized against `targetWidth`/`targetHeight` (the final
canvas), reusing the same `scale=W:H:force_original_aspect_ratio=decrease`
bounding-box technique from `NodeFFmpegService.buildStreamCommand` but with
fresh coordinates for the new canvas — **not** the live-stream geometry from
`bounding-box-sizing.md`, since the canvas is different.

```ts
export class HighlightRendererService {
  public async render(rawClipPath: string, cropPath: CropPath | null, courtId: string): Promise<string> {
    // one ffmpeg invocation: [crop or passthrough] -> [overlay ds logo] -> [overlay client logo] -> output
  }
}
```

#### 5. Wire into CaptureHighlightUseCase

**File**: `src/application/use-cases/CaptureHighlightUseCase.ts`
**Changes**: After `extractor.extractWindow`, call
`ballTracker.analyze(rawClipPath)` (catching and logging any error —
tracking failure must never abort the highlight), then
`renderer.render(rawClipPath, cropPathOrNull, courtId)`, writing the final
file to `highlight.outputDir` and logging a `HighlightCapturedEvent`.

### Success Criteria

#### Automated Verification:
- [ ] `npx tsc --noEmit` passes
- [ ] Unit test: `HighlightRendererService` produces correct ffmpeg args for
      both the `cropPath = null` (full-frame) and populated-crop-path cases
- [ ] Unit test: crop-path smoothing clamps pan velocity as expected given a
      synthetic jittery input

#### Manual Verification:
- [ ] With `ballTracking.enabled = false`: triggering a highlight produces a
      full-frame clip with correctly positioned logos
- [ ] If the Phase 5.1 spike clears the bar and `ballTracking.enabled = true`:
      triggering a highlight during a rally produces a clip that visibly pans
      toward the ball's on-court position, with logos correctly placed on the
      new (likely different-aspect) canvas
- [ ] A clip with no reliable ball detection (e.g. ball off-frame for the
      whole window) falls back to a stable frame rather than a jittery/broken
      crop

---

## Phase 6: Lifecycle Wiring, Config, and End-to-End Logging

### Overview

Tie every prior phase's services into `main.ts`/`StreamManagerService`
start/stop/shutdown, and ensure the ESP32 → streamer → data trail is fully
traceable via the existing `RemoteLogger`.

### Changes Required

#### 1. main.ts

**File**: `src/main.ts`
**Changes**: Instantiate `SerialHighlightListener`, `HighlightBufferRegistry`,
and `CaptureHighlightUseCase` alongside the existing services (mirrors the
`SupabaseListener`/`adRotationRegistry` construction already at lines 21,
69-88). Start `SerialHighlightListener` once at app start (not per-stream —
it's tied to the physical USB device, not a specific stream). On a
`"highlight"` event, look up the currently running stream via
`streamRepository.findRunning()` (matches the one-box-one-court assumption)
and invoke `captureHighlightUseCase.execute`.

#### 2. Graceful shutdown

**File**: `src/main.ts` (`setupGracefulShutdown`)
**Changes**: Stop `SerialHighlightListener` and all `HighlightBufferRegistry`
entries alongside the existing `adRotationRegistry.stopAll()`/
`supabaseListener.stop()` calls.

#### 3. Structured logging

**File**: `src/application/use-cases/CaptureHighlightUseCase.ts` (and each
service it calls)
**Changes**: Every stage logs via the existing `RemoteLogger`
(`src/infrastructure/logging/RemoteLogger.ts`, already used everywhere else)
with a consistent `courtId` + stage field, so the full trail —
`HighlightSignalReceived` → extraction started/failed → ball-tracking
attempted/skipped → clip written/failed, with paths and window timestamps —
is reconstructible from logs alone. No new logging system needed.

### Success Criteria

#### Automated Verification:
- [ ] `npx tsc --noEmit` passes for the full project
- [ ] Full unit test suite (all phases) passes

#### Manual Verification:
- [ ] End-to-end: real or manual-trigger highlight signal during a live
      stream produces a logo-overlaid clip in `highlight.outputDir`, with a
      complete, readable log trail from signal receipt to file write
- [ ] Restarting the app (simulating a crash) does not leave orphaned buffer
      cleanup timers or serial port handles
- [ ] A full shutdown/restart cycle with a highlight mid-processing either
      completes cleanly or fails with a clear logged reason — never a silent
      drop
- [ ] Live YouTube stream health (bitrate, PID stability, no stall-detection
      restarts) is unaffected across a full test run that includes several
      highlight triggers

---

## Testing Strategy

### Unit Tests:
- Window math (pre-roll/post-roll/lag-margin arithmetic)
- Serial packet parsing (including split-line reassembly)
- Segment manifest window-overlap queries and retention cleanup
- Crop-path smoothing/clamping
- Renderer ffmpeg argument construction (both crop and no-crop paths)
- `buildStreamCommand`'s buffer-branch args (present/absent cases)

### Integration Tests:
- Fake segment files with known timestamps → correct extraction
- End-to-end `CaptureHighlightUseCase.execute` with fake buffer/tracker/renderer
  doubles, asserting the full call sequence and failure paths (insufficient
  history, tracking failure, render failure)

### Manual Testing Steps:
1. Push Phase 1 to staging; confirm the live stream works unchanged with the
   buffer branch enabled, and check CPU/memory headroom under `pm2 monit`.
2. Run a live stream for 5+ minutes; confirm buffer disk usage stabilizes and
   segments are valid (Phase 2).
3. Use the manual test trigger (no ESP32 required) to fire a highlight
   mid-stream; confirm a correctly-windowed, logo-overlaid clip appears
   (Phases 3–6, sans real hardware).
4. Once firmware exists: physically press the highlight button during a real
   match; confirm the same end-to-end result, and use it to calibrate
   `lagMarginSec` against observed real-world signal delay.
5. Stress test: trigger several highlights in quick succession; confirm no
   crashes, no orphaned processes, and the live stream is never affected.

## Performance Considerations

- The buffer branch requires a second, continuous x264 encode running inside
  the same process as the live encoder — this is a real CPU cost, deliberately
  minimized (low resolution, `ultrafast` preset, no audio) but must be
  validated on real hardware via staging (Phase 1's manual verification), not
  assumed free.
- Highlight rendering (Phase 5) is a one-shot, bounded-duration ffmpeg job
  (~30s of footage), not a long-running process — capped concurrency (mirror
  `AdDownloaderService`'s `clipConcurrency` pattern) prevents multiple
  simultaneous highlight renders from starving the live encoder.
- Ball-tracking analysis is offline/batch with no latency budget, but should
  still have a timeout (mirrors `AdDownloaderService`'s `clipTimeoutMs`
  pattern) so a pathological clip can't hang the pipeline indefinitely.
- Disk usage: the rolling buffer is bounded by `bufferRetentionSec` and
  cleaned continuously; finished highlight clips in `outputDir` are not
  automatically pruned by this plan (that's a retention-policy decision that
  belongs with the out-of-scope delivery/upload work).

## Migration Notes

Not applicable — this is a net-new feature with no existing data/behavior to
migrate. It ships dark by default: normal enablement is ESP32-presence-driven
(a box with no highlight hardware never runs the buffer), and
`highlight.ballTracking.enabled = false` keeps tracking off until validated.
During bring-up the interim `HIGHLIGHT_ENABLED` env scaffold keeps the buffer
off until deliberately flipped on for a test box.

### Rollout

1. Ship Phase 1 first and run it on staging via the interim `HIGHLIGHT_ENABLED`
   scaffold (no hardware needed yet) to validate zero impact on the live
   stream — the cheapest, highest-value thing to prove before building
   anything on top of it.
2. Ship Phase 2 and confirm retention/disk behavior over a real multi-hour
   stream.
3. Build the Phase 3 presence detector and rewire enablement to
   `isDevicePresent()` (retiring the env scaffold); confirm a box auto-enables
   the buffer when the ESP32 is plugged in and stays off when it isn't. Then
   ship the rest of Phases 3–4 with the manual test trigger; validate
   extraction correctness without needing a real button press.
4. Run the Phase 5.1 ball-tracking spike; decide `ballTracking.enabled` based
   on its result.
5. Ship Phase 5–6 with `ballTracking.enabled = false` regardless of the spike
   outcome initially; flip it on per-box once satisfied with fallback
   behavior in production.
6. Coordinate the firmware `HIGHLIGHT` packet with Hassan's team in parallel
   with steps 1–4; it only gates real end-to-end testing, not development.

## References

- Live overlay compositing & filter graph: `src/infrastructure/services/NodeFFmpegService.ts:307-483`
- Live-reload file-swap pattern precedent: `src/infrastructure/services/NodeFFmpegService.ts:533-563` (score overlay), `src/infrastructure/services/AdRotator.ts` (ad slots)
- Separate one-shot ffmpeg pipeline precedent: `src/infrastructure/services/AdDownloaderService.ts`
- Per-court auxiliary lifecycle registry precedent: `AdRotationRegistry`, wired in `src/application/use-cases/StartStreamUseCase.ts:266-321`
- Stream lifecycle orchestration: `src/application/services/StreamManagerService.ts`
- Overlay pixel-geometry reference (live stream only, not reused for highlights): `docs/plans/bounding-box-sizing.md`
- Hardware pipeline source: `github.com/DropShot-Live/arduino-scoreboard`, `github.com/DropShot-Live/esp8266`, `github.com/DropShot-Live/esp32-leader`
