import { StreamRepository } from "../../domain/repositories/StreamRepository";
import { FFmpegService } from "../../domain/services/FFmpegService";
import { SSEService } from "../../domain/services/SSEService";
import { StartStreamUseCase } from "../use-cases/StartStreamUseCase";
import { StopStreamUseCase } from "../use-cases/StopStreamUseCase";
import { SSEStreamEvent } from "../../domain/events/StreamEvent";
import { Logger } from "../interfaces/Logger";
import { Config } from "../../infrastructure/config/Config";
import { StreamState } from "../../domain/value-objects/StreamState";
import { HttpClient } from "./HttpClient";
import * as fs from "fs/promises";
import * as path from "path";
import * as https from "https";

export class StreamManagerService {
  private healthCheckInterval?: NodeJS.Timeout;
  private isRunning = false;

  constructor(
    private readonly streamRepository: StreamRepository,
    private readonly ffmpegService: FFmpegService,
    private readonly sseService: SSEService,
    private readonly startStreamUseCase: StartStreamUseCase,
    private readonly stopStreamUseCase: StopStreamUseCase,
    private readonly logger: Logger,
    private readonly config: Config,
    private readonly httpClient: HttpClient
  ) {}

  public async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn("Stream manager is already running");
      return;
    }

    this.logger.info("Starting Stream Manager Service");
    this.isRunning = true;

    try {
      // Initialize state directories and recovery
      await this.initializeSystem();

      // Set up SSE event handlers
      this.setupSSEEventHandlers();

      // Start SSE connection
      const sseConfig = this.config.get().sse;
      await this.sseService.start({
        ...sseConfig,
        groundId: this.config.get().groundInfo.groundId,
        baseUrl: this.config.get().server.baseUrl,
      });

      // Start health check monitoring
      this.startHealthCheck();

      this.logger.info("Stream Manager Service started successfully");
    } catch (error) {
      this.logger.error("Failed to start Stream Manager Service", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.isRunning = false;
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger.info("Stopping Stream Manager Service");
    this.isRunning = false;

    try {
      // Stop health check
      if (this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = undefined;
      }

      // Stop SSE service
      await this.sseService.stop();

      // Stop all running streams
      await this.stopAllStreams();

      this.logger.info("Stream Manager Service stopped successfully");
    } catch (error) {
      this.logger.error("Error stopping Stream Manager Service", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async initializeSystem(): Promise<void> {
    this.logger.info("Initializing stream management system");

    try {
      // Validate and download required images
      await this.validateRequiredImages();

      // Recover running streams from persistent state
      await this.recoverStreams();

      // Clean up orphaned processes
      await this.cleanupOrphanedProcesses();

      this.logger.info("System initialization completed");
    } catch (error) {
      this.logger.error("System initialization failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async recoverStreams(): Promise<void> {
    this.logger.info("Recovering streams from persistent state");

    try {
      const runningStreams = await this.streamRepository.findRunning();

      this.logger.info("Found running streams to recover", {
        count: runningStreams.length,
      });

      for (const stream of runningStreams) {
        try {
          // Check if the process is actually running
          if (stream.processId) {
            const isRunning = await this.ffmpegService.isProcessRunning(
              stream.processId
            );

            if (!isRunning) {
              this.logger.warn(
                "Stream process not running, marking as failed",
                {
                  streamId: stream.id.value,
                  processId: stream.processId,
                }
              );

              stream.markAsFailed("Process not found during recovery");
              await this.streamRepository.save(stream);
            } else {
              this.logger.info("Stream process recovered successfully", {
                streamId: stream.id.value,
                processId: stream.processId,
              });
            }
          }
        } catch (error) {
          this.logger.error("Failed to recover stream", {
            streamId: stream.id.value,
            error: error instanceof Error ? error.message : String(error),
          });

          stream.markAsFailed("Recovery failed");
          await this.streamRepository.save(stream);
        }
      }

      // Stop all running streams and clear all persistent data
      this.logger.info("Stopping all streams and clearing data after recovery");
      await this.stopAllStreams();
      await this.streamRepository.clear();
    } catch (error) {
      this.logger.error("Stream recovery failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async cleanupOrphanedProcesses(): Promise<void> {
    this.logger.info("Cleaning up orphaned FFmpeg processes");

    try {
      const runningProcesses = await this.ffmpegService.getRunningProcesses();
      const managedStreams = await this.streamRepository.findRunning();

      const managedPids = new Set(
        managedStreams
          .map((stream) => stream.processId)
          .filter((pid) => pid !== undefined)
      );

      for (const process of runningProcesses) {
        if (!managedPids.has(process.pid)) {
          this.logger.warn("Found orphaned FFmpeg process, terminating", {
            pid: process.pid,
            command: process.command.fullCommand,
          });

          await this.ffmpegService.stopStream(process.pid);
        }
      }
    } catch (error) {
      this.logger.error("Cleanup of orphaned processes failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private setupSSEEventHandlers(): void {
    this.logger.info("Setting up SSE event handlers");

    this.sseService.onStreamEvent(async (event: SSEStreamEvent) => {
      await this.handleStreamEvent(event);
    });
  }

  private async handleStreamEvent(event: SSEStreamEvent): Promise<void> {
    this.logger.info("Handling SSE stream event", {
      action: event.action,
      cameraUrl: event.cameraUrl,
      streamKey: event.streamKey,
      reconciliationMode: event.reconciliationMode,
    });

    try {
      if (event.action === "start") {
        await this.handleStartEvent(event);
      } else if (event.action === "stop") {
        await this.handleStopEvent(event);
      }
    } catch (error) {
      this.logger.error("Failed to process stream event", {
        event,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleStartEvent(event: SSEStreamEvent) {
    this.logger.info("Handling new stream");
    await this.startStreamUseCase.execute(
      {
        cameraUrl: event.cameraUrl,
        streamKey: event.streamKey,
        courtId: event.courtId,
        detectAudio: true,
      },
      this.stopStreamUseCase.execute
    );
  }

  private async handleStopEvent(event: SSEStreamEvent) {
    // Find stream by camera URL and stream key
    const streams = await this.streamRepository.findAll();
    const targetStream = streams.find(
      (stream) =>
        stream.cameraUrl.value === event.cameraUrl &&
        stream.streamKey === event.streamKey &&
        stream.state === StreamState.RUNNING
    );

    if (targetStream) {
      await this.stopStreamUseCase.execute({
        streamId: targetStream.id.value,
      });
    } else {
      this.logger.warn("Stream not found for stop event", {
        cameraUrl: event.cameraUrl,
        streamKey: event.streamKey,
      });
    }
  }

  private startHealthCheck(): void {
    const interval = this.config.get().stream.healthCheckInterval;

    this.logger.info("Starting health check monitoring", {
      intervalMs: interval,
    });

    this.healthCheckInterval = setInterval(async () => {
      if (!this.isRunning) {
        return;
      }

      try {
        await this.performHealthCheck();
      } catch (error) {
        this.logger.error("Health check failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, interval);
  }

  private async performHealthCheck(): Promise<void> {
    this.logger.debug("Performing health check");

    try {
      // Send heartbeat to the API
      const groundId = this.config.get().groundInfo.groundId;
      if (groundId) {
        try {
          await this.httpClient.sendHeartbeat(groundId);
          this.logger.debug("Heartbeat sent successfully", { groundId });
        } catch (heartbeatError) {
          this.logger.warn("Failed to send heartbeat", {
            groundId,
            error: heartbeatError instanceof Error ? heartbeatError.message : String(heartbeatError),
          });
        }
      } else {
        this.logger.warn("Ground ID not configured, skipping heartbeat");
      }

      const runningStreams = await this.streamRepository.findRunning();

      for (const stream of runningStreams) {
        if (stream.processId) {
          const isRunning = await this.ffmpegService.isProcessRunning(
            stream.processId
          );

          if (!isRunning) {
            this.logger.warn("Stream process died, marking as failed", {
              streamId: stream.id.value,
              processId: stream.processId,
            });

            stream.markAsFailed("Process died");
            await this.streamRepository.save(stream);
          }
        }
      }

      // Check SSE connection health
      if (!this.sseService.isConnected()) {
        this.logger.warn("SSE connection is down, attempting reconnection");
        await this.sseService.reconnect();
      }
    } catch (error) {
      this.logger.error("Health check error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async stopAllStreams(): Promise<void> {
    this.logger.info("Stopping all running streams");

    try {
      const runningStreams = await this.streamRepository.findRunning();

      for (const stream of runningStreams) {
        try {
          await this.stopStreamUseCase.execute({
            streamId: stream.id.value,
          });
        } catch (error) {
          this.logger.error("Failed to stop stream during shutdown", {
            streamId: stream.id.value,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Force kill any remaining FFmpeg processes
      await this.ffmpegService.killAllProcesses();
    } catch (error) {
      this.logger.error("Failed to stop all streams", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async validateRequiredImages(): Promise<void> {
    this.logger.info("Validating required images");

    const requiredImages = [
      {
        name: "DropShot logo",
        localPath: "public/ds.png",
        downloadUrl:
          "https://raw.githubusercontent.com/DropShot-Live/static-images/main/ds-watermark.png",
      },
      {
        name: "Client logo",
        localPath: "public/client.png",
        downloadUrl:
          "https://raw.githubusercontent.com/DropShot-Live/static-images/main/padel-central.png",
      },
    ];

    for (const image of requiredImages) {
      const fullPath = path.resolve(image.localPath);

      try {
        await fs.access(fullPath);
        this.logger.info(`${image.name} found at ${image.localPath}`);
      } catch (error) {
        this.logger.warn(
          `${image.name} not found at ${image.localPath}, downloading...`
        );

        try {
          // Ensure the public directory exists
          await fs.mkdir(path.dirname(fullPath), { recursive: true });

          // Download the image
          await this.downloadFile(image.downloadUrl, fullPath);
          this.logger.info(
            `Successfully downloaded ${image.name} to ${image.localPath}`
          );
        } catch (downloadError) {
          this.logger.error(`Failed to download ${image.name}`, {
            error:
              downloadError instanceof Error
                ? downloadError.message
                : String(downloadError),
            url: image.downloadUrl,
            path: image.localPath,
          });
          throw new Error(`Failed to download required image: ${image.name}`);
        }
      }
    }

    this.logger.info("Image validation completed");
  }

  private async downloadFile(url: string, filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = require("fs").createWriteStream(filePath);

      https
        .get(url, (response) => {
          if (response.statusCode !== 200) {
            reject(
              new Error(
                `HTTP ${response.statusCode}: ${response.statusMessage}`
              )
            );
            return;
          }

          response.pipe(file);

          file.on("finish", () => {
            file.close();
            resolve();
          });

          file.on("error", (error: Error) => {
            require("fs").unlink(filePath, () => {}); // Delete the file on error
            reject(error);
          });
        })
        .on("error", (error: Error) => {
          reject(error);
        });
    });
  }

  public async getStatus(): Promise<{
    isRunning: boolean;
    sseConnected: boolean;
    runningStreams: number;
    totalStreams: number;
  }> {
    const runningStreams = await this.streamRepository.findRunning();
    const allStreams = await this.streamRepository.findAll();

    return {
      isRunning: this.isRunning,
      sseConnected: this.sseService.isConnected(),
      runningStreams: runningStreams.length,
      totalStreams: allStreams.length,
    };
  }
}
