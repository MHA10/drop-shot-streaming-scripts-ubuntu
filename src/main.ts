#!/usr/bin/env node

import * as path from "path";
import * as packageJson from "../package.json";
import { Config } from "./infrastructure/config/Config";
import { FileSystemStreamRepository } from "./infrastructure/repositories/FileSystemStreamRepository";
import { NodeFFmpegService } from "./infrastructure/services/NodeFFmpegService";
import { NodeSSEService } from "./infrastructure/services/NodeSSEService";
import { AdDownloaderService } from "./infrastructure/services/AdDownloaderService";
import { AdRotationRegistry } from "./infrastructure/services/AdRotator";
import { StartStreamUseCase } from "./application/use-cases/StartStreamUseCase";
import { StopStreamUseCase } from "./application/use-cases/StopStreamUseCase";
import { StreamManagerService } from "./application/services/StreamManagerService";
import { HttpClient } from "./application/services/HttpClient";
import { RemoteLogger } from "./infrastructure/logging/RemoteLogger";
import { SupabaseService } from "./infrastructure/services/SupabaseService";
import { SupabaseListener } from "./infrastructure/listeners/SupabaseListener";
import { SerialHighlightListener } from "./infrastructure/services/SerialHighlightListener";
import { HighlightBufferRegistry } from "./infrastructure/services/HighlightBufferRegistry";
import { HighlightExtractorService } from "./infrastructure/services/HighlightExtractorService";
import { HighlightRendererService } from "./infrastructure/services/HighlightRendererService";
import { NullBallReframer } from "./infrastructure/services/NullBallReframer";
import { PythonBallReframer } from "./infrastructure/services/PythonBallReframer";
import { CaptureHighlightUseCase } from "./application/use-cases/CaptureHighlightUseCase";

class Application {
  private streamManager?: StreamManagerService;
  private supabaseListener?: SupabaseListener;
  private highlightSignalSource?: SerialHighlightListener;
  private readonly adRotationRegistry = new AdRotationRegistry();
  private readonly highlightBufferRegistry = new HighlightBufferRegistry();
  private readonly logger = new RemoteLogger(
    {
      ...Config.getInstance().get().remoteLogging,
      baseUrl: Config.getInstance().get().server.baseUrl,
    },
    "debug"
  );
  private readonly httpClient = new HttpClient();

  public async start(): Promise<void> {
    try {

      
      this.logger.info("Starting Streamer Node Application");
      this.logger.info(`Current version: ${packageJson.version}`);

      // Initialize configuration
      const config = Config.getInstance();
      this.logger.info("Configuration loaded", { config: config.get() });

      // Initialize dependencies
      const streamRepository = new FileSystemStreamRepository(
        config.get().stream.persistentStateDir,
        this.logger
      );
      const ffmpegService = new NodeFFmpegService(this.logger, config);
      const sseService = new NodeSSEService(this.logger);
      const adDownloader = new AdDownloaderService(this.logger);

      // Highlight hardware detector. Started once at boot (tied to the physical
      // USB device, not any one stream). Its isDevicePresent() drives automatic
      // per-box enablement of the highlight buffer inside StartStreamUseCase —
      // a box with no ESP32 attached simply never records highlights.
      // Highlight capture subsystem — wired up ONLY when enabled, so a box with
      // highlights off has ZERO new runtime behavior (no serial port opened, no
      // capture pipeline, no logs). When on, enablement is still gated further
      // by ESP32 presence inside StartStreamUseCase.
      const highlightConfig = config.get().highlight;
      if (highlightConfig.enabled) {
        this.highlightSignalSource = new SerialHighlightListener(
          highlightConfig.serialPortPath,
          highlightConfig.serialBaudRate,
          this.logger,
          highlightConfig.forcePresent,
          highlightConfig.triggerFile
        );
        this.highlightSignalSource.start();

        // Capture pipeline: signal → cut window → (reframe) → overlay logos.
        const highlightExtractor = new HighlightExtractorService(
          highlightConfig.outputDir,
          this.logger
        );
        // Ball-tracking reframer: real Python/OpenCV impl only when enabled,
        // else a no-op (full-frame). Off by default until tuned on real footage.
        const ballReframer = highlightConfig.ballTracking.enabled
          ? new PythonBallReframer(highlightConfig.reelAspect, this.logger)
          : new NullBallReframer();
        const highlightRenderer = new HighlightRendererService(
          path.resolve("./public/ds.png"),
          path.resolve(config.get().images.clientPath),
          this.logger
        );
        const captureHighlightUseCase = new CaptureHighlightUseCase(
          this.highlightBufferRegistry,
          highlightExtractor,
          ballReframer,
          highlightRenderer,
          this.logger
        );
        // One box runs one active stream, so route a highlight to whichever
        // court is currently running. If none is live, nothing to capture.
        this.highlightSignalSource.onHighlight(async ({ receivedAtMs }) => {
          try {
            const running = await streamRepository.findRunning();
            if (running.length === 0) {
              this.logger.warn("Highlight signal ignored: no running stream");
              return;
            }
            await captureHighlightUseCase.execute({
              courtId: running[0].courtId,
              receivedAtMs,
            });
          } catch (error) {
            this.logger.error("Highlight capture handler failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
      }

      // Initialize use cases
      const startStreamUseCase = new StartStreamUseCase(
        streamRepository,
        ffmpegService,
        this.logger,
        this.httpClient,
        adDownloader,
        this.adRotationRegistry,
        this.highlightBufferRegistry,
        this.highlightSignalSource
      );

      const stopStreamUseCase = new StopStreamUseCase(
        streamRepository,
        ffmpegService,
        this.logger,
        this.adRotationRegistry,
        this.highlightBufferRegistry
      );

      // Initialize Supabase Listener (if enabled)
      const supabaseConfig = config.get().supabase;
      let supabaseListener: SupabaseListener | undefined;

      if (supabaseConfig.enabled) {
        this.logger.info("Initializing Supabase services...");
        
        SupabaseService.initialize(
          supabaseConfig.url,
          supabaseConfig.anonKey,
          supabaseConfig.enabled
        );

        supabaseListener = new SupabaseListener(
          supabaseConfig.channelName,
          supabaseConfig.tableName
        );
        this.logger.info("SupabaseListener initialized");
      } else {
        this.logger.info("Supabase is disabled via configuration");
      }

      // Initialize stream manager
      this.streamManager = new StreamManagerService(
        streamRepository,
        ffmpegService,
        sseService,
        startStreamUseCase,
        stopStreamUseCase,
        this.logger,
        config,
        this.httpClient,
        supabaseListener
      );

      // Start the stream manager
      await this.streamManager.start();

      this.logger.info("Streamer Node Application started successfully");

      // Setup graceful shutdown
      this.setupGracefulShutdown();
    } catch (error) {
      this.logger.error("Failed to start application", {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    }
  }

  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      this.logger.info(`Received ${signal}, shutting down gracefully`);

      try {
        // Stop all ad rotation timers before tearing down streams.
        this.adRotationRegistry.stopAll();
        // Stop all highlight buffer retention sweeps.
        this.highlightBufferRegistry.stopAll();
        if (this.streamManager) {
          await this.streamManager.stop();
        }
        if (this.supabaseListener) { // Keep this just in case, though StreamManager handles unsub
          await this.supabaseListener.stop();
        }
        if (this.highlightSignalSource) {
          this.highlightSignalSource.stop();
        }
        this.logger.info("Application shutdown completed");
        process.exit(0);
      } catch (error) {
        this.logger.error("Error during shutdown", {
          error: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
      }
    };

    // Handle different shutdown signals
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGUSR2", () => shutdown("SIGUSR2")); // nodemon restart

    // Handle uncaught exceptions
    process.on("uncaughtException", (error) => {
      this.logger.error("Uncaught exception", { error: error.message });
      process.exit(1);
    });

    process.on("unhandledRejection", (reason) => {
      this.logger.error("Unhandled rejection", { reason });
      process.exit(1);
    });
  }
}

// Start the application
const app = new Application();
app.start().catch((error) => {
  console.error("Failed to start application:", error);
  process.exit(1);
});
