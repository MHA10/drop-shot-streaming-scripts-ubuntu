import * as fs from "fs";

/**
 * Filesystem path helpers shared across infrastructure services.
 *
 * ── IN SIMPLE WORDS ──
 * Small, boring helpers for turning untrusted names into safe folder names and
 * for making sure a folder exists. Several services need the exact same two
 * operations, so they live here instead of being copy-pasted.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * `safeSegment` is the single guard that stops an externally-supplied id (e.g.
 * a courtId from an SSE payload) from escaping its intended parent directory
 * via `../` or breaking a path with hostile characters. Keep the allow-list
 * conservative — widening it re-opens path-traversal.
 *
 * ── DO NOT ──
 * - Do NOT loosen the `safeSegment` regex to allow `.` or `/` — that defeats
 *   the traversal guard.
 */

/**
 * Reduce an arbitrary string to a single, safe filesystem path segment:
 * anything outside [A-Za-z0-9_-] becomes "_". Prevents path traversal and
 * invalid characters when an untrusted id is used as a directory name.
 */
export function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Create a directory (and parents) if missing. No-op when it already exists. */
export function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}
