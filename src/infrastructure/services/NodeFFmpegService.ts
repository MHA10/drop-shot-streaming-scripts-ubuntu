import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { PNG } from "pngjs";
import {
  FFmpegService,
  FFmpegCommand,
  FFmpegProcess,
} from "../../domain/services/FFmpegService";
import { StreamUrl } from "../../domain/value-objects/StreamUrl";
import { Logger } from "../../application/interfaces/Logger";
import { StartStreamRequest } from "../../application/interfaces/StartStreamUseCase.types";
import { Config } from "../config/Config";

export class NodeFFmpegService implements FFmpegService {
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
  ): Promise<FFmpegProcess> {
    const command = this.buildStreamCommand(
      cameraUrl,
      streamKey,
      hasAudio,
      courtId,
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
  ): FFmpegCommand {
    const rtmpUrl = `rtmp://a.rtmp.youtube.com/live2/${streamKey}`;
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
    const scoreOverlayPath = this.getScoreOverlayPath(courtId);
    this.ensureScoreOverlay(scoreOverlayPath);

    // logo overlays & their formatting
    // Add logo image inputs
    args.push("-i", "./public/ds.png"); // Input 1: DropShot logo
    const dsInputIndex = 1 + fakeAudioInputCounter;
    args.push("-i", this.clientLogoPath); // Input 2: Client logo
    const clientInputIndex = 2 + fakeAudioInputCounter;
    
    // Treat the overlay PNG as a continuously looping sequence of images
    // This allows FFmpeg to reflect file updates cleanly as they are overwritten
    args.push("-f", "image2", "-loop", "1", "-i", scoreOverlayPath); 
    const scoreInputIndex = 3 + fakeAudioInputCounter;
    // position them correctly using filter complex
    const filterComplex = [
      "[0:v] scale=1920:1080 [base];",
      // Top-left score overlay - adjusted width to prevent cutoff
      `[${scoreInputIndex}:v] scale=280:-1:force_original_aspect_ratio=decrease [score];`,
      // Bottom-right DropShot watermark
      `[${dsInputIndex}:v] scale=500:-1:force_original_aspect_ratio=decrease [ds];`,
      // Top-right client logo
      `[${clientInputIndex}:v] scale=350:-1:force_original_aspect_ratio=decrease [client];`,
      "[base][score] overlay=10:10 [tmp0];",
      "[tmp0][ds] overlay=main_w-overlay_w-10:main_h-overlay_h-10 [tmp1];",
      "[tmp1][client] overlay=main_w-overlay_w-10:10",
    ].join(" ");

    args.push("-filter_complex", filterComplex);

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

  private ensureScoreOverlay(scoreOverlayPath: string): void {
    if (!fs.existsSync(scoreOverlayPath)) {
      this.createDefaultScoreOverlay(scoreOverlayPath);
    }
  }

  private getScoreOverlayPath(courtId: string): string {
    return path.join(this.scoreOverlayDir, `${courtId}.png`);
  }

  public regenerateScoreOverlay(courtId: string): void {
    const scoreOverlayPath = this.getScoreOverlayPath(courtId);
    this.createDefaultScoreOverlay(scoreOverlayPath);
    this.logger.info("Score overlay regenerated", {
      courtId,
      path: scoreOverlayPath,
    });
  }

  public regenerateAllScoreOverlays(): void {
    if (!fs.existsSync(this.scoreOverlayDir)) {
      return;
    }

    const files = fs.readdirSync(this.scoreOverlayDir);
    files.forEach((file) => {
      if (file.endsWith(".png")) {
        const courtId = file.replace(".png", "");
        this.regenerateScoreOverlay(courtId);
      }
    });
    this.logger.info("All score overlays regenerated");
  }

  private createDefaultScoreOverlay(scoreOverlayPath: string): void {
    const width = 280;
    const height = 80;

    // More visible colors
    const background = { r: 18, g: 18, b: 24, a: 240 }; // Dark blue-gray, more opaque
    const accentColor = { r: 0, g: 200, b: 83, a: 255 }; // Bright green
    const borderColor = { r: 45, g: 45, b: 55, a: 255 }; // Lighter gray border
    const foreground = { r: 255, g: 255, b: 255, a: 255 }; // White text
    const shadow = { r: 0, g: 0, b: 0, a: 200 }; // Shadow

    const scale = 5;
    const text = "15-0 10-8";

    // Improved font with better readability
    const font: Record<string, string[]> = {
      "0": ["01110", "11011", "10101", "10101", "10101", "11011", "01110"],
      "1": ["00100", "01100", "10100", "00100", "00100", "00100", "11111"],
      "2": ["01110", "10001", "00001", "00110", "01000", "10000", "11111"],
      "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
      "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
      "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
      "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
      "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
      "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
      "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
      "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
      " ": ["000", "000", "000", "000", "000", "000", "000"],
    };

    const image = new PNG({ width, height });
    image.data.fill(0);

    const setPixel = (x: number, y: number, color: typeof background) => {
      if (x < 0 || x >= width || y < 0 || y >= height) {
        return;
      }
      const idx = (width * y + x) << 2;
      image.data[idx] = color.r;
      image.data[idx + 1] = color.g;
      image.data[idx + 2] = color.b;
      image.data[idx + 3] = color.a;
    };

    const fillRect = (
      x: number,
      y: number,
      rectWidth: number,
      rectHeight: number,
      color: typeof background,
    ) => {
      const maxX = x + rectWidth;
      const maxY = y + rectHeight;
      for (let py = y; py < maxY; py++) {
        for (let px = x; px < maxX; px++) {
          setPixel(px, py, color);
        }
      }
    };

    // Draw main background
    fillRect(0, 0, width, height, background);

    // Draw bright green accent bar at top (very visible)
    const accentHeight = 5;
    fillRect(0, 0, width, accentHeight, accentColor);

    // Draw subtle border around the entire overlay
    const borderWidth = 1;
    // Top border (after accent bar)
    fillRect(0, accentHeight, width, borderWidth, borderColor);
    // Bottom border
    fillRect(0, height - borderWidth, width, borderWidth, borderColor);
    // Left border
    fillRect(0, accentHeight, borderWidth, height - accentHeight, borderColor);
    // Right border
    fillRect(
      width - borderWidth,
      accentHeight,
      borderWidth,
      height - accentHeight,
      borderColor,
    );

    // Calculate text positioning
    const glyphs = Array.from(text).map((char) => font[char] ?? font[" "]);
    const charSpacing = 5;
    const totalTextWidth =
      glyphs.reduce((sum, glyph) => sum + (glyph[0]?.length ?? 0) * scale, 0) +
      Math.max(0, glyphs.length - 1) * charSpacing;

    const cursorX = Math.floor((width - totalTextWidth) / 2);
    const cursorY = Math.floor((height - 7 * scale) / 2) + 3; // Adjusted for accent bar

    // Helper function to draw glyphs
    const drawGlyphs = (
      offsetX: number,
      offsetY: number,
      color: typeof foreground,
    ) => {
      let x = offsetX;
      for (const glyph of glyphs) {
        const glyphHeight = glyph.length;
        const glyphWidth = glyph[0]?.length ?? 0;

        for (let row = 0; row < glyphHeight; row++) {
          const line = glyph[row];
          for (let col = 0; col < line.length; col++) {
            if (line[col] === "1") {
              for (let dy = 0; dy < scale; dy++) {
                for (let dx = 0; dx < scale; dx++) {
                  setPixel(
                    x + col * scale + dx,
                    offsetY + row * scale + dy,
                    color,
                  );
                }
              }
            }
          }
        }

        x += glyphWidth * scale + charSpacing;
      }
    };

    // Draw shadow
    drawGlyphs(cursorX + 2, cursorY + 2, shadow);
    // Draw text
    drawGlyphs(cursorX, cursorY, foreground);

    // Save image atomically to prevent streaming glitches
    fs.mkdirSync(path.dirname(scoreOverlayPath), { recursive: true });
    const buffer = PNG.sync.write(image);
    
    const tempPath = `${scoreOverlayPath}.tmp`;
    fs.writeFileSync(tempPath, buffer);
    fs.renameSync(tempPath, scoreOverlayPath);
  }
}
