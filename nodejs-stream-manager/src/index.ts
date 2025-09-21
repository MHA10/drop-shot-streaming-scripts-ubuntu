#!/usr/bin/env node

import { Logger } from "./utils/Logger";
import { ConfigManager } from "./utils/ConfigManager";
import { StreamManager } from "./utils/StreamManager";
import { HealthMonitor } from "./utils/HealthMonitor";
import { PerformanceOptimizer } from "./utils/PerformanceOptimizer";
import { ResourceMonitor } from "./utils/ResourceMonitor";
import { SystemOptimizer } from "./utils/SystemOptimizer";
import { SSEClient } from "./utils/SSEClient";
import { SSEEvent } from "./types";

class StreamManagerApp {
  private logger: Logger;
  private config: ConfigManager;
  private streamManager: StreamManager;
  private healthMonitor: HealthMonitor;
  private performanceOptimizer: PerformanceOptimizer;
  private resourceMonitor: ResourceMonitor;
  private sseClient: SSEClient;
  private systemOptimizer: SystemOptimizer;
  private isShuttingDown = false;

  constructor() {
    // Initialize logger using singleton pattern
    this.logger = Logger.getInstance();

    // Initialize config manager
    this.config = ConfigManager.getInstance();

    // Validate and ensure directories exist
    if (!this.config.validateConfig()) {
      throw new Error("Invalid configuration");
    }
    this.config.ensureDirectories();

    // Initialize components with proper parameters
    this.streamManager = new StreamManager();
    this.healthMonitor = new HealthMonitor(this.logger);
    this.performanceOptimizer = new PerformanceOptimizer();
    this.resourceMonitor = new ResourceMonitor();
    this.systemOptimizer = new SystemOptimizer(this.logger, this.config);

    // Initialize SSE client with server config
    const serverConfig = this.config.get("server");
    this.sseClient = new SSEClient(serverConfig.sseUrl);

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    // SSE event handlers
    this.sseClient.on("connected", () => {
      this.logger.info("Connected to SSE server");
    });

    this.sseClient.on("disconnected", () => {
      this.logger.warn("Disconnected from SSE server");
    });

    this.sseClient.on("error", (error: Error) => {
      this.logger.error("SSE connection error", error);
    });

    this.sseClient.on("message", (event: SSEEvent) => {
      this.logger.info(`Received SSE event: ${event.eventType}`, { event });

      switch (event.eventType) {
        case "start":
          this.streamManager.startStream(
            event.data.streamId,
            event.data.rtspUrl,
            event.data.rtmpUrl
          );
          break;
        case "stop":
          this.streamManager.stopStream(event.data.streamId);
          break;
        default:
          this.logger.warn(`Unknown SSE event type: ${event.eventType}`);
      }
    });

    // Resource monitoring events
    this.resourceMonitor.on("alert", (alert) => {
      this.logger.warn(`Resource alert: ${alert.message}`, { alert });
    });

    // Process signal handlers
    process.on("SIGINT", () => this.shutdown());
    process.on("SIGTERM", () => this.shutdown());
    process.on("uncaughtException", (error: Error) => {
      this.logger.error("Uncaught exception", error);
      this.shutdown();
    });
    process.on("unhandledRejection", (reason: any) => {
      this.logger.error("Unhandled rejection", new Error(String(reason)));
      this.shutdown();
    });
  }

  async start(): Promise<void> {
    try {
      this.logger.info("Starting Node.js Stream Manager");

      // Start health monitoring
      this.healthMonitor.start();

      // Start resource monitoring
      this.resourceMonitor.startMonitoring();

      // Apply system optimizations
      await this.systemOptimizer.applyOptimizations();

      // Start stream manager
      await this.streamManager.start();

      // Connect to SSE server
      this.sseClient.connect();

      this.logger.info("All services started successfully");
    } catch (error) {
      this.logger.error("Failed to start services", error as Error);
      process.exit(1);
    }
  }

  async shutdown(): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    this.isShuttingDown = true;
    this.logger.info("Shutting down Node.js Stream Manager");

    try {
      // Stop SSE client
      this.sseClient.disconnect();

      // Stop monitoring services
      this.healthMonitor.stop();
      this.resourceMonitor.stopMonitoring();

      // Stop stream manager
      await this.streamManager.shutdown();

      this.logger.info("Shutdown completed successfully");
      process.exit(0);
    } catch (error) {
      this.logger.error("Error during shutdown", error as Error);
      process.exit(1);
    }
  }

  getStatus(): any {
    const activeStreams = this.streamManager.getActiveStreams();
    const streamCount = activeStreams.size;

    return {
      status: "running",
      uptime: process.uptime(),
      activeStreams: streamCount,
      memory: process.memoryUsage(),
      isConnectedToSSE: this.sseClient.isConnected,
    };
  }
}

// Create and start the application
const app = new StreamManagerApp();
app.start().catch((error) => {
  console.error("Failed to start application:", error);
  process.exit(1);
});

export { StreamManagerApp };
