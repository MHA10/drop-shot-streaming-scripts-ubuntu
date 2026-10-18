/**
 * Camera URL helpers for the near-live stats reader.
 *
 * ── IN SIMPLE WORDS ──
 * Court cameras send two streams: the HD one we broadcast, and a small low-res
 * copy. The stats reader only needs to see where players stand, so it reads
 * the small copy — far cheaper on the box's CPU, which the live broadcast
 * needs. The backend only gives us the HD address, so we work out the low-res
 * address from it for the two camera brands we have on courts.
 *
 * ── BUSINESS RULES ──
 * - Hikvision: /Streaming/Channels/101 is channel 1 HD, .../102 its low-res
 *   copy (201/202 for channel 2, and so on).
 * - Dahua: /cam/realmonitor?channel=1&subtype=0 is HD, subtype=1 low-res.
 * - Anything else → null: we don't guess a URL for a camera we don't know.
 *
 * ── DO NOT ──
 * - Do NOT log a camera URL without maskCameraUrl — it carries the camera
 *   password.
 */

const HIKVISION = /(\/Streaming\/Channels\/)(\d*)0[12](?=$|[/?#])/i;

/** The camera's low-res stream URL, or null when the brand isn't recognised. */
export function toSubstreamUrl(cameraUrl: string): string | null {
  if (HIKVISION.test(cameraUrl)) {
    return cameraUrl.replace(HIKVISION, (_m, base, ch) => `${base}${ch}02`);
  }
  if (/\/cam\/realmonitor\?/i.test(cameraUrl)) {
    if (/([?&])subtype=\d+/i.test(cameraUrl)) {
      return cameraUrl.replace(/([?&])subtype=\d+/i, "$1subtype=1");
    }
    return `${cameraUrl}&subtype=1`;
  }
  return null;
}

/** Hide the user:password part of any URLs inside `text` (safe to log). */
export function maskCameraUrl(text: string): string {
  return text.replace(/(\w+:\/\/)[^\s/@:]*:[^\s/@]*@/g, "$1***:***@");
}
