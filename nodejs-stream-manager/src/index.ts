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
  private processedEvents = new Set<string>();
  private eventCacheCleanupInterval: NodeJS.Timeout | undefined;

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
      // Validate event structure
      if (!event || typeof event !== 'object') {
        this.logger.warn('Received invalid SSE event: not an object', { event });
        return;
      }

      if (!event.eventType) {
        this.logger.warn('Received SSE event without eventType', { event });
        return;
      }

      if (!event.data || typeof event.data !== 'object') {
        this.logger.warn('Received SSE event without valid data', { event });
        return;
      }

      // Generate event hash for duplicate detection
      const eventHash = this.generateEventHash(event);
      
      // Check for duplicate events
      if (this.processedEvents.has(eventHash)) {
        this.logger.debug('Duplicate SSE event detected, skipping', { 
          eventType: event.eventType, 
          streamId: event.data.streamId,
          hash: eventHash 
        });
        return;
      }

      // Add to processed events cache
      this.processedEvents.add(eventHash);

      this.logger.info(`Processing SSE event: ${event.eventType}`, { 
        event: {
          eventType: event.eventType,
          streamId: event.data.streamId,
          timestamp: event.timestamp
        }
      });

      // Process the event based on type
      try {
        switch (event.eventType) {
          case "start":
            if (!event.data.streamId || !event.data.rtspUrl || !event.data.rtmpUrl) {
              this.logger.warn('Start event missing required data fields', { 
                streamId: event.data.streamId,
                rtspUrl: event.data.rtspUrl ? 'present' : 'missing',
                rtmpUrl: event.data.rtmpUrl ? 'present' : 'missing'
              });
              return;
            }
            this.streamManager.startStream(
              event.data.streamId,
              event.data.rtspUrl,
              event.data.rtmpUrl
            );
            break;
          case "stop":
            if (!event.data.streamId) {
              this.logger.warn('Stop event missing streamId', { event });
              return;
            }
            this.streamManager.stopStream(event.data.streamId);
            break;
          case "restart":
            if (!event.data.streamId) {
              this.logger.warn('Restart event missing streamId', { event });
              return;
            }
            this.streamManager.restartStream(event.data.streamId);
            break;
          case "health":
          case "config":
          case "system":
            // Handle non-stream events
            this.logger.info(`Received ${event.eventType} event`, { event });
            break;
          default:
            this.logger.warn(`Unknown SSE event type: ${event.eventType}`, { 
              eventType: event.eventType,
              availableTypes: ['start', 'stop', 'restart', 'health', 'config', 'system']
            });
        }
      } catch (error) {
           this.logger.error(`Error processing SSE event: ${event.eventType} for stream ${event.data.streamId}`, error instanceof Error ? error : new Error(String(error)));
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

      // Start event cache cleanup
      this.startEventCacheCleanup();

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

      // Stop event cache cleanup
      this.stopEventCacheCleanup();

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

  private generateEventHash(event: SSEEvent): string {
    // Create a hash based on event type, stream ID, and timestamp
    const hashData = {
      eventType: event.eventType,
      streamId: event.data?.streamId || 'unknown',
      timestamp: event.timestamp ? new Date(event.timestamp).getTime() : Date.now()
    };
    
    // Simple hash generation (in production, consider using crypto.createHash)
    return Buffer.from(JSON.stringify(hashData)).toString('base64');
  }

  private startEventCacheCleanup(): void {
    // Clean up processed events cache every 5 minutes to prevent memory leaks
    this.eventCacheCleanupInterval = setInterval(() => {
      const cacheSize = this.processedEvents.size;
      if (cacheSize > 1000) {
        // Clear half of the cache when it gets too large
        const eventsArray = Array.from(this.processedEvents);
        const toKeep = eventsArray.slice(Math.floor(eventsArray.length / 2));
        this.processedEvents.clear();
        toKeep.forEach(event => this.processedEvents.add(event));
        this.logger.debug(`Cleaned up event cache: ${cacheSize} -> ${this.processedEvents.size}`);
      }
    }, 5 * 60 * 1000); // 5 minutes
  }

  private stopEventCacheCleanup(): void {
    if (this.eventCacheCleanupInterval) {
      clearInterval(this.eventCacheCleanupInterval);
      this.eventCacheCleanupInterval = undefined;
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
