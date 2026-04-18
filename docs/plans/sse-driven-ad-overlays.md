# SSE-Driven Ad Overlays (Left + Right)

Status: Proposed
Last updated: 2026-04-18

## Goal

Replace the static `./ad/ad.gif` overlay with ads delivered per court via SSE `start` events:

```json
"ads": {
  "left":  "https://res.cloudinary.com/.../left-banner.png",
  "right": "https://res.cloudinary.com/.../right-banner.mp4"
}
```

Each URL can be any of: PNG, JPG, GIF, MP4. Either field may be absent or null. Missing field ⇒ skip that slot.

## Visual layout (both slots are safe on Padel Central and Padel Bridge)

| Slot | Position | Bounding box | Input flags |
|---|---|---|---|
| `right` | `overlay=main_w-overlay_w-10:(main_h-overlay_h)/2` | 220×500 | video ⇒ `-stream_loop -1 -re -i` · still ⇒ `-f image2 -loop 1 -i` |
| `left` | `overlay=10:(main_h-overlay_h)/2` | 220×500 | same selection logic as right |

## Files to change

| File | Change |
|---|---|
| `src/domain/events/StreamEvent.ts` | Add `ads?: { left?: string \| null; right?: string \| null }` to `SSEStreamEvent` |
| `src/application/interfaces/StartStreamUseCase.types.ts` | Add the same `ads?` field to `StartStreamRequest` |
| `src/infrastructure/services/NodeSSEService.ts` | Parse `parsedData.ads` and include in the emitted event (near line 287) |
| `src/application/services/StreamManagerService.ts` | Pass `ads` through to the use case (near line 250) |
| `src/application/use-cases/StartStreamUseCase.ts` | Before `startStream`, call the new downloader to resolve left/right to local paths, pass them along |
| `src/domain/services/FFmpegService.ts` | Add `leftAdPath?: string` and `rightAdPath?: string` to `startStream` and `buildStreamCommand` signatures |
| `src/infrastructure/services/NodeFFmpegService.ts` | Accept the paths, remove the static `./ad/ad.gif` detection, extend filter_complex to handle 0/1/2 ads |
| **New** `src/infrastructure/services/AdDownloaderService.ts` | Downloads URL to `./ad/<courtId>-<slot>.<ext>`; caches by URL to avoid redundant refetch |

## Ad downloader

- **Protocol**: Plain HTTPS GET. Cloudinary delivery URLs are public; no signing needed. (If a future URL requires signing, swap in the Cloudinary SDK in this one service without affecting callers.)
- **Filesystem layout**: `./ad/<courtId>-left.<ext>` and `./ad/<courtId>-right.<ext>`. Extension derived from the URL.
- **Cache**: a sidecar file `<path>.url` stores the last-downloaded URL. On subsequent SSE events, if the URL matches the cached sidecar, skip re-download (saves bandwidth + lets ffmpeg pick the existing file).
- **Failure behavior**: any download error ⇒ return `null` for that slot, log a warning, stream continues without the ad rather than failing.

## filter_complex changes

Generalize the existing single-ad branch to handle each side independently:

```
has neither → no ad filter steps, no final [vout] label, no explicit -map (current no-ad behavior)
has left only → overlay=10:(main_h-overlay_h)/2 [vout]
has right only → overlay=main_w-overlay_w-10:(main_h-overlay_h)/2 [vout]
has both → chain them: left first, then right, final [vout]
```

Explicit `-map [vout]` and `-map <audio_input>:a` apply whenever **any** ad is present.

Format detection inside the FFmpeg service:

```ts
const videoExts = new Set(["mp4", "gif", "webm", "mov"]);
const isVideo = videoExts.has(path.extname(adPath).slice(1).toLowerCase());
if (isVideo) {
  args.push("-stream_loop", "-1", "-re", "-i", adPath);
} else {
  args.push("-f", "image2", "-loop", "1", "-i", adPath);
}
```

## What's removed

- The static `./ad/ad.gif` check in `buildStreamCommand` — ads now come only from SSE.
- The `ad/ad.gif` file in git (committed Shrek) — no longer needed. Folder stays (runtime download target).

## Risks

| Risk | Mitigation |
|---|---|
| Cloudinary URL takes longer than 5 s to download on a slow court connection | Downloader has a 10 s timeout; on timeout, skip the ad and stream starts without it |
| URL points to corrupt file; ffmpeg exits at startup | Stall detector + retry logic already handles ffmpeg crashes; the cached `.url` sidecar ensures retry uses the bad URL → to avoid loops, delete cache on ffmpeg failure (optional enhancement) |
| Ad file remains after court changes clients | SSE start event with different URL invalidates the cache automatically |
| Same court starts multiple times with different ads | Each start re-checks URLs; outdated cache gets replaced |

## Verification checklist

- [ ] SSE event with `ads.left` + `ads.right` → both overlays appear on stream, correctly positioned
- [ ] SSE event with `ads.left` only → only left overlay
- [ ] SSE event with `ads.right` only → only right overlay (same visual result as today with Shrek)
- [ ] SSE event without `ads` key → stream runs with no ads, no errors
- [ ] Re-sending same SSE event → does NOT re-download (sidecar cache hit)
- [ ] Changing URL between events → does re-download and ffmpeg picks up the new file
- [ ] MP4, GIF, PNG, JPG — all four tested via separate courts or synthetic events
- [ ] Network failure during download → stream still starts without the failing ad, warning logged

## Out of scope (future)

- Mid-stream ad rotation (requires ffmpeg zmq/socket control; defer)
- Ad impression tracking / analytics
- Per-ad time slots (show ad A for 30 s then ad B)
