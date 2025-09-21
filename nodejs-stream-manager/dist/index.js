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
            this.logger.info(`Received SSE event: ${event.eventType}`, { event });
            switch (event.eventType) {
                case "start":
                    this.streamManager.startStream(event.data.streamId, event.data.rtspUrl, event.data.rtmpUrl);
                    break;
                case "stop":
                    this.streamManager.stopStream(event.data.streamId);
                    break;
                case "restart":
                    this.streamManager.restartStream(event.data.streamId);
                    break;
                default:
                    this.logger.warn(`Unknown SSE event type: ${event.eventType}`);
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