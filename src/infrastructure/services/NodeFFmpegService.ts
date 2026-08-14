import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { PNG } from "pngjs";
import { createCanvas } from "@napi-rs/canvas";
import {
  FFmpegService,
  FFmpegCommand,
  FFmpegProcess,
  AdOverlayPaths,
} from "../../domain/services/FFmpegService";
import { StreamUrl } from "../../domain/value-objects/StreamUrl";
import { Logger } from "../../application/interfaces/Logger";
import { StartStreamRequest } from "../../application/interfaces/StartStreamUseCase.types";
import { Config } from "../config/Config";
import { ensureDirSync } from "../utils/paths";

export class NodeFFmpegService implements FFmpegService {
  private static readonly VIDEO_EXTS = new Set(["mp4", "gif", "webm", "mov", "avi", "mkv"]);

  private readonly runningProcesses: Map<number, FFmpegProcess> = new Map();
  private readonly clientLogoPath: string;
  private readonly scoreOverlayDir: string;

  constructor(
    private readonly logger: Logger,
    private readonly config: Config,
  ) {
    this.clientLogoPath = path.resolve(this.config.get().images.clientPath);
    this.scoreOverlayDir = path.resolve("./public/overlays");
  }

  /**
   * Starts an FFmpeg stream with automatic recovery mechanisms:
   * 1. Monitors FFmpeg stderr output for "time=00:00:00.00" timestamps
   * 2. Detects stalled streams when the same timestamp repeats 10 consecutive times
   * 3. Automatically kills and restarts stalled processes using SIGKILL
   * 4. Uses a 10-second timeout to detect completely frozen processes
   *
   * The restart mechanism relies on process exit events and the retry parameter
   * to handle stream recovery after failures.
   */
  public async startStream(
    cameraUrl: StreamUrl,
    streamKey: string,
    hasAudio: boolean,
    courtId: string,
    retry: {
      event: StartStreamRequest;
      onRetryStream: (event: StartStreamRequest) => Promise<void>;
    },
    isScorecardActivated?: boolean,
    adPaths?: AdOverlayPaths,
    highlightBufferDir?: string | null
  ): Promise<FFmpegProcess> {
    const command = this.buildStreamCommand(
      cameraUrl,
      streamKey,
      hasAudio,
      courtId,
      isScorecardActivated,
      adPaths,
      highlightBufferDir
    );
    this.logger.info("Command full form", command);

    this.logger.info("Starting FFmpeg process", {
      command: command.fullCommand,
      cameraUrl: cameraUrl.value,
      streamKey,
      hasAudio,
      courtId,
    });

    return new Promise((resolve) => {
      const process = spawn(command.command, command.args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });

      const ffmpegProcess: FFmpegProcess = {
        pid: process.pid!,
        command,
        startTime: new Date(),
      };

      // Handle process startup
      let resolved = false;
      const startupTimeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          process.kill("SIGTERM");
        }
      }, 10000); // 10 second timeout

      // Variables to track time value and detect stalled streams
      let lastTimeValue: string | null = null;
      let sameTimeCounter = 0;
      const MAX_SAME_TIME_COUNT = 10; // Restart after 10 consecutive identical time values

      // Monitor stderr for startup confirmation
      process.stderr?.on("data", (data) => {
        const output = data.toString();

        // Extract time value from FFmpeg output
        const timeMatch = output.match(/time=(\d+:\d+:\d+\.\d+)/);
        if (timeMatch && timeMatch[1]) {
          const currentTimeValue = timeMatch[1];

          // Check if time value is the same as the last one
          if (currentTimeValue === lastTimeValue) {
            sameTimeCounter++;
            console.log(
              `Stream time stalled: ${sameTimeCounter}/${MAX_SAME_TIME_COUNT} (${currentTimeValue})`
            );

            // If time value has been the same for MAX_SAME_TIME_COUNT times, restart the stream
            if (sameTimeCounter >= MAX_SAME_TIME_COUNT) {
              console.log(
                `Stream stalled for ${MAX_SAME_TIME_COUNT} consecutive frames. Restarting...`
              );
              process.kill("SIGKILL");
              sameTimeCounter = 0; // Reset counter
              return;
            }
          } else {
            // Reset counter if time value changed
            sameTimeCounter = 0;
            lastTimeValue = currentTimeValue;
          }
        }

        // Look for successful stream start indicators
        if (
          output.includes("Stream mapping:") ||
          output.includes("Press [q] to stop")
        ) {
          if (!resolved) {
            resolved = true;
            clearTimeout(startupTimeout);
            this.runningProcesses.set(process.pid!, ffmpegProcess);
            resolve(ffmpegProcess);
          }
        }

        if (
          output.includes("Connection refused") ||
          output.includes("No route to host") ||
          output.includes("Invalid data found")
        ) {
          // Check for errors
          if (!resolved) {
            resolved = true;
            clearTimeout(startupTimeout);
            process.kill("SIGTERM");
          }
        }
      });

      // Handle process exit
      process.on("exit", (code, signal) => {
        this.logger.info("FFmpeg process exited", {
          pid: process.pid,
          code,
          signal,
          cameraUrl: cameraUrl.value,
        });

        if (process.pid) {
          this.runningProcesses.delete(process.pid);
        }

        retry.onRetryStream(retry.event);

        if (code !== 0) {
          resolved = true;
          clearTimeout(startupTimeout);
        }
      });

      // Handle spawn errors
      process.on("error", (error) => {
        retry.onRetryStream(retry.event);
        this.logger.error("FFmpeg process error", { error: error.message });
        clearTimeout(startupTimeout);
      });
    });
  }

  public async stopStream(pid: number): Promise<void> {
    this.logger.info("Stopping FFmpeg process", { pid });

    const ffmpegProcess = this.runningProcesses.get(pid);
    if (!ffmpegProcess) {
      this.logger.warn("Process not found in running processes", { pid });
      // Try to kill the process anyway using Node.js process.kill
      try {
        process.kill(pid, "SIGTERM");
        // Wait a bit, then force kill if needed
        setTimeout(() => {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            // Process might already be dead
          }
        }, 5000);
      } catch (error) {
        // Process might not exist
      }
      return;
    }

    return new Promise((resolve) => {
      try {
        process.kill(pid, "SIGTERM");

        // Force kill after 5 seconds if not terminated
        const forceKillTimeout = setTimeout(() => {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            // Process might already be dead
          }
        }, 5000);

        // Clean up when process actually exits
        const checkInterval = setInterval(() => {
          if (!this.runningProcesses.has(pid)) {
            clearTimeout(forceKillTimeout);
            clearInterval(checkInterval);
            resolve();
          }
        }, 100);

        // Fallback timeout
        setTimeout(() => {
          clearTimeout(forceKillTimeout);
          clearInterval(checkInterval);
          this.runningProcesses.delete(pid);
          resolve();
        }, 10000);
      } catch (error) {
        this.logger.error("Error stopping FFmpeg process", { pid, error });
        this.runningProcesses.delete(pid);
        resolve();
      }
    });
  }

  public async isProcessRunning(pid: number): Promise<boolean> {
    try {
      // Check if process exists and is running
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return false;
    }
  }

  public async detectAudio(cameraUrl: StreamUrl): Promise<boolean> {
    this.logger.info("Detecting audio for stream", {
      cameraUrl: cameraUrl.value,
    });
    const args = [
      "-rtsp_transport",
      "tcp",
      "-i",
      cameraUrl.value,
      "-t",
      "5", // Test for 5 seconds
      "-vn",
      "-f",
      "null",
      "-",
    ];

    return new Promise((resolve) => {
      const process = spawn("ffmpeg", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let hasAudio = false;
      const timeout = setTimeout(() => {
        process.kill("SIGTERM");
        resolve(hasAudio);
      }, 10000); // 10 second timeout

      process.stderr?.on("data", (data) => {
        const output = data.toString();

        // Look for audio stream indicators
        if (output.includes("Stream #") && output.includes("Audio:")) {
          hasAudio = true;
        }
      });

      process.on("exit", () => {
        clearTimeout(timeout);
        resolve(hasAudio);
      });

      process.on("error", (error) => {
        this.logger.error("Audio detection error", { error: error.message });
        clearTimeout(timeout);
        resolve(false);
      });
    });
  }

  public buildStreamCommand(
    cameraUrl: StreamUrl,
    streamKey: string,
    hasAudio: boolean,
    courtId: string,
    isScorecardActivated?: boolean,
    adPaths?: AdOverlayPaths,
    highlightBufferDir?: string | null
  ): FFmpegCommand {
    const rtmpUrl = `${this.config.get().stream.youtubeRtmpBase}/${streamKey}`;
    let fakeAudioInputCounter = 0;

    let args: string[] = [];

    // Add input parameters
    args.push("-rtsp_transport", "tcp");

    args.push("-i", cameraUrl.value);

    if (!hasAudio) {
      // Without audio - add null audio source like in bash script
      args.push("-f", "lavfi");
      args.push("-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
      fakeAudioInputCounter++;
    }

    // Validate logo files exist before adding them
    this.validateImageFiles();

    // logo overlays & their formatting
    // Add logo image inputs
    args.push("-i", "./public/ds.png"); // Input 1: DropShot logo
    const dsInputIndex = 1 + fakeAudioInputCounter;
    args.push("-i", this.clientLogoPath); // Input 2: Client logo
    const clientInputIndex = 2 + fakeAudioInputCounter;

    let nextInputIndex = 3 + fakeAudioInputCounter;

    let filterComplex = "";

    // Optional scorecard overlay (top-left). Adds one input before any ads.
    let scoreInputIndex: number | null = null;
    if (isScorecardActivated) {
      const scoreOverlayPath = this.getScoreOverlayPath(courtId);
      // Always start from a fully transparent overlay so nothing is shown until
      // the first live score update arrives. This also wipes any stale scorecard
      // left on disk from a previous match on this court.
      this.resetScoreOverlay(scoreOverlayPath);
      // Treat the overlay PNG as a continuously looping sequence of images
      // This allows FFmpeg to reflect file updates cleanly as they are overwritten
      args.push("-f", "image2", "-loop", "1", "-i", scoreOverlayPath);
      scoreInputIndex = nextInputIndex++;
    }

    // Resolve left/right ad paths and push each as a new input if present.
    // These are fixed PNG "slot" files managed by AdRotator: it overwrites them
    // on a timer to rotate the pool, and ffmpeg reflects each new file via the
    // image2 loop below (same live-reload trick as the score overlay). A missing
    // slot file simply means that side has no ad this session.
    const leftAdPath =
      adPaths?.left && fs.existsSync(adPaths.left) ? adPaths.left : null;
    const rightAdPath =
      adPaths?.right && fs.existsSync(adPaths.right) ? adPaths.right : null;

    let leftAdInputIndex: number | null = null;
    let rightAdInputIndex: number | null = null;

    if (leftAdPath) {
      args.push(...this.buildAdInputFlags(leftAdPath));
      leftAdInputIndex = nextInputIndex++;
    }
    if (rightAdPath) {
      args.push(...this.buildAdInputFlags(rightAdPath));
      rightAdInputIndex = nextInputIndex++;
    }

    const hasAnyAd = leftAdInputIndex !== null || rightAdInputIndex !== null;

    // Highlight buffer: when a buffer dir is configured, branch the scaled
    // frame BEFORE any overlay is applied. One copy ([base]) continues into
    // the existing overlay/RTMP chain completely unchanged; the other
    // ([hlbuf]) becomes a second output that records a raw (no ads/logos)
    // rolling buffer for later highlight-clip extraction. This keeps the
    // camera connection count at exactly one — no second ffmpeg process, no
    // proxy — the split happens inside this same command.
    // Fail-soft: the highlight buffer is a non-critical, secondary output. If
    // its directory can't be created (bad path, permissions, disk full), we
    // must NOT let that abort the live stream — disable the buffer branch for
    // this run and build the command exactly as if it were off. Without this,
    // a throw here propagates up and leaves the stream wedged (the caller's
    // catch doesn't reset state), blocking future starts for the court.
    let highlightBufferEnabled = !!highlightBufferDir;
    if (highlightBufferEnabled) {
      try {
        ensureDirSync(highlightBufferDir!);
      } catch (error) {
        this.logger.warn(
          "Failed to create highlight buffer dir; continuing without highlight buffer",
          {
            highlightBufferDir,
            error: error instanceof Error ? error.message : String(error),
          }
        );
        highlightBufferEnabled = false;
      }
    }

    // Build filter graph
    const steps: string[] = highlightBufferEnabled
      ? ["[0:v] scale=1920:1080 [scaled];", "[scaled] split=2 [base][hlbuf];"]
      : ["[0:v] scale=1920:1080 [base];"];

    if (scoreInputIndex !== null) {
      steps.push(
        `[${scoreInputIndex}:v] scale=420:-1:force_original_aspect_ratio=decrease [score];`
      );
    }
    steps.push(
      `[${dsInputIndex}:v] scale=500:140:force_original_aspect_ratio=decrease [ds];`,
      `[${clientInputIndex}:v] scale=400:140:force_original_aspect_ratio=decrease [client];`
    );
    if (leftAdInputIndex !== null) {
      steps.push(
        `[${leftAdInputIndex}:v] scale=220:500:force_original_aspect_ratio=decrease [leftAd];`
      );
    }
    if (rightAdInputIndex !== null) {
      steps.push(
        `[${rightAdInputIndex}:v] scale=220:500:force_original_aspect_ratio=decrease [rightAd];`
      );
    }

    // Overlay chain: base → (score) → ds → client → (leftAd) → (rightAd)
    if (scoreInputIndex !== null) {
      steps.push(
        "[base][score] overlay=30:30 [tmp0];",
        "[tmp0][ds] overlay=main_w-overlay_w-10:main_h-overlay_h-10 [tmp1];"
      );
    } else {
      steps.push("[base][ds] overlay=main_w-overlay_w-10:main_h-overlay_h-10 [tmp1];");
    }

    // After client overlay: label output [tmp2] if ads follow, else leave unlabeled (final output)
    if (hasAnyAd) {
      steps.push("[tmp1][client] overlay=main_w-overlay_w-10:10 [tmp2];");

      const adSlots: Array<{ label: string; pos: string }> = [
        leftAdInputIndex !== null ? { label: "leftAd", pos: "10:(main_h-overlay_h)/2" } : null,
        rightAdInputIndex !== null ? { label: "rightAd", pos: "main_w-overlay_w-10:(main_h-overlay_h)/2" } : null,
      ].filter((x): x is { label: string; pos: string } => x !== null);

      let cur = "tmp2";
      adSlots.forEach(({ label, pos }, i) => {
        const isLast = i === adSlots.length - 1;
        const next = isLast ? "vout" : `tmp${3 + i}`;
        steps.push(`[${cur}][${label}] overlay=${pos} [${next}]${isLast ? "" : ";"}`);
        cur = next;
      });
    } else if (highlightBufferEnabled) {
      // The highlight buffer branch introduces a second named filtergraph
      // pad ([hlbuf]), so the primary chain's output can no longer rely on
      // ffmpeg's "auto-pick the single unlabeled filtergraph output"
      // behavior — that becomes ambiguous with two named pads present. Label
      // it explicitly and map it below, same as the ad-overlay path already
      // has to.
      steps.push("[tmp1][client] overlay=main_w-overlay_w-10:10 [vout]");
    } else {
      steps.push("[tmp1][client] overlay=main_w-overlay_w-10:10");
    }

    filterComplex = steps.join(" ");

    args.push("-filter_complex", filterComplex);

    // Whether the primary chain terminates in an explicit [vout] label (vs.
    // ffmpeg's implicit single-output selection) and whether we must emit an
    // explicit -map for it are the SAME decision — derive both from one flag
    // so a future output-adding feature can't update one site and forget the
    // other (which would dangle the label or map a non-existent pad).
    const needsExplicitVout = hasAnyAd || highlightBufferEnabled;
    if (needsExplicitVout) {
      args.push("-map", "[vout]");
      args.push("-map", `${fakeAudioInputCounter}:a`);
    }

    // audio & video output configurations
    args.push(
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-b:v",
      "4500k",
      "-maxrate",
      "5000k",
      "-bufsize",
      "10000k"
    );
    args.push(
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "44100",
      "-ac",
      "2",
      "-shortest"
    );

    // Specify output format for RTMP streaming
    args.push("-f", "flv", rtmpUrl);

    // Second output: the highlight buffer branch. Deliberately cheap encode
    // (low bitrate, ultrafast, no audio) since this is an intermediate
    // artifact that gets reframed/re-encoded again during highlight
    // processing — quality parity with the broadcast output isn't needed.
    // "-c copy" isn't an option here: [hlbuf] is decoded/filtered video, not
    // an already-encoded bitstream, so it must be encoded to be written out.
    if (highlightBufferEnabled) {
      const segmentSec = this.config.get().highlight.bufferSegmentSec;
      // Unique per stream run (and per retry, since retries rebuild the
      // command). The segment muxer names files by whole-second wall clock
      // (%s), so on a fast restart the respawned process's first segment could
      // land on the same second as the dying process's last one and overwrite
      // it. A per-run token in the name keeps runs from colliding while %s
      // still carries the segment's start time for the buffer manifest.
      const runToken = Date.now().toString(36);
      args.push(
        "-map", "[hlbuf]",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-b:v", "800k",
        "-an",
        // Force a keyframe exactly every segmentSec. The segment muxer can only
        // cut at keyframes; without this, libx264's default GOP (~250 frames,
        // ~8-10s) governs the real segment length and -segment_time is
        // effectively ignored, producing segments far coarser than configured.
        "-force_key_frames", `expr:gte(t,n_forced*${segmentSec})`,
        "-f", "segment",
        "-segment_time", String(segmentSec),
        "-reset_timestamps", "1",
        "-strftime", "1",
        path.join(highlightBufferDir!, `seg-${runToken}-%s.ts`)
      );
    }

    const fullCommand = `ffmpeg ${args.join(" ")}`;

    return {
      command: "ffmpeg",
      args,
      fullCommand,
    };
  }

  public async getRunningProcesses(): Promise<FFmpegProcess[]> {
    return Array.from(this.runningProcesses.values());
  }

  public async killAllProcesses(): Promise<void> {
    this.logger.info("Killing all FFmpeg processes", {
      count: this.runningProcesses.size,
    });

    const killPromises = Array.from(this.runningProcesses.keys()).map((pid) =>
      this.stopStream(pid)
    );

    await Promise.all(killPromises);
    this.runningProcesses.clear();
  }

  // Pick the right ffmpeg input flags for an ad file based on its extension.
  // Animated formats loop via stream_loop; stills via image2 loop.
  // For the looping concat slot video, "-stream_loop -1" makes the input
  // infinite (it never EOFs, so the main encoder's clock never stalls), and
  // "-fflags +genpts" smooths the PTS reset at each loop wrap.
  private buildAdInputFlags(adPath: string): string[] {
    const ext = path.extname(adPath).slice(1).toLowerCase();
    if (NodeFFmpegService.VIDEO_EXTS.has(ext)) {
      return ["-stream_loop", "-1", "-re", "-fflags", "+genpts", "-i", adPath];
    }
    return ["-f", "image2", "-loop", "1", "-i", adPath];
  }

  private validateImageFiles(): void {
    const dsLogoPath = path.resolve("./public/ds.png");
    const clientLogoPath = path.resolve(this.clientLogoPath);

    if (!fs.existsSync(dsLogoPath)) {
      throw new Error(`DropShot logo not found at: ${dsLogoPath}`);
    }

    if (!fs.existsSync(clientLogoPath)) {
      throw new Error(`Client logo not found at: ${clientLogoPath}`);
    }

    this.logger.info("Logo files validated successfully", {
      dsLogo: dsLogoPath,
      clientLogo: clientLogoPath,
    });
  }

  private resetScoreOverlay(scoreOverlayPath: string): void {
    // Unconditionally (re)write the transparent placeholder. Unlike an
    // ensure-if-missing check, this guarantees a clean slate on every stream
    // start so a previous match's scorecard never shows on the new stream.
    this.createDefaultScoreOverlay(scoreOverlayPath);
  }

  private getScoreOverlayPath(courtId: string): string {
    return path.join(this.scoreOverlayDir, `${courtId}.png`);
  }

  private createDefaultScoreOverlay(scoreOverlayPath: string): void {
    const width = 420;
    const height = 120;
    
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // Make transparent background
    ctx.clearRect(0, 0, width, height);

    // Initial scoreboard starts completely invisible (transparent PNG).
    // The SupabaseListener will overwrite this file with actual shapes
    // and text once real game score data is received.

    // Ensure temp directory exists and write final overlay
    fs.mkdirSync(path.dirname(scoreOverlayPath), { recursive: true });
    
    const buffer = canvas.encodeSync('png');
    fs.writeFileSync(scoreOverlayPath, buffer);
  }
}
