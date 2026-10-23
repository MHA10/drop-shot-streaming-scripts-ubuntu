import * as fs from "fs";

// Below this, match-stats extras give way: snapshot pictures are skipped and
// the oldest already-sent match folders are deleted early. The live ffmpeg
// writes the highlight buffer to the same disk, and a full disk can stop the
// broadcast — that matters more than any stats record.
export const MIN_FREE_BYTES = 2 * 1024 ** 3;

/**
 * Free bytes on the disk holding `dir`, or null when it can't be told (Node
 * older than 18.15 has no statfs). Callers treat unknown as "don't block".
 */
export function freeDiskBytes(dir: string): number | null {
  const statfs = (fs as unknown as { statfsSync?: (p: string) => { bavail: number; bsize: number } })
    .statfsSync;
  if (typeof statfs !== "function") return null;
  try {
    const s = statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}
