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
import { YouTubeUploadService } from "./infrastructure/services/YouTubeUploadService";
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
      streamingApiKey: Config.getInstance().get().server.streamingApiKey,
    },
    "debug"
  );
  private readonly httpClient = new HttpClient();
  /** Last state forwarded per court, to suppress redundant identical writes. */
  private readonly lastScoreByCourt = new Map<string, string>();
  /** Courts the backend has rejected, so we stop retrying them every packet. */
  private readonly rejectedScoreCourts = new Set<string>();

  /**
   * Forward score packets from the court hardware to the backend, which writes
   * them to Supabase — the single source of truth the scorecard overlay already
   * reads. The streamer is a bridge here, not a second source.
   *
   * ── WHY THE DEDUPE AND THE REJECT-SET ──
   * At a multi-court venue this ESP32 also relays the NEIGHBOURING court's
   * traffic (shared mesh credentials; the firmware does no filtering). We can't
   * filter locally — we don't know which courts belong to this ground — so the
   * backend validates it. But an un-suppressed reject would then POST and 400
   * on every packet from that court, forever. First rejection is logged, then
   * that court is dropped silently.
   *
   * ── DO NOT ──
   * - Do NOT throw from here. A scoring failure must never disturb the live
   *   stream; every path swallows and logs.
   */
  private wireScoreForwarding(groundId: string): void {
    if (!this.highlightSignalSource) return;
    this.logger.info("ESP32 score forwarding enabled", { groundId });

    this.highlightSignalSource.onScore(async (score) => {
      try {
        if (this.rejectedScoreCourts.has(score.courtId)) return;

        // Absolute state — identical repeats carry no information.
        const fingerprint = JSON.stringify([
          score.mode,
          score.scoreA,
          score.scoreB,
          score.gamesA,
          score.gamesB,
        ]);
        if (this.lastScoreByCourt.get(score.courtId) === fingerprint) return;

        // Firmware mode -> the backend's enum. Unknown/absent is omitted so the
        // existing row keeps its mode rather than being forced to a guess.
        const mode =
          score.mode === "AMER"
            ? "americano"
            : score.mode === "TENNIS"
              ? "standard"
              : undefined;

        const res = await this.httpClient.postScoreboard(groundId, score.courtId, {
          mode,
          // A -> red (left/top), B -> blue (right/bottom), matching the overlay.
          redScore: score.scoreA,
          blueScore: score.scoreB,
          redGames: score.gamesA,
          blueGames: score.gamesB,
        });

        if (res.ok) {
          this.lastScoreByCourt.set(score.courtId, fingerprint);
          return;
        }

        // 400/404 = this court isn't ours (mesh bleed from another ground).
        // Expected at shared venues; log once, then ignore that court.
        if (res.status === 400 || res.status === 404) {
          this.rejectedScoreCourts.add(score.courtId);
          this.logger.info(
            "Ignoring score for a court the backend does not recognise for this ground",
            { courtId: score.courtId, status: res.status }
          );
          return;
        }
        this.logger.warn("Score forward failed", {
          courtId: score.courtId,
          status: res.status,
        });
      } catch (error) {
        this.logger.warn("Score forward errored", {
          courtId: score.courtId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

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
      const esp32Config = config.get().esp32;

      // ONE device, ONE reader. The ESP32 carries both the highlight button and
      // the score packets, and a serial port can only be held by one consumer —
      // so the listener is opened when EITHER feature is on, and each subscribes
      // to the events it cares about. With both off, nothing is opened at all
      // and the box has zero new runtime behaviour.
      if (highlightConfig.enabled || esp32Config.scoreForwardingEnabled) {
        this.highlightSignalSource = new SerialHighlightListener(
          highlightConfig.serialPortPath,
          highlightConfig.serialBaudRate,
          this.logger,
          highlightConfig.forcePresent,
          highlightConfig.triggerFile
        );
        this.highlightSignalSource.start();

        if (esp32Config.scoreForwardingEnabled) {
          this.wireScoreForwarding(config.get().groundInfo.groundId);
        }
      }

      if (highlightConfig.enabled && this.highlightSignalSource) {

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
        // Optional YouTube upload of the finished reel. Only built when enabled
        // AND a streaming key is configured; otherwise reels stay on disk only.
        const serverCfg = config.get().server;
        const highlightUploader =
          highlightConfig.uploadEnabled && serverCfg.streamingApiKey
            ? new YouTubeUploadService(
                serverCfg.baseUrl,
                config.get().groundInfo.groundId,
                serverCfg.streamingApiKey,
                this.logger
              )
            : null;
        // Route a highlight to the court the press actually came from.
        //
        // COURT FILTERING IS LOAD-BEARING, not a nicety: every unit ships with
        // the same mesh credentials, so at a venue with two courts in WiFi
        // range this box's ESP32 relays the neighbouring court's button presses
        // verbatim. Taking `running[0]` unconditionally would cut a clip from
        // the wrong court's stream with nothing in the logs to explain it.
        // A signal with no courtId is a debug trigger (force/trigger-file) and
        // falls back to the single running stream.
        this.highlightSignalSource.onHighlight(async ({ receivedAtMs, courtId }) => {
          try {
            const running = await streamRepository.findRunning();
            if (running.length === 0) {
              this.logger.warn("Highlight signal ignored: no running stream", {
                courtId,
              });
              return;
            }
            const court = courtId
              ? running.find((s) => s.courtId === courtId)
              : running[0];
            if (!court) {
              // Almost always a neighbouring court's press bleeding over the
              // shared mesh — expected at multi-court venues, not an error.
              this.logger.info(
                "Highlight signal ignored: press is for another court",
                { pressCourtId: courtId, running: running.map((s) => s.courtId) }
              );
              return;
            }
            const result = await captureHighlightUseCase.execute({
              courtId: court.courtId,
              receivedAtMs,
            });
            // Upload is a best-effort, additive step: it runs only on a
            // successful capture and its failure never affects the on-disk reel
            // (the uploader is fully fail-soft). streamKey is required by the
            // backend to resolve the video's privacy.
            if (result && highlightUploader) {
              await highlightUploader.upload({
                filePath: result.finalPath,
                courtId: court.courtId,
                streamKey: court.streamKey,
                title: `DropShot highlight — ${court.courtId}`,
                preferShort: true,
              });
            }
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
