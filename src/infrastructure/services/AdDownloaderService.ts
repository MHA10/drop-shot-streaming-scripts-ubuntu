import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";
import * as crypto from "crypto";
import { spawn } from "child_process";
import { Logger } from "../../application/interfaces/Logger";
import { AdSpec } from "../../domain/events/StreamEvent";

/**
 * An ad that has been downloaded and normalized to a single still PNG the
 * AdRotator can swap into a slot. `durationSec` is carried through unchanged
 * from the payload (still optional; resolved with a fallback by the rotator).
 */
export interface NormalizedAd {
  pngPath: string;
  durationSec?: number;
}

/** Duration + encoding knobs used when building the native concat slot videos. */
export interface AdClipOptions {
  defaultDurationSec: number;
  minDurationSec: number;
  maxDurationSec: number;
  clipFps: number;
}

/** A native ad downloaded in its original format, ready to be cut into clips. */
interface DownloadedAd {
  url: string;
  hash: string;
  rawPath: string;
  isVideo: boolean;
  durationSec?: number;
}

/** One round of the rotation schedule: show `ad` for `lengthSec` in a slot. */
interface ScheduledRound {
  ad: DownloadedAd;
  lengthSec: number;
}

export class AdDownloaderService {
  // Formats treated as animated (decoded as video); everything else is a still.
  private static readonly VIDEO_EXTS = new Set([
    "mp4",
    "gif",
    "webm",
    "mov",
    "avi",
    "mkv",
  ]);

  private readonly adDir: string;
  private readonly downloadTimeoutMs = 10000;
  private readonly normalizeTimeoutMs = 15000;
  // Clips may re-encode up to maxDuration seconds of video; give them more room.
  private readonly clipTimeoutMs = 30000;
  // Cap concurrent ffmpeg encodes so building one court's ads never saturates
  // every core and starves another court's live (main) encoder.
  private readonly clipConcurrency = 3;

  constructor(private readonly logger: Logger) {
    this.adDir = path.resolve("./ad");
    fs.mkdirSync(this.adDir, { recursive: true });
  }

  /**
   * True when the pool contains at least one animated ad (by URL extension).
   * Drives the choice between the still file-swap rotation path and the native
   * pre-composed concat path.
   */
  public hasAnimatedAds(ads: AdSpec[]): boolean {
    return (ads ?? []).some((ad) =>
      AdDownloaderService.VIDEO_EXTS.has(this.extractExtension(ad.url))
    );
  }

  /**
   * Download a pool of ads and normalize each to a still PNG (poster frame for
   * animated formats). Runs in parallel and is fail-soft: any ad that fails to
   * download or normalize is dropped, so the returned pool only contains ads
   * that are ready to be shown. Returns [] when there are no ads.
   */
  public async downloadPool(
    ads: AdSpec[],
    courtId: string
  ): Promise<NormalizedAd[]> {
    if (!ads || ads.length === 0) return [];

    const courtDir = this.getCourtDir(courtId);
    fs.mkdirSync(courtDir, { recursive: true });

    const results = await Promise.all(
      ads.map((ad) => this.prepareOne(ad, courtDir, courtId))
    );
    return results.filter((ad): ad is NormalizedAd => ad !== null);
  }

  /** Absolute path to a court's ad working directory. */
  public getCourtDir(courtId: string): string {
    return path.join(this.adDir, this.safeSegment(courtId));
  }

  /** Fixed slot file paths the running ffmpeg reads; AdRotator overwrites them. */
  public getSlotPaths(courtId: string): { left: string; right: string } {
    const dir = this.getCourtDir(courtId);
    return {
      left: path.join(dir, "slot-left.png"),
      right: path.join(dir, "slot-right.png"),
    };
  }

  /** Looping concat-video slot paths (native-motion path). */
  public getSlotVideoPaths(courtId: string): { left: string; right: string } {
    const dir = this.getCourtDir(courtId);
    return {
      left: path.join(dir, "slot-left.mp4"),
      right: path.join(dir, "slot-right.mp4"),
    };
  }

  /**
   * Native-motion path: download every ad in its original format, build a
   * collision-free rotation schedule, materialize each round as a uniform clip,
   * and concat each slot's clips into ONE looping MP4. The running ffmpeg reads
   * each slot MP4 with `-stream_loop -1`, so the rotation is baked into the
   * looping video and the main encoder never restarts.
   *
   * Fail-soft: ads that fail to download are dropped; if clip building or concat
   * fails for a slot, that slot returns null and the stream runs without it.
   * Returns { left: null, right: null } when there is nothing to show.
   */
  public async buildSlotVideos(
    ads: AdSpec[],
    courtId: string,
    options: AdClipOptions
  ): Promise<{ left: string | null; right: string | null }> {
    const empty = { left: null, right: null };
    if (!ads || ads.length === 0) return empty;

    try {
      const courtDir = this.getCourtDir(courtId);
      fs.mkdirSync(courtDir, { recursive: true });

      // 1. Download all ads natively (parallel, fail-soft) and dedupe by content
      //    hash. Dedup makes the index-level collision guard a true content-level
      //    guard (duplicate URLs would otherwise show the same creative on both
      //    slots) and avoids encoding the same asset twice.
      const downloaded = (
        await Promise.all(ads.map((ad) => this.downloadRaw(ad, courtDir, courtId)))
      ).filter((d): d is DownloadedAd => d !== null);
      const seen = new Set<string>();
      let pool = downloaded.filter((d) => {
        if (seen.has(d.hash)) return false;
        seen.add(d.hash);
        return true;
      });
      if (pool.length === 0) return empty;

      // 2. Schedule + materialize clips. Per-ad fail-soft: any ad whose clip
      //    fails to encode is dropped and the schedule is rebuilt from the
      //    survivors, so one bad creative can't blank the whole court. The pool
      //    strictly shrinks on failure, so this terminates; already-built clips
      //    are cached on disk, so reschedules are cheap.
      let schedule = this.buildSchedule(pool, options);
      while (pool.length > 0) {
        const rounds = new Map<string, ScheduledRound>();
        for (const round of [...schedule.left, ...schedule.right]) {
          rounds.set(this.clipPath(courtDir, round), round);
        }
        const failedHashes = new Set<string>();
        await this.mapWithConcurrency(
          Array.from(rounds),
          this.clipConcurrency,
          async ([clipPath, round]) => {
            if (fs.existsSync(clipPath)) return;
            try {
              await this.normalizeClip(round.ad, round.lengthSec, clipPath, options.clipFps);
            } catch (error) {
              failedHashes.add(round.ad.hash);
              this.logger.warn("Failed to build ad clip, dropping ad", {
                courtId,
                url: round.ad.url,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        );
        if (failedHashes.size === 0) break;
        pool = pool.filter((d) => !failedHashes.has(d.hash));
        if (pool.length === 0) return empty;
        schedule = this.buildSchedule(pool, options);
      }

      // 3. Concat each non-empty slot's clips into one looping MP4 (stream-copy).
      const slots = this.getSlotVideoPaths(courtId);
      const left = await this.concatSide(schedule.left, courtDir, slots.left, courtId);
      const right =
        schedule.right.length > 0
          ? await this.concatSide(schedule.right, courtDir, slots.right, courtId)
          : null;

      // 4. Drop files this run didn't use (cache churn + stale slot files of the
      //    other rotation path). Best-effort; never fatal.
      this.pruneCourtDir(courtDir, schedule, courtId);

      this.logger.info("Built native ad slot videos", {
        courtId,
        rounds: schedule.left.length,
        left,
        right,
      });
      return { left, right };
    } catch (error) {
      // Ads must never break the stream — fail soft to no ads.
      this.logger.warn("Failed to build ad slot videos, continuing without ads", {
        courtId,
        error: error instanceof Error ? error.message : String(error),
      });
      return empty;
    }
  }

  // Download + normalize a single ad to a stable, cache-friendly PNG path.
  // The filename is keyed by a hash of the URL so unchanged ads are reused.
  private async prepareOne(
    ad: AdSpec,
    courtDir: string,
    courtId: string
  ): Promise<NormalizedAd | null> {
    try {
      const hash = crypto
        .createHash("sha1")
        .update(ad.url)
        .digest("hex")
        .slice(0, 12);
      const normPath = path.join(courtDir, `norm-${hash}.png`);

      if (fs.existsSync(normPath)) {
        this.logger.info("Using cached normalized ad", { courtId, normPath });
        return { pngPath: normPath, durationSec: ad.durationSec };
      }

      const ext = this.extractExtension(ad.url);
      const rawPath = path.join(courtDir, `raw-${hash}.${ext}`);
      await this.httpDownload(ad.url, rawPath);
      await this.extractPosterFrame(rawPath, normPath);
      fs.unlink(rawPath, () => {}); // raw no longer needed once normalized

      this.logger.info("Prepared ad", { courtId, url: ad.url, normPath });
      return { pngPath: normPath, durationSec: ad.durationSec };
    } catch (error) {
      this.logger.warn("Failed to prepare ad, skipping", {
        courtId,
        url: ad.url,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  // Extract a single still frame to PNG. Works for both still images (re-encode)
  // and animated formats (first frame) via the same one-shot ffmpeg call.
  private extractPosterFrame(src: string, dest: string): Promise<void> {
    return this.runFfmpegToFile(
      ["-y", "-i", src, "-frames:v", "1", "-update", "1"],
      dest
    );
  }

  // Download a single ad in its native format, keyed by a hash of the URL so
  // identical ads are reused across stream starts. Fail-soft: returns null on error.
  private async downloadRaw(
    ad: AdSpec,
    courtDir: string,
    courtId: string
  ): Promise<DownloadedAd | null> {
    try {
      const hash = crypto
        .createHash("sha1")
        .update(ad.url)
        .digest("hex")
        .slice(0, 12);
      const ext = this.extractExtension(ad.url);
      const rawPath = path.join(courtDir, `raw-${hash}.${ext}`);

      if (fs.existsSync(rawPath)) {
        this.logger.info("Using cached raw ad", { courtId, rawPath });
      } else {
        await this.httpDownload(ad.url, rawPath);
        this.logger.info("Downloaded raw ad", { courtId, url: ad.url, rawPath });
      }

      return {
        url: ad.url,
        hash,
        rawPath,
        isVideo: AdDownloaderService.VIDEO_EXTS.has(ext),
        durationSec: ad.durationSec,
      };
    } catch (error) {
      this.logger.warn("Failed to download ad, skipping", {
        courtId,
        url: ad.url,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  // Build two equal-total, collision-free slot sequences from the pool.
  //
  // One round per ad: round k has length = the (clamped) duration of base[k] and
  // shows base[k] on the left, base[(k+offset)] on the right. Both slots share
  // the same ordered round lengths, so the two concatenated videos have an
  // identical total length (they realign every loop) and at every instant the
  // left and right ads differ (offset in [1, n-1] guarantees base[k] != right).
  // Each ad's own duration is honored in its left round; on the right it is shown
  // for that round's (left-driven) length.
  private buildSchedule(
    ads: DownloadedAd[],
    options: AdClipOptions
  ): { left: ScheduledRound[]; right: ScheduledRound[] } {
    const n = ads.length;
    if (n === 0) return { left: [], right: [] };

    const round = (ad: DownloadedAd): ScheduledRound => ({
      ad,
      lengthSec: this.clampDuration(ad.durationSec, options),
    });

    if (n === 1) {
      // One ad → left slot only, looping its native clip; right stays empty.
      return { left: [round(ads[0])], right: [] };
    }

    const base = this.shuffle(ads);
    const offset = Math.floor(n / 2) || 1; // in [1, n-1] for n >= 2
    const left: ScheduledRound[] = [];
    const right: ScheduledRound[] = [];
    for (let k = 0; k < n; k++) {
      const lengthSec = this.clampDuration(base[k].durationSec, options);
      left.push({ ad: base[k], lengthSec });
      right.push({ ad: base[(k + offset) % n], lengthSec });
    }
    return { left, right };
  }

  // Concat one slot's rounds into a single looping MP4 (stream-copy, near-free).
  // Fail-soft: returns null if the concat fails so the stream can run without
  // that slot.
  private async concatSide(
    rounds: ScheduledRound[],
    courtDir: string,
    dest: string,
    courtId: string
  ): Promise<string | null> {
    try {
      const listPath = `${dest}.txt`;
      const lines = rounds
        .map((round) => `file '${this.clipPath(courtDir, round)}'`)
        .join("\n");
      fs.writeFileSync(listPath, `${lines}\n`);
      await this.concatClips(listPath, dest);
      return dest;
    } catch (error) {
      this.logger.warn("Failed to concat ad slot, skipping slot", {
        courtId,
        dest,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  // Cut a native ad to a uniform 220x500 clip of exactly `lengthSec` (still →
  // held for the duration; video/gif → looped/trimmed). A forced keyframe every
  // second makes the concat joins and the stream_loop wrap land cleanly. `-an`
  // strips audio so ad sound can never reach the YouTube output.
  private normalizeClip(
    ad: DownloadedAd,
    lengthSec: number,
    dest: string,
    fps: number
  ): Promise<void> {
    const loopFlags = ad.isVideo ? ["-stream_loop", "-1"] : ["-loop", "1"];
    const vf =
      "scale=220:500:force_original_aspect_ratio=decrease," +
      "pad=220:500:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1," +
      `fps=${fps},format=yuv420p`;
    return this.runFfmpegToFile(
      [
        "-y",
        ...loopFlags,
        "-i",
        ad.rawPath,
        "-t",
        String(lengthSec),
        "-vf",
        vf,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-g",
        String(fps),
        "-keyint_min",
        String(fps),
        "-sc_threshold",
        "0",
        "-video_track_timescale",
        String(fps * 1000),
        "-an",
      ],
      dest,
      this.clipTimeoutMs
    );
  }

  // Stream-copy concat of a clip list into one MP4 (no re-encode).
  private concatClips(listPath: string, dest: string): Promise<void> {
    return this.runFfmpegToFile(
      ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy"],
      dest
    );
  }

  // Per-(ad, length) clip path; cached so an ad shown at the same length twice
  // (e.g. as both a left and a right round) is only encoded once.
  private clipPath(courtDir: string, round: ScheduledRound): string {
    return path.join(courtDir, `clip-${round.ad.hash}-${round.lengthSec}.mp4`);
  }

  // Resolve a payload duration to a clamped integer-second clip length. The
  // final Math.max(1, …) floor guarantees a positive length even under a
  // misconfigured (non-positive) min, so `-t` can never be 0 (which would emit a
  // zero-frame clip and poison the concat).
  private clampDuration(durationSec: number | undefined, options: AdClipOptions): number {
    const sec =
      typeof durationSec === "number" && isFinite(durationSec) && durationSec > 0
        ? durationSec
        : options.defaultDurationSec;
    return Math.max(
      1,
      Math.round(
        Math.max(options.minDurationSec, Math.min(options.maxDurationSec, sec))
      )
    );
  }

  // Fisher–Yates shuffle into a new array.
  private shuffle<T>(items: T[]): T[] {
    const arr = items.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // Run `fn` over `items` with at most `limit` in flight at once. Rejects if any
  // task rejects (mirrors Promise.all semantics); on rejection the surviving
  // workers stop pulling new items so no further work is spawned after a failure.
  private async mapWithConcurrency<T>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<void>
  ): Promise<void> {
    let cursor = 0;
    let failed = false;
    const worker = async (): Promise<void> => {
      while (!failed && cursor < items.length) {
        const index = cursor++;
        try {
          await fn(items[index]);
        } catch (err) {
          failed = true;
          throw err;
        }
      }
    };
    const workers = Array.from(
      { length: Math.min(limit, items.length) },
      () => worker()
    );
    await Promise.all(workers);
  }

  // Best-effort removal of files this run did not use: stale cache entries
  // (raw-/clip-/norm-) from ad payloads no longer in rotation, and slot files of
  // the OTHER rotation path (e.g. a leftover slot-*.png from a prior still run).
  // Never throws — pruning must not break the stream.
  private pruneCourtDir(
    courtDir: string,
    schedule: { left: ScheduledRound[]; right: ScheduledRound[] },
    courtId: string
  ): void {
    try {
      const keep = new Set<string>([
        "slot-left.mp4",
        "slot-right.mp4",
        "slot-left.mp4.txt",
        "slot-right.mp4.txt",
      ]);
      for (const round of [...schedule.left, ...schedule.right]) {
        keep.add(path.basename(this.clipPath(courtDir, round)));
        keep.add(`raw-${round.ad.hash}.${this.extractExtension(round.ad.url)}`);
      }
      for (const file of fs.readdirSync(courtDir)) {
        const isCache =
          file.startsWith("raw-") ||
          file.startsWith("clip-") ||
          file.startsWith("norm-");
        const isStaleStill = file === "slot-left.png" || file === "slot-right.png";
        if ((isCache || isStaleStill) && !keep.has(file)) {
          fs.unlink(path.join(courtDir, file), () => {});
        }
      }
    } catch (error) {
      this.logger.warn("Ad cache prune failed (non-fatal)", {
        courtId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Run a one-shot ffmpeg whose output is `dest`. Writes to a `.tmp` first and
  // renames on success so a failed/killed run never leaves a corrupt file. The
  // caller supplies all args EXCEPT the final output path.
  private runFfmpegToFile(
    args: string[],
    dest: string,
    timeoutMs: number = this.normalizeTimeoutMs
  ): Promise<void> {
    const tmp = `${dest}.tmp`;
    return new Promise((resolve, reject) => {
      const proc = spawn("ffmpeg", [...args, tmp], {
        stdio: ["ignore", "ignore", "pipe"],
      });

      let stderr = "";
      proc.stderr?.on("data", (d) => {
        stderr += d.toString();
      });

      const timeout = setTimeout(() => {
        proc.kill("SIGKILL");
        fs.unlink(tmp, () => {});
        reject(new Error("ffmpeg timed out"));
      }, timeoutMs);

      proc.on("exit", (code) => {
        clearTimeout(timeout);
        if (code === 0 && fs.existsSync(tmp)) {
          try {
            fs.renameSync(tmp, dest);
            resolve();
          } catch (err) {
            fs.unlink(tmp, () => {});
            reject(err);
          }
        } else {
          fs.unlink(tmp, () => {});
          reject(
            new Error(`ffmpeg failed (code ${code}): ${stderr.slice(-200)}`)
          );
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        fs.unlink(tmp, () => {});
        reject(err);
      });
    });
  }

  // Make a courtId safe to use as a single filesystem path segment.
  private safeSegment(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  private extractExtension(url: string): string {
    const cleaned = url.split("?")[0];
    const match = cleaned.match(/\.([a-zA-Z0-9]{2,5})$/);
    return match ? match[1].toLowerCase() : "png";
  }

  private httpDownload(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = url.startsWith("https") ? https : http;
      const file = fs.createWriteStream(destPath);

      const cleanup = () => {
        file.close();
        fs.unlink(destPath, () => {});
      };

      const request = client.get(url, (res) => {
        if (res.statusCode !== 200) {
          cleanup();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
        file.on("error", (err) => {
          cleanup();
          reject(err);
        });
      });

      request.on("error", (err) => {
        cleanup();
        reject(err);
      });
      request.setTimeout(this.downloadTimeoutMs, () => {
        request.destroy();
        cleanup();
        reject(new Error("Download timeout"));
      });
    });
  }
}
