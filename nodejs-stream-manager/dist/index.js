#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StreamManagerApp = void 0;
const Logger_1 = require("./utils/Logger");
const ConfigManager_1 = require("./utils/ConfigManager");
const StreamManager_1 = require("./utils/StreamManager");
const HealthMonitor_1 = require("./utils/HealthMonitor");
const PerformanceOptimizer_1 = require("./utils/PerformanceOptimizer");
const ResourceMonitor_1 = require("./utils/ResourceMonitor");
const SystemOptimizer_1 = require("./utils/SystemOptimizer");
const SSEClient_1 = require("./utils/SSEClient");
class StreamManagerApp {
    constructor() {
        this.isShuttingDown = false;
        this.processedEvents = new Set();
        this.logger = Logger_1.Logger.getInstance();
        this.config = ConfigManager_1.ConfigManager.getInstance();
        if (!this.config.validateConfig()) {
            throw new Error("Invalid configuration");
        }
        this.config.ensureDirectories();
        this.streamManager = new StreamManager_1.StreamManager();
        this.healthMonitor = new HealthMonitor_1.HealthMonitor(this.logger);
        this.performanceOptimizer = new PerformanceOptimizer_1.PerformanceOptimizer();
        this.resourceMonitor = new ResourceMonitor_1.ResourceMonitor();
        this.systemOptimizer = new SystemOptimizer_1.SystemOptimizer(this.logger, this.config);
        const serverConfig = this.config.get("server");
        this.sseClient = new SSEClient_1.SSEClient(serverConfig.sseUrl);
        this.setupEventHandlers();
    }
    setupEventHandlers() {
        this.sseClient.on("connected", () => {
            this.logger.info("Connected to SSE server");
        });
        this.sseClient.on("disconnected", () => {
            this.logger.warn("Disconnected from SSE server");
        });
        this.sseClient.on("error", (error) => {
            this.logger.error("SSE connection error", error);
        });
        this.sseClient.on("message", (event) => {
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
            const eventHash = this.generateEventHash(event);
            if (this.processedEvents.has(eventHash)) {
                this.logger.debug('Duplicate SSE event detected, skipping', {
                    eventType: event.eventType,
                    streamId: event.data.streamId,
                    hash: eventHash
                });
                return;
            }
            this.processedEvents.add(eventHash);
            this.logger.info(`Processing SSE event: ${event.eventType}`, {
                event: {
                    eventType: event.eventType,
                    streamId: event.data.streamId,
                    timestamp: event.timestamp
                }
            });
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
                        this.streamManager.startStream(event.data.streamId, event.data.rtspUrl, event.data.rtmpUrl);
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
                        this.logger.info(`Received ${event.eventType} event`, { event });
                        break;
                    default:
                        this.logger.warn(`Unknown SSE event type: ${event.eventType}`, {
                            eventType: event.eventType,
                            availableTypes: ['start', 'stop', 'restart', 'health', 'config', 'system']
                        });
                }
            }
            catch (error) {
                this.logger.error(`Error processing SSE event: ${event.eventType} for stream ${event.data.streamId}`, error instanceof Error ? error : new Error(String(error)));
            }
        });
        this.resourceMonitor.on("alert", (alert) => {
            this.logger.warn(`Resource alert: ${alert.message}`, { alert });
        });
        process.on("SIGINT", () => this.shutdown());
        process.on("SIGTERM", () => this.shutdown());
        process.on("uncaughtException", (error) => {
            this.logger.error("Uncaught exception", error);
            this.shutdown();
        });
        process.on("unhandledRejection", (reason) => {
            this.logger.error("Unhandled rejection", new Error(String(reason)));
            this.shutdown();
        });
    }
    async start() {
        try {
            this.logger.info("Starting Node.js Stream Manager");
            this.healthMonitor.start();
            this.resourceMonitor.startMonitoring();
            await this.systemOptimizer.applyOptimizations();
            await this.streamManager.start();
            this.sseClient.connect();
            this.startEventCacheCleanup();
            this.logger.info("All services started successfully");
        }
        catch (error) {
            this.logger.error("Failed to start services", error);
            process.exit(1);
        }
    }
    async shutdown() {
        if (this.isShuttingDown) {
            return;
        }
        this.isShuttingDown = true;
        this.logger.info("Shutting down Node.js Stream Manager");
        try {
            this.sseClient.disconnect();
            this.stopEventCacheCleanup();
            this.healthMonitor.stop();
            this.resourceMonitor.stopMonitoring();
            await this.streamManager.shutdown();
            this.logger.info("Shutdown completed successfully");
            process.exit(0);
        }
        catch (error) {
            this.logger.error("Error during shutdown", error);
            process.exit(1);
        }
    }
    generateEventHash(event) {
        const hashData = {
            eventType: event.eventType,
            streamId: event.data?.streamId || 'unknown',
            timestamp: event.timestamp ? new Date(event.timestamp).getTime() : Date.now()
        };
        return Buffer.from(JSON.stringify(hashData)).toString('base64');
    }
    startEventCacheCleanup() {
        this.eventCacheCleanupInterval = setInterval(() => {
            const cacheSize = this.processedEvents.size;
            if (cacheSize > 1000) {
                const eventsArray = Array.from(this.processedEvents);
                const toKeep = eventsArray.slice(Math.floor(eventsArray.length / 2));
                this.processedEvents.clear();
                toKeep.forEach(event => this.processedEvents.add(event));
                this.logger.debug(`Cleaned up event cache: ${cacheSize} -> ${this.processedEvents.size}`);
            }
        }, 5 * 60 * 1000);
    }
    stopEventCacheCleanup() {
        if (this.eventCacheCleanupInterval) {
            clearInterval(this.eventCacheCleanupInterval);
            this.eventCacheCleanupInterval = undefined;
        }
    }
    getStatus() {
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
exports.StreamManagerApp = StreamManagerApp;
const app = new StreamManagerApp();
app.start().catch((error) => {
    console.error("Failed to start application:", error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map