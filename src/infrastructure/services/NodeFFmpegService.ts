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
    const height = 160;

    const FONT: Record<string, string[]> = {
        "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
        "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
        "2": ["01110", "10001", "00001", "00110", "01000", "10000", "11111"],
        "3": ["01110", "10001", "00001", "00110", "00001", "10001", "01110"],
        "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
        "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
        "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
        "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
        "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
        "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
        "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
        "D": ["11110", "10011", "10001", "10001", "10001", "10011", "11110"],
        "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
        "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
        ":": ["00000", "00100", "00000", "00000", "00100", "00000", "00000"],
        " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
    };

    const B_FONT: Record<string, string[]> = {
        "B": ["11110", "10001", "11110", "10001", "11110"],
        "L": ["10000", "10000", "10000", "10000", "11111"],
        "U": ["10001", "10001", "10001", "10001", "01110"],
        "E": ["11111", "10000", "11110", "10000", "11111"],
        "R": ["11110", "10001", "11110", "10100", "10011"],
        "D": ["11110", "10011", "10001", "10011", "11110"],
        "H": ["10001", "10001", "11111", "10001", "10001"],
        "O": ["01110", "10001", "10001", "10001", "01110"],
        "M": ["10001", "11011", "10101", "10001", "10001"],
        "G": ["01110", "10000", "10111", "10001", "01110"],
        "S": ["01111", "10000", "01110", "00001", "11110"],
        "T": ["11111", "00100", "00100", "00100", "00100"],
        " ": ["00000", "00000", "00000", "00000", "00000"],
        "A": ["01110", "10001", "11111", "10001", "10001"],
        "C": ["01111", "10000", "10000", "10000", "01111"],
    };

    const image = new PNG({ width, height });
    image.data.fill(0);

    const setPixel = (x: number, y: number, color: any) => {
        if (x < 0 || x >= width || y < 0 || y >= height) return;
        const idx = (width * y + x) << 2;
        image.data[idx] = color.r;
        image.data[idx + 1] = color.g;
        image.data[idx + 2] = color.b;
        image.data[idx + 3] = color.a;
    };

    const fillRect = (x: number, y: number, w: number, h: number, color: any) => {
        for (let py = y; py < y + h; py++) {
            for (let px = x; px < x + w; px++) {
                setPixel(px, py, color);
            }
        }
    };

    // Colors matching the original display
    const bg = { r: 18, g: 18, b: 24, a: 240 };
    const border = { r: 240, g: 240, b: 240, a: 255 };
    const headerBg = { r: 25, g: 25, b: 35, a: 240 };
    const ledBg = { r: 15, g: 15, b: 20, a: 240 };

    const ledOn = { r: 255, g: 10, b: 10, a: 255 };
    const ledOff = { r: 60, g: 20, b: 20, a: 200 };
    const textWhite = { r: 255, g: 255, b: 255, a: 255 };

    const drawLedDigit = (char: string, ox: number, oy: number, size: number) => {
        const glyph = FONT[char] || FONT[" "];
        const dotSize = size;
        const gap = 1;
        for (let row = 0; row < 7; row++) {
            for (let col = 0; col < 5; col++) {
                const isOn = glyph[row] && glyph[row][col] === "1";
                fillRect(ox + col * (dotSize + gap), oy + row * (dotSize + gap), dotSize, dotSize, isOn ? ledOn : ledOff);
            }
        }
        return 5 * (size + gap);
    };

    const drawLedText = (text: string, x: number, y: number, size: number, spacing: number) => {
        let currX = x;
        for (const char of text) {
            drawLedDigit(char, currX, y, size);
            currX += 5 * (size + 1) + spacing;
        }
        return currX - x;
    };

    const measureLedText = (text: string, size: number, spacing: number) => {
        return text.length * 5 * (size + 1) + Math.max(0, text.length - 1) * spacing;
    };

    const drawTitleText = (text: string, x: number, y: number, size: number, spacing: number) => {
        let currX = x;
        for (const char of text) {
            const glyph = B_FONT[char] || B_FONT[" "];
            const dotSize = size;
            for (let row = 0; row < 5; row++) {
                for (let col = 0; col < 5; col++) {
                    const isOn = glyph[row] && glyph[row][col] === "1";
                    if(isOn) fillRect(currX + col * dotSize, y + row * dotSize, dotSize, dotSize, textWhite);
                }
            }
            currX += 5 * dotSize + spacing;
        }
        return currX - x;
    };

    const measureTitleText = (text: string, size: number, spacing: number) => {
        return text.length * 5 * size + Math.max(0, text.length - 1) * spacing;
    };

    // Draw base board
    fillRect(0, 0, width, height, bg);
    
    // Outer Border
    fillRect(2, 2, width - 4, height - 4, border);
    
    // Inner margins
    const pad = 5;
    fillRect(pad, pad, width - pad * 2, height - pad * 2, headerBg);

    // Separators
    fillRect(pad, 42, width - pad * 2, 2, border); // Headers vs Scores
    fillRect(pad, 115, width - pad * 2, 2, border); // Scores vs Bottom Timer
    fillRect(width / 2 - 1, pad, 2, 42 - pad, border); // Home vs Guest Header Divider

    // LED Background Areas
    fillRect(pad, 44, width - pad * 2, 115 - 44, ledBg);
    fillRect(pad, 117, width - pad * 2, height - pad - 117, ledBg);

    // Draw Titles (BLUE / RED)
    const titleY = 14;
    const titleS = 4;
    const hw = measureTitleText("BLUE", titleS, 3);
    const gw = measureTitleText("RED", titleS, 3);
    
    drawTitleText("BLUE", Math.floor(width / 4 - hw / 2), titleY, titleS, 3);
    drawTitleText("RED", Math.floor(3 * width / 4 - gw / 2), titleY, titleS, 3);

    // Default Scores Placeholder
    const bScore = "00";
    const rScore = "00";
    const sSize = 6;
    const lw = measureLedText(bScore, sSize, 6);
    const rw = measureLedText(rScore, sSize, 6);
    const cw = measureLedText(":", sSize, 6);

    const scoreY = 56;
    drawLedText(bScore, Math.floor(width / 4 - lw / 2) + 5, scoreY, sSize, 6);
    drawLedText(":", Math.floor(width / 2 - cw / 2), scoreY, sSize, 6);
    drawLedText(rScore, Math.floor(3 * width / 4 - rw / 2) - 5, scoreY, sSize, 6);

    // Default Timer / Games Placeholder
    const gamesStr = "00:00";
    const gSize = 3;
    const gbW = measureLedText(gamesStr, gSize, 4);
    drawLedText(gamesStr, Math.floor(width / 2 - gbW / 2), 125, gSize, 4);

    // Ensure temp directory exists and write final overlay
    fs.mkdirSync(path.dirname(scoreOverlayPath), { recursive: true });
    const buffer = PNG.sync.write(image);
    
    const tempPath = `${scoreOverlayPath}.tmp`;
    fs.writeFileSync(tempPath, buffer);
    fs.renameSync(tempPath, scoreOverlayPath);
  }
}
