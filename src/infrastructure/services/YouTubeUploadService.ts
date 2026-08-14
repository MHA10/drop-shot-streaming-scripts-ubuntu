import * as fs from "fs";
import { spawn } from "child_process";
import { Logger } from "../../application/interfaces/Logger";

/**
 * Uploads a finished highlight reel to YouTube via the DropShot backend's
 * resumable upload-session flow.
 *
 * ── IN SIMPLE WORDS ──
 * After a reel is built on disk, this: (1) asks our backend for a one-time
 * Google upload URL, (2) sends the video file straight to Google in chunks
 * (retrying/resuming if a chunk drops), then (3) tells our backend the result
 * (the YouTube video id, or that it failed). Our backend never sees the video
 * bytes — only Google does.
 *
 * ── BUSINESS RULES ──
 * - The upload-session request needs the court's `streamKey`: the backend reads
 *   the video's PRIVACY off the stream_records row matching that key, scoped to
 *   the court. A wrong/absent key → the backend 404s (never a public default).
 * - `isShort` is only claimed when the reel's real dimensions (probed here with
 *   ffprobe) resolve to 9:16 or 1:1 — the only ratios the backend accepts for a
 *   Short. Any other ratio (e.g. our 4:5 default) is uploaded as a regular
 *   video, which has no ratio constraint. This avoids a guaranteed rejection.
 * - Chunks are 5 MB (a multiple of 262144, as Google's resumable protocol
 *   requires for every chunk except the last). On a 308 we trust Google's
 *   `Range` header for how much it actually kept, over our own counter.
 *
 * ── WHY IT'S BUILT THIS WAY (change at your peril) ──
 * - FAIL-SOFT: any failure logs and returns null — a failed upload must never
 *   throw into the capture pipeline or affect the live stream, and the reel is
 *   already safely on local disk regardless.
 * - The `sessionUri` is a SECRET (it's a pre-authorized write URL to Google).
 *   It is never logged and never shipped to the logs endpoint — only used to
 *   PUT bytes. Do not add it to any logger call.
 *
 * ── DO NOT ──
 * - Do NOT send the x-streaming-api-key to Google (step 6 PUTs go direct to the
 *   sessionUri with NO backend auth). Only steps 5 and 7 hit our backend.
 * - Do NOT log sessionUri, tokens, or the stream key.
 */

const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB — multiple of 262144, Google-legal
const SESSION_TIMEOUT_MS = 30_000;
const CHUNK_TIMEOUT_MS = 120_000;
const MAX_CHUNK_RETRIES = 5;

export interface ReelUploadRequest {
  filePath: string;
  courtId: string;
  streamKey: string;
  title: string;
  description?: string;
  // Desired-Short hint from the caller; only honored if dims actually resolve
  // to a Short-legal ratio (verified here).
  preferShort?: boolean;
}

export class YouTubeUploadService {
  constructor(
    private readonly baseUrl: string,
    private readonly groundId: string,
    private readonly streamingApiKey: string,
    private readonly logger: Logger
  ) {}

  /**
   * Upload `filePath` for `courtId`. Returns the YouTube video id on success,
   * or null on any failure (logged). Reports the outcome to the backend either
   * way (so a device-reported failure is recorded).
   */
  public async upload(req: ReelUploadRequest): Promise<string | null> {
    if (!this.streamingApiKey) {
      this.logger.warn("Reel upload skipped: STREAMING_API_KEY not set", {
        courtId: req.courtId,
      });
      return null;
    }
    if (!fs.existsSync(req.filePath)) {
      this.logger.warn("Reel upload skipped: file missing", {
        courtId: req.courtId,
        filePath: req.filePath,
      });
      return null;
    }

    const fileSize = fs.statSync(req.filePath).size;
    const dims = await this.probeDimensions(req.filePath);
    const durationSeconds = await this.probeDurationSec(req.filePath);

    // Only claim isShort when the reel truly is Short-legal (9:16 or 1:1) AND
    // within the 60s cap; otherwise upload as a normal video.
    const shortLegal =
      !!dims &&
      !!durationSeconds &&
      durationSeconds >= 1 &&
      durationSeconds <= 60 &&
      (this.isRatio(dims, 9, 16) || this.isRatio(dims, 1, 1));
    const isShort = (req.preferShort ?? false) && shortLegal;
    if ((req.preferShort ?? false) && !shortLegal) {
      this.logger.info(
        "Reel not Short-legal (need 9:16 or 1:1, ≤60s); uploading as regular video",
        { courtId: req.courtId, dims, durationSeconds }
      );
    }

    let uploadId: string | undefined;
    try {
      const session = await this.createSession(req, fileSize, isShort, dims, durationSeconds);
      uploadId = session.uploadId;
      this.logger.info("Reel upload session created", {
        courtId: req.courtId,
        uploadId,
        isShort,
        fileSize,
      });

      const videoId = await this.putFile(req.filePath, fileSize, session.sessionUri);
      if (!videoId) {
        await this.reportComplete(req.courtId, uploadId, {
          status: "failed",
          error: "resumable upload did not return a video id",
        });
        return null;
      }

      await this.reportComplete(req.courtId, uploadId, { videoId });
      this.logger.info("Reel uploaded", { courtId: req.courtId, uploadId, videoId });
      return videoId;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn("Reel upload failed", { courtId: req.courtId, uploadId, error: msg });
      // Best-effort failure report so the backend records it (idempotent).
      if (uploadId) {
        await this.reportComplete(req.courtId, uploadId, {
          status: "failed",
          error: msg.slice(0, 300),
        }).catch(() => {});
      }
      return null;
    }
  }

  // Step 5 — authorize the resumable upload; returns { uploadId, sessionUri }.
  private async createSession(
    req: ReelUploadRequest,
    fileSize: number,
    isShort: boolean,
    dims: { width: number; height: number } | null,
    durationSeconds: number | null
  ): Promise<{ uploadId: string; sessionUri: string }> {
    const url = `${this.baseUrl}/api/v1/padel-grounds/${this.groundId}/courts/${req.courtId}/videos/upload-session`;
    const body: Record<string, unknown> = {
      title: req.title.slice(0, 90),
      streamKey: req.streamKey,
      fileSize,
      fileType: "video/mp4",
    };
    if (req.description) body.description = req.description.slice(0, 5000);
    if (isShort && dims && durationSeconds) {
      body.isShort = true;
      body.durationSeconds = Math.round(durationSeconds);
      body.width = dims.width;
      body.height = dims.height;
    }

    const res = await this.fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-streaming-api-key": this.streamingApiKey,
        },
        body: JSON.stringify(body),
      },
      SESSION_TIMEOUT_MS
    );
    if (!res.ok) {
      throw new Error(`upload-session ${res.status}: ${(await this.safeText(res)).slice(0, 200)}`);
    }
    const json = (await res.json()) as { uploadId?: string; sessionUri?: string };
    if (!json.uploadId || !json.sessionUri) {
      throw new Error("upload-session response missing uploadId/sessionUri");
    }
    return { uploadId: json.uploadId, sessionUri: json.sessionUri };
  }

  // Step 6 — PUT the file to Google in chunks, resuming per the Range header.
  // Returns the video id from the final 200/201, or null.
  private async putFile(
    filePath: string,
    fileSize: number,
    sessionUri: string
  ): Promise<string | null> {
    let offset = 0;
    while (offset < fileSize) {
      const end = Math.min(offset + CHUNK_SIZE, fileSize);
      const chunk = this.readChunk(filePath, offset, end - offset);
      const contentRange = `bytes ${offset}-${end - 1}/${fileSize}`;

      let attempt = 0;
      // Retry a single chunk on transient failure; on a 308 advance to where
      // Google says it actually is (authoritative over our own offset).
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const res = await this.fetchWithTimeout(
          sessionUri,
          {
            method: "PUT",
            headers: {
              "Content-Type": "video/mp4",
              "Content-Range": contentRange,
            },
            body: chunk,
          },
          CHUNK_TIMEOUT_MS
        );

        if (res.status === 200 || res.status === 201) {
          const json = (await res.json().catch(() => ({}))) as { id?: string };
          return json.id ?? null;
        }
        if (res.status === 308) {
          const kept = this.parseRangeEnd(res.headers.get("range"));
          offset = kept !== null ? kept + 1 : end; // trust Google's Range
          break; // proceed to next chunk
        }
        // Non-terminal error → retry this chunk a few times, else give up.
        if (attempt >= MAX_CHUNK_RETRIES) {
          throw new Error(
            `chunk PUT failed at ${contentRange}: status ${res.status}`
          );
        }
        attempt++;
        await this.delay(1000 * Math.pow(2, attempt - 1));
      }
    }
    // Loop exited without a 200/201 (e.g. last 308 reported full size) — the
    // caller treats a null video id as a failure and reports it.
    return null;
  }

  // Step 7 — report the outcome to the backend (idempotent, safe to repeat).
  private async reportComplete(
    courtId: string,
    uploadId: string,
    payload: { videoId: string } | { status: "failed"; error: string }
  ): Promise<void> {
    const url = `${this.baseUrl}/api/v1/padel-grounds/${this.groundId}/courts/${courtId}/videos/upload-session/${uploadId}/complete`;
    const res = await this.fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-streaming-api-key": this.streamingApiKey,
        },
        body: JSON.stringify(payload),
      },
      SESSION_TIMEOUT_MS
    );
    if (!res.ok) {
      // Log but don't throw: the reel is done and (on success) already on
      // YouTube; a failed completion report is a backend-side reconciliation
      // concern, not a device failure.
      this.logger.warn("Reel upload completion report failed", {
        courtId,
        uploadId,
        status: res.status,
      });
    }
  }

  // ── helpers ──

  // Returns a plain ArrayBuffer — an unambiguous fetch BodyInit across the DOM
  // and undici typings (a Node Buffer/Uint8Array trips a TS generic mismatch,
  // though it works at runtime).
  private readChunk(filePath: string, start: number, length: number): ArrayBuffer {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, start);
      // Copy out an exact-length slice so no extra pool bytes leak into the body.
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } finally {
      fs.closeSync(fd);
    }
  }

  // Google's 308 Range header looks like "bytes=0-524287"; return the end index.
  private parseRangeEnd(range: string | null): number | null {
    if (!range) return null;
    const m = range.match(/bytes=\d+-(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  private isRatio(
    dims: { width: number; height: number },
    w: number,
    h: number
  ): boolean {
    // Allow ~1% tolerance for rounding (e.g. 1080x1920).
    const target = w / h;
    const actual = dims.width / dims.height;
    return Math.abs(actual - target) / target <= 0.01;
  }

  private probeDimensions(
    file: string
  ): Promise<{ width: number; height: number } | null> {
    return new Promise((resolve) => {
      const proc = spawn("ffprobe", [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height",
        "-of", "csv=p=0",
        file,
      ]);
      let out = "";
      proc.stdout?.on("data", (d) => (out += d.toString()));
      proc.on("exit", (code) => {
        if (code !== 0) return resolve(null);
        const m = out.trim().match(/(\d+)\s*,\s*(\d+)/);
        resolve(m ? { width: parseInt(m[1], 10), height: parseInt(m[2], 10) } : null);
      });
      proc.on("error", () => resolve(null));
    });
  }

  private probeDurationSec(file: string): Promise<number | null> {
    return new Promise((resolve) => {
      const proc = spawn("ffprobe", [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1",
        file,
      ]);
      let out = "";
      proc.stdout?.on("data", (d) => (out += d.toString()));
      proc.on("exit", (code) => {
        const dur = parseFloat(out.trim());
        resolve(code === 0 && Number.isFinite(dur) && dur > 0 ? dur : null);
      });
      proc.on("error", () => resolve(null));
    });
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async safeText(res: Response): Promise<string> {
    try {
      return await res.text();
    } catch {
      return "";
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
