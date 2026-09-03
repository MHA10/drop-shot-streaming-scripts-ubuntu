# Overlay Sizing and Ad Repositioning Plan

Status: Proposed
Last updated: 2026-04-18

## Summary

Two coupled changes to `NodeFFmpegService.buildStreamCommand`:

1. **Bounding-box sizing** for client logo, DropShot logo, and ad — caps both width and height so overlays have consistent visual weight across courts with different logo aspect ratios.
2. **Move the ad overlay** from the bottom-left corner to the right-vertical slot (between the client logo and the DropShot logo) — safer dead zone across both Padel Central and Padel Bridge.

---

## Part 1 — Bounding-box sizing

### Problem

ffmpeg overlays are currently sized with fixed **width** and free **height** (`scale=W:-1:force_original_aspect_ratio=decrease`). Because source logos have different aspect ratios per court, rendered height varies widely.

| Court | Source logo | After `scale=350:-1` | Rendered height |
|---|---|---|---|
| Padel Central | 1310×588 (2.23:1) | 350×157 | 157 px |
| Padel Bridge | 634×468 (1.35:1) | 350×258 | **258 px (65% taller)** |

On Padel Bridge this pushes the top-right overlay far down into the court area.

### Proposal

Switch to **bounded-box scaling** — specify both width and height; `force_original_aspect_ratio=decrease` fits the image inside the box while preserving its aspect ratio. Produces equal-height overlays across every court and prevents pathological aspect ratios from sprawling.

### Budgets

| Overlay | Current | Proposed | Slot |
|---|---|---|---|
| Client logo | `scale=350:-1` | `scale=400:140:force_original_aspect_ratio=decrease` | Top-right |
| DropShot logo | `scale=500:-1` | `scale=500:140:force_original_aspect_ratio=decrease` | Bottom-right |
| Ad overlay | `scale=400:-1` | `scale=220:500:force_original_aspect_ratio=decrease` | Right-vertical (see Part 2) |
| Score overlay | `scale=420:-1` | unchanged | Top-left, generated in-process |

### Expected visual impact on logos

| Court | Client logo current | Client logo proposed | Delta |
|---|---|---|---|
| Padel Central | 350×157 | 312×140 | −11% height (barely noticeable) |
| Padel Bridge | 350×258 | 190×140 | −46% height, −46% width (significant shrink) |

If Padel Bridge stakeholders prefer a larger presence, raise the client-logo cap to 400×200 (gives 271×200 on Padel Bridge — smaller than today but closer).

---

## Part 2 — Ad repositioning (right-vertical slot)

### Problem

Current ad position is bottom-left (`overlay=10:main_h-overlay_h-10`). This is:
- **Risky on Padel Central** — players retreating to the baseline drift into this zone and get covered by the ad.
- **Safe on Padel Bridge** — but the right-vertical slot is equally safe and gives a more prominent placement.

### Proposal

Move the ad to the vertical strip on the right side, between the client logo (top-right) and the DropShot logo (bottom-right). Confirmed dead zone on both courts:
- Padel Central: wall / fan / fence with adjacent court (distant activity)
- Padel Bridge: wall between the two right-side logos

### Slot geometry (in 1920×1080 output space)

- Client logo ends at ~y=150 (top-right, 10 px padding + 140 height)
- DropShot logo starts at ~y=930 (bottom-right, 140 height, 10 px padding)
- **Usable vertical gap**: y ∈ [180, 900], ~720 px tall

### Proposed ad dimensions and position

- Bounding box: **220 × 500** (narrow vertical ads render well; square/landscape ads will center inside the box)
- Position: `overlay=main_w-overlay_w-10:(main_h-overlay_h)/2` — right-aligned with 10 px padding, vertically centered in the frame

### Aspect ratio behavior

| Ad source | After `scale=220:500:force_original_aspect_ratio=decrease` |
|---|---|
| 1:1 square (current Shrek) | 220 × 220 (fills width, not height) |
| Tall portrait (2:5, e.g., 400×1000) | 200 × 500 (fills height) |
| Landscape (2:1, e.g., 800×400) | 220 × 110 (fills width) |

Tall portrait creative fills the slot best. Landscape ads look small. Document this in client-side guidelines.

---

## Implementation

### Scope
Single file: `src/infrastructure/services/NodeFFmpegService.ts` — `buildStreamCommand` method.
Both branches (`isScorecardActivated` true/false) need the edits.

### Steps

1. In each branch, update the four filter lines that feed into overlays:
   - Client: `scale=350:-1:force_original_aspect_ratio=decrease` → `scale=400:140:force_original_aspect_ratio=decrease`
   - DropShot: `scale=500:-1:force_original_aspect_ratio=decrease` → `scale=500:140:force_original_aspect_ratio=decrease`
   - Ad: `scale=400:-1:force_original_aspect_ratio=decrease` → `scale=220:500:force_original_aspect_ratio=decrease`
   - Score: unchanged
2. Change the ad overlay position expression:
   - `overlay=10:main_h-overlay_h-10` → `overlay=main_w-overlay_w-10:(main_h-overlay_h)/2`
3. Run `npx tsc --noEmit`.
4. Push to a feature branch, deploy to staging, restart PM2.
5. Verify on each court via YouTube stream:
   - Logos equal height (Padel Central ≈ Padel Bridge).
   - Ad appears right-center, does not cover the court or the other two right-side logos.
   - No CPU regression in `pm2 monit`.

### Risks and mitigations

| Risk | Mitigation |
|---|---|
| Padel Bridge client perceives smaller logo as a downgrade | Stakeholder preview of before/after; offer 400×200 cap as middle-ground |
| Ad at right-vertical covers a camera-specific active area on some future court | Document the right-vertical slot assumption; inspect any new court camera view before onboarding |
| Ad aspect poorly suited to 220×500 box (e.g., wide banner) | Surface the rendered dimension on upload; reject at intake if too extreme |

### Verification checklist

- [ ] `"Command full form"` log shows the new scale filters and the new ad overlay position
- [ ] Padel Central client logo appears nearly identical
- [ ] Padel Bridge client logo appears noticeably smaller but proportional
- [ ] Ad appears right-center between the two right-side logos
- [ ] Ad does not cover the court or other overlays
- [ ] No CPU spike in `pm2 monit`

---

## Client-side upload guidelines

Concerns the platform side (admin UI / API that accepts client logo and ad uploads), not the streamer runtime.

### Hard validations (reject at upload)

| Rule | Reason |
|---|---|
| Format: PNG with alpha channel | JPEG has no transparency — renders as a white box over the video |
| Logo min dimensions: 400 × 140 | Below the bounding box, overlay would be upscaled — blurry |
| Ad min dimensions: 220 × 500 | Same reason; minimum matches the new ad bounding box |
| Max file size: 2 MB | Anything larger is wasted; the streamer downscales aggressively |
| Aspect ratio between 1:5 and 5:1 | Beyond this, the bounded render is unreadably thin |

### Soft recommendations (warn, don't block)

| Suggestion | Benefit |
|---|---|
| Upload logo at 2× the box (800 × 280) | Crisp on 4K viewers, still fits the box |
| Upload ad at 2× the box (440 × 1000 portrait) | Portrait aspect fills the right-vertical slot best |
| Transparent background | Floats cleanly over the video |
| Keep content within inner 80% of canvas (safe area) | Prevents edge-clipping |
| No text smaller than ~16 px in final render | Unreadable at stream resolution otherwise |
| sRGB colour profile | Avoids colour shifts during ffmpeg re-encode |

### UX / backend process

1. **Live preview at final size.** Show a sample court screenshot with the user's logo/ad overlaid at the actual rendered size. Sets expectations before the stream goes live.
2. **Rendered dimension callout.** "Your 1200×300 logo will render at 400×100 (height-capped) on stream." Avoids surprises.
3. **Normalization pipeline on upload.**
   - Strip EXIF/metadata
   - Convert to PNG if needed
   - Pre-resize to max 800×280 (logo) / 440×1000 (ad)
   - Flatten to sRGB
   - Reject if no alpha channel
4. **Admin override.** Bypass soft validations for intentionally unusual assets.

### Suggested libraries

- `sharp` — Node image resize/format conversion
- `exifr` or `sharp`'s metadata API — strip EXIF
- Frontend: `react-image-crop` or similar for a "show me what it'll look like" preview

---

## Open questions

- Raise client-logo cap to 400×200 to soften Padel Bridge's visual downgrade?
- Per-court logo budgets (Padel Bridge keeps 400×200, others use 400×140)? Only if visual consistency matters less than historical presence.
- Store both original and normalized versions on upload? Useful for rollback if normalization has a bug.
- Future: right-vertical slot supports only one ad — do we eventually want carousel rotation (e.g., 3 ads × 20 s each)?

## Decision log

_(to be filled in as decisions are made)_
