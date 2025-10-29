import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
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

  constructor(
    private readonly logger: Logger,
    private readonly config: Config
  ) {
    this.clientLogoPath = path.resolve(this.config.get().images.clientPath);
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
    retry: {
      event: StartStreamRequest;
      onRetryStream: (event: StartStreamRequest) => Promise<void>;
    }
  ): Promise<FFmpegProcess> {
    const command = this.buildStreamCommand(cameraUrl, streamKey, hasAudio);
    this.logger.info("Command full form", command);

    this.logger.info("Starting FFmpeg process", {
      command: command.fullCommand,
      cameraUrl: cameraUrl.value,
      streamKey,
      hasAudio,
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
        console.log("FFmpeg stderr:", output);

        // Extract time value from FFmpeg output
        const timeMatch = output.match(/time=(\d+:\d+:\d+\.\d+)/);
        console.log("timeMatch value: ", timeMatch);
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
    hasAudio: boolean
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

    // logo overlays & their formatting
    // Add logo image inputs
    args.push("-i", "./public/ds.png"); // Input 1: DropShot logo
    const dsInputIndex = 1 + fakeAudioInputCounter;
    args.push("-i", this.clientLogoPath); // Input 2: Client logo
    const clientInputIndex = 2 + fakeAudioInputCounter;
    // position them correctly using filter complex
    const filterComplex = [
      `[${dsInputIndex}:v] scale=500:-1:force_original_aspect_ratio=decrease [ds];`,
      `[${clientInputIndex}:v] scale=350:-1:force_original_aspect_ratio=decrease [client];`,
      "[0:v] scale=1920:1080 [base];",
      "[base][ds] overlay=main_w-overlay_w-10:main_h-overlay_h-10 [tmp1];",
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
}
