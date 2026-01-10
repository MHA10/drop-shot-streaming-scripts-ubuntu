#!/usr/bin/env node

import * as packageJson from "../package.json";
import { Config } from "./infrastructure/config/Config";
import { FileSystemStreamRepository } from "./infrastructure/repositories/FileSystemStreamRepository";
import { NodeFFmpegService } from "./infrastructure/services/NodeFFmpegService";
import { NodeSSEService } from "./infrastructure/services/NodeSSEService";
import { StartStreamUseCase } from "./application/use-cases/StartStreamUseCase";
import { StopStreamUseCase } from "./application/use-cases/StopStreamUseCase";
import { StreamManagerService } from "./application/services/StreamManagerService";
import { HttpClient } from "./application/services/HttpClient";
import { RemoteLogger } from "./infrastructure/logging/RemoteLogger";
import { SupabaseService } from "./infrastructure/services/SupabaseService";
import { SupabaseListener } from "./infrastructure/listeners/SupabaseListener";

class Application {
  private streamManager?: StreamManagerService;
  private supabaseListener?: SupabaseListener;
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

      // Initialize use cases
      const startStreamUseCase = new StartStreamUseCase(
        streamRepository,
        ffmpegService,
        this.logger,
        this.httpClient
      );

      const stopStreamUseCase = new StopStreamUseCase(
        streamRepository,
        ffmpegService,
        this.logger
      );

      // Initialize stream manager
      this.streamManager = new StreamManagerService(
        streamRepository,
        ffmpegService,
        sseService,
        startStreamUseCase,
        stopStreamUseCase,
        this.logger,
        config,
        this.httpClient
      );

      // Initialize Supabase (optional feature) - before stream manager to avoid hanging
      this.initializeSupabase(config);

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

  private initializeSupabase(config: Config): void {
    try {
      const supabaseConfig = config.get().supabase;

      this.logger.info("Starting Supabase initialization", {
        enabled: supabaseConfig.enabled,
        tableName: supabaseConfig.tableName,
        channelName: supabaseConfig.channelName,
      });

      // Initialize Supabase service
      SupabaseService.initialize(
        supabaseConfig.url,
        supabaseConfig.anonKey,
        supabaseConfig.enabled
      );

      this.logger.info("SupabaseService initialized");

      // Only create and start listener if Supabase is enabled
      if (supabaseConfig.enabled) {
        this.logger.info("Initializing Supabase real-time listener");
        
        this.supabaseListener = new SupabaseListener(
          supabaseConfig.channelName,
          supabaseConfig.tableName
        );
        
        this.logger.info("SupabaseListener created, starting...");
        
        this.supabaseListener.start();
        this.logger.info("Supabase listener started successfully");
      } else {
        this.logger.info("Supabase is disabled via configuration");
      }
    } catch (error) {
      this.logger.error("Failed to initialize Supabase listener", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      this.logger.info("Application will continue without Supabase features");
    }
  }

  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      this.logger.info(`Received ${signal}, shutting down gracefully`);

      try {
        if (this.streamManager) {
          await this.streamManager.stop();
        }
        if (this.supabaseListener) {
          await this.supabaseListener.stop();
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
