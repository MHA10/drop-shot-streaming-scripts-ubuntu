import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  FFmpegService,
  FFmpegCommand,
  FFmpegProcess,
} from "../../domain/services/FFmpegService";
import { StreamUrl } from "../../domain/value-objects/StreamUrl";
import { Logger } from "../../application/interfaces/Logger";
import { Config } from "../config/Config";

export class NodeFFmpegService implements FFmpegService {
  private runningProcesses: Map<number, FFmpegProcess> = new Map();

  constructor(
    private readonly logger: Logger,
    private readonly config: Config
  ) {}

  public async startStream(
    cameraUrl: StreamUrl,
    streamKey: string,
    hasAudio: boolean,
    maxRetries = 5,
    retryDelayMs = 5000
  ): Promise<FFmpegProcess> {
    const command = this.buildStreamCommand(cameraUrl, streamKey, hasAudio);
    this.logger.info("Command full form", command);

    this.logger.info("Starting FFmpeg process", {
      command: command.fullCommand,
      cameraUrl: cameraUrl.value,
      streamKey,
      hasAudio,
    });

    let attempt = 0;

    const launchProcess = (): Promise<FFmpegProcess> => {
      attempt++;

      return new Promise((resolve, reject) => {
        const process = spawn(command.command, command.args, {
          stdio: ["ignore", "pipe", "pipe"],
          detached: false,
        });

        const ffmpegProcess: FFmpegProcess = {
          pid: process.pid!,
          command,
          startTime: new Date(),
        };

        // Handle process startup timeout
        let resolved = false;
        const startupTimeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            process.kill("SIGTERM");
            reject(new Error("FFmpeg process startup timeout"));
          }
        }, 10000); // 10 second timeout

        // Monitor stderr for startup confirmation & errors
        process.stderr?.on("data", (data) => {
          const output = data.toString();
          this.logger.debug("FFmpeg stderr", { pid: process.pid, output });

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
            if (!resolved) {
              resolved = true;
              clearTimeout(startupTimeout);
              process.kill("SIGTERM");
              reject(new Error(`FFmpeg error: ${output}`));
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

          if (process.pid) this.runningProcesses.delete(process.pid);

          if (!resolved) {
            resolved = true;
            clearTimeout(startupTimeout);
            reject(new Error(`FFmpeg process exited with code ${code}`));
          } else if (code !== 0 && attempt < maxRetries) {
            // Retry logic
            this.logger.info(
              `Retrying FFmpeg in ${retryDelayMs}ms (attempt ${attempt})`
            );
            setTimeout(() => {
              launchProcess().catch(() => {
                /* silently ignore retry failure */
              });
            }, retryDelayMs);
          }
        });

        // Handle spawn errors
        process.on("error", (error) => {
          this.logger.error("FFmpeg process error", { error: error.message });
          if (!resolved) {
            resolved = true;
            clearTimeout(startupTimeout);
            reject(error);
          } else if (attempt < maxRetries) {
            this.logger.info(
              `Retrying FFmpeg in ${retryDelayMs}ms due to spawn error (attempt ${attempt})`
            );
            setTimeout(() => launchProcess().catch(() => {}), retryDelayMs);
          }
        });
      });
    };

    return launchProcess();
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
    args.push("-i", "./public/client.png"); // Input 2: Client logo
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
    const clientLogoPath = path.resolve("./public/client.png");

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
