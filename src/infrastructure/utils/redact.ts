import { maskCameraUrl } from "./cameraSubstream";

/**
 * Hide secrets in anything about to be logged.
 *
 * ── IN SIMPLE WORDS ──
 * Logs are printed on the box AND shipped to the remote log server, so a
 * secret in a log line is a secret handed to anyone who can read logs. This
 * blanks the secrets the streamer handles: the camera's login (inside its
 * rtsp:// address), the booking's YouTube stream key (anyone holding it can
 * broadcast to the venue's channel), and any setting named like a key,
 * secret, token or password (the box's API key, the Cloudinary secret…).
 *
 * ── BUSINESS RULES ──
 * - Camera address user:password → "***:***" (cameraSubstream.maskCameraUrl),
 *   also the scheme-less "user:pass@10.0.0.5" a parse error can quote.
 * - Stream key: the last path part of an rtmp(s):// address (where YouTube's
 *   key goes, see NodeFFmpegService) when it is key-length, and any
 *   "streamKey" field → "***" + the last 4 characters (all hidden if short),
 *   so two log lines can still be matched up.
 * - Any metadata field whose NAME ends in key/secret/token/password → hidden
 *   the same way. The boot log prints the whole config (main.ts), which holds
 *   the box API key — the key that opens the backend's event feed, which in
 *   turn carries every booking's camera address and stream key.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - It runs inside the logger (RemoteLogger), not at each call site: the
 *   leaks found 2026-10-20 were in existing log calls (start/stop event logs,
 *   the raw SSE event, the full ffmpeg command, the config dump), and the
 *   next new log call would leak again if each one had to remember.
 * - Metadata is cleaned VALUE BY VALUE, not as one JSON text. In JSON text a
 *   quote inside a password is escaped (\"), and a pattern that has to stop
 *   at field boundaries then never reaches the "@" — the password is printed
 *   in full (review 2026-10-20). Each value on its own is plain text, so the
 *   wide pattern is safe, and a mask that over-reaches only hides more.
 * - It goes through JSON once (so objects log exactly as JSON.stringify
 *   shows them, toJSON included) and ALWAYS hands back that copy, never the
 *   caller's object: remote logs are batched and only turned into text when
 *   sent (up to batchInterval later), so a caller changing its object after
 *   logging would otherwise ship something nobody checked.
 * - Every pattern has a fixed start and bounded parts: it runs on every log
 *   line next to the live stream, and an open-ended pattern on a long odd
 *   value (e.g. backend SSE data) can take time growing with the square of
 *   its length.
 *
 * ── DO NOT ──
 * - Do NOT log a secret in a shape these rules can't see: a password alone
 *   in a field not named like one, or a URL that carries the stream key in
 *   an https path (the go-live call in HttpClient does — never log it).
 */

// The URL ends at whitespace, quotes or a comma (ffmpeg args may be joined
// with commas), so the "last path part" is the key, not a later argument.
const RTMP_KEY = /(rtmps?:\/\/[^\s"'\\,]+\/)([^\s"'\\,/?#]{12,})/gi;
// "streamKey":"…" inside a string value that is itself JSON text (the raw
// SSE event is logged as one), escaped or not.
const STREAM_KEY_FIELD = /(\\?["']streamKey\\?["']\s*:\s*\\?["'])([^"'\\]+)/g;
// user:pass@<ip> with no scheme in front (e.g. quoted by a JSON parse error).
// Password part may hold "@" (to the last one before the IP); lengths capped.
const BARE_CREDENTIALS = /(?<![\w.-])[\w.-]{1,64}:[^\s/]{1,128}@(?=\d{1,3}\.\d)/g;
const SECRET_NAME = /(key|secret|token|password|passwd|pwd)$/i;
const SECRET_NAME_IN_JSON = /"[^"]*(key|secret|token|password|passwd|pwd)"\s*:/i;
const MIGHT_HOLD_SECRET = /:\/\/|streamKey|@\d{1,3}\.\d/i;

function hideKey(key: string): string {
  if (key === "") return "(empty)"; // an unset key must stay visible in the boot log
  return key.length > 8 ? `***${key.slice(-4)}` : "***";
}

/** The text with camera passwords and stream keys hidden. */
export function redactText(text: string): string {
  if (!MIGHT_HOLD_SECRET.test(text)) return text;
  return maskCameraUrl(text)
    .replace(BARE_CREDENTIALS, "***:***@")
    .replace(RTMP_KEY, (_m, head: string, key: string) => head + hideKey(key))
    .replace(STREAM_KEY_FIELD, (_m, head: string, key: string) => head + hideKey(key));
}

function cleanValue(value: unknown, name?: string): unknown {
  if (typeof value === "string") {
    return name && SECRET_NAME.test(name) ? hideKey(value) : redactText(value);
  }
  if (Array.isArray(value)) return value.map((v) => cleanValue(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = cleanValue(v, k);
    return out;
  }
  return value;
}

/** A log call's message and metadata with secrets hidden. Never throws. */
export function redactLog(message: string, meta?: unknown): { message: string; meta?: unknown } {
  const clean = { message: redactText(message), meta };
  if (meta === undefined || meta === null) return clean;
  if (typeof meta === "string") return { ...clean, meta: redactText(meta) };
  try {
    const json = JSON.stringify(meta);
    if (json === undefined) return clean;
    const copy = JSON.parse(json); // never the caller's object (header)
    if (!MIGHT_HOLD_SECRET.test(json) && !SECRET_NAME_IN_JSON.test(json)) return { ...clean, meta: copy };
    return { ...clean, meta: cleanValue(copy) };
  } catch {
    // Not JSON-able (e.g. circular): don't log it at all rather than risk a secret.
    return { ...clean, meta: "[metadata not loggable]" };
  }
}
