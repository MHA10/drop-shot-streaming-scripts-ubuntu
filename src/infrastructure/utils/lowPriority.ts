/**
 * Wrap a command so a heavy one-shot HIGHLIGHT job runs at low CPU priority.
 *
 * ── IN SIMPLE WORDS ──
 * The reel jobs (extract / reframe / render) are CPU-hungry. On a weak box they
 * can hog the processor and slow down the LIVE stream's ffmpeg enough that its
 * progress clock stalls — and the stall detector then restarts the live stream.
 * Running these jobs with `nice` tells the OS "let the live stream go first",
 * so a reel job can never starve the broadcast.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - `nice -n 19` (lowest priority) is from coreutils — present on every Linux
 *   box and macOS, so this needs nothing installed. If `nice` were somehow
 *   missing the spawn just errors, and every highlight path is already
 *   fail-soft (returns null → full-frame fallback), so the live stream is never
 *   affected either way.
 * - Deliberately NOT using `ionice`: it lives in util-linux and could be absent,
 *   which would turn a perf tweak into a hard failure. The contention that
 *   trips the stall detector is CPU, not disk, so `nice` is the right lever.
 *
 * ── DO NOT ──
 * - Do NOT use this to wrap the LIVE stream ffmpeg — it must keep normal
 *   priority; that's the whole point.
 */
export function withLowPriority(
  command: string,
  args: string[]
): { command: string; args: string[] } {
  return { command: "nice", args: ["-n", "19", command, ...args] };
}
