#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StreamManagerApp = void 0;
const StreamManager_1 = require("./core/StreamManager");
const SSEClient_1 = require("./services/SSEClient");
const HealthMonitor_1 = require("./services/HealthMonitor");
const Logger_1 = require("./utils/Logger");
const ConfigManager_1 = require("./utils/ConfigManager");
const PerformanceOptimizer_1 = require("./utils/PerformanceOptimizer");
const ResourceMonitor_1 = require("./utils/ResourceMonitor");
const SystemOptimizer_1 = require("./utils/SystemOptimizer");
class StreamManagerApp {
    constructor() {
        this.isShuttingDown = false;
        this.logger = new Logger_1.Logger('StreamManagerApp');
        this.config = ConfigManager_1.ConfigManager.getInstance();
        this.streamManager = new StreamManager_1.StreamManager();
        this.sseClient = new SSEClient_1.SSEClient();
        this.healthMonitor = new HealthMonitor_1.HealthMonitor();
        this.performanceOptimizer = new PerformanceOptimizer_1.PerformanceOptimizer(this.logger, this.config);
        this.resourceMonitor = new ResourceMonitor_1.ResourceMonitor(this.logger, this.config, this.performanceOptimizer);
        this.systemOptimizer = new SystemOptimizer_1.SystemOptimizer(this.logger, this.config);
    }
    async start() {
        try {
            this.logger.info('Starting Streaming Application', {
                version: process.env.npm_package_version || '1.0.0',
                nodeVersion: process.version,
                platform: process.platform,
                arch: process.arch
            });
            this.setupSignalHandlers();
            await this.systemOptimizer.initialize();
            await this.systemOptimizer.applyOptimizations();
            this.healthMonitor.startMonitoring();
            this.setupResourceMonitoring();
            await this.setupSSEClient();
            await this.recoverStreams();
            this.logger.info('Streaming Application started successfully');
        }
        catch (error) {
            this.logger.error('Failed to start application', error);
            process.exit(1);
        }
    }
    async setupSSEClient() {
        try {
            this.sseClient.onMessage('stream-start', async (streamConfig) => {
                this.logger.info('Processing stream start request', { streamId: streamConfig.id });
                const success = await this.streamManager.startStream(streamConfig);
                if (!success) {
                    this.logger.error('Failed to start stream from SSE command', undefined, {
                        streamId: streamConfig.id
                    });
                }
            });
            this.sseClient.onMessage('stream-stop', async (data) => {
                this.logger.info('Processing stream stop request', { streamId: data.streamId });
                const success = this.streamManager.stopStream(data.streamId);
                if (!success) {
                    this.logger.error('Failed to stop stream from SSE command', undefined, {
                        streamId: data.streamId
                    });
                }
            });
            this.sseClient.onMessage('stream-restart', async (data) => {
                this.logger.info('Processing stream restart request', { streamId: data.streamId });
                const success = await this.streamManager.restartStream(data.streamId);
                if (!success) {
                    this.logger.error('Failed to restart stream from SSE command', undefined, {
                        streamId: data.streamId
                    });
                }
            });
            this.sseClient.onMessage('health-check', async () => {
                this.logger.debug('Processing health check request');
                const report = await this.healthMonitor.getDetailedReport();
                this.logger.info('Health check completed', {
                    streams: report.streams,
                    systemHealth: {
                        cpu: report.system.cpu.usage,
                        memory: report.system.memory.percentage,
                        disk: report.system.disk.percentage
                    }
                });
            });
            this.sseClient.onMessage('config-update', (configUpdate) => {
                this.logger.info('Processing config update request');
                try {
                    ConfigManager_1.ConfigManager.getInstance().updateConfig(configUpdate);
                    this.logger.info('Configuration updated successfully');
                }
                catch (error) {
                    this.logger.error('Failed to update configuration', error);
                }
            });
            this.sseClient.onMessage('system-command', async (data) => {
                this.logger.info('Processing system command', { command: data.command });
                try {
                    switch (data.command) {
                        case 'restart-all-streams':
                            await this.restartAllStreams();
                            break;
                        case 'stop-all-streams':
                            await this.stopAllStreams();
                            break;
                        case 'validate-streams':
                            await this.streamManager.validateAndRecoverStreams();
                            break;
                        case 'get-status':
                            const status = this.streamManager.getSystemStats();
                            this.logger.info('System status', status);
                            break;
                        default:
                            this.logger.warn('Unknown system command', { command: data.command });
                    }
                }
                catch (error) {
                    this.logger.error('Failed to execute system command', error, {
                        command: data.command
                    });
                }
            });
            if (this.config.server.sseUrl) {
                await this.sseClient.connect();
                this.logger.info('Connected to SSE server');
            }
            else {
                this.logger.info('SSE URL not configured, running in standalone mode');
            }
        }
        catch (error) {
            this.logger.warn('Failed to setup SSE client, continuing in standalone mode', {
                error: error instanceof Error ? error.message : 'Unknown error'
            });
        }
    }
    setupResourceMonitoring() {
        const monitoringInterval = this.config.get().monitoring?.interval || 30000;
        this.resourceMonitor.startMonitoring(monitoringInterval);
        this.resourceMonitor.on('resource_alert', (alert) => {
            this.logger.warn('Resource alert', { alert });
            if (this.sseClient.isConnected()) {
                this.sseClient.send({
                    type: 'resource_alert',
                    data: alert,
                    timestamp: new Date().toISOString(),
                });
            }
        });
        this.resourceMonitor.on('critical_memory', async () => {
            this.logger.error('Critical memory situation - reducing load');
            await this.handleCriticalMemory();
        });
        this.resourceMonitor.on('critical_cpu', async () => {
            this.logger.error('Critical CPU situation - reducing quality');
            await this.handleCriticalCpu();
        });
        this.resourceMonitor.on('critical_temperature', async () => {
            this.logger.error('Critical temperature - emergency cooling');
            await this.handleCriticalTemperature();
        });
        this.resourceMonitor.on('critical_disk', async () => {
            this.logger.error('Critical disk space - cleanup required');
            await this.handleCriticalDisk();
        });
        this.resourceMonitor.on('monitoring_started', (info) => {
            this.logger.info('Resource monitoring started', info);
        });
        this.resourceMonitor.on('metrics_updated', (metrics) => {
            this.logger.debug('Resource metrics updated', {
                memory: `${metrics.memory.usage}%`,
                cpu: `${metrics.cpu.usage}%`,
                temperature: `${metrics.cpu.temperature}°C`,
                disk: `${metrics.disk.usage}%`,
            });
        });
    }
    async handleCriticalMemory() {
        const streams = this.streamManager.getAllStreamStatuses();
        const runningStreams = streams.filter(s => s.status === 'running');
        if (runningStreams.length > 0) {
            const streamToStop = runningStreams[runningStreams.length - 1];
            this.logger.warn('Stopping stream due to critical memory', { streamId: streamToStop.id });
            this.streamManager.stopStream(streamToStop.id);
        }
    }
    async handleCriticalCpu() {
        const streams = this.streamManager.getAllStreamStatuses();
        const runningStreams = streams.filter(s => s.status === 'running');
        for (const stream of runningStreams) {
            try {
                this.logger.info('Would reduce quality for stream', { streamId: stream.id });
            }
            catch (error) {
                this.logger.error('Failed to reduce stream quality', error, { streamId: stream.id });
            }
        }
    }
    async handleCriticalTemperature() {
        this.logger.error('Emergency stop due to critical temperature');
        await this.stopAllStreams();
    }
    async handleCriticalDisk() {
        try {
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);
            const logsPath = this.config.get().logging?.directory || '/var/log/stream-manager';
            await execAsync(`find ${logsPath} -name "*.log" -mtime +3 -delete`);
            this.logger.info('Cleaned up old log files due to critical disk space');
        }
        catch (error) {
            this.logger.warn('Failed to clean up logs', { error });
        }
    }
    async recoverStreams() {
        try {
            this.logger.info('Checking for stream recovery');
            const isBootRecovery = await this.detectBootRecovery();
            if (isBootRecovery) {
                await this.streamManager.recoverFromBoot();
            }
            else {
                await this.streamManager.validateAndRecoverStreams();
            }
        }
        catch (error) {
            this.logger.error('Failed to recover streams', error);
        }
    }
    async detectBootRecovery() {
        try {
            const uptime = process.uptime();
            const isRecentBoot = uptime < 300;
            if (isRecentBoot) {
                this.logger.info('Recent system boot detected, initiating stream recovery', {
                    uptime: Math.round(uptime)
                });
                return true;
            }
            return false;
        }
        catch (error) {
            this.logger.debug('Failed to detect boot recovery', { error });
            return false;
        }
    }
    async restartAllStreams() {
        this.logger.info('Restarting all streams');
        const allStreams = this.streamManager.getAllStreamStatuses();
        for (const stream of allStreams) {
            try {
                await this.streamManager.restartStream(stream.id);
                await this.sleep(1000);
            }
            catch (error) {
                this.logger.error('Failed to restart stream', error, {
                    streamId: stream.id
                });
            }
        }
    }
    async stopAllStreams() {
        this.logger.info('Stopping all streams');
        const allStreams = this.streamManager.getAllStreamStatuses();
        for (const stream of allStreams) {
            try {
                this.streamManager.stopStream(stream.id);
            }
            catch (error) {
                this.logger.error('Failed to stop stream', error, {
                    streamId: stream.id
                });
            }
        }
    }
    setupSignalHandlers() {
        const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
        signals.forEach(signal => {
            process.on(signal, () => {
                this.logger.info(`Received ${signal}, initiating graceful shutdown`);
                this.shutdown();
            });
        });
        process.on('uncaughtException', (error) => {
            this.logger.error('Uncaught exception', error);
            this.shutdown(1);
        });
        process.on('unhandledRejection', (reason, promise) => {
            this.logger.error('Unhandled rejection', new Error(String(reason)), {
                promise: promise.toString()
            });
            this.shutdown(1);
        });
    }
    async shutdown(exitCode = 0) {
        if (this.isShuttingDown) {
            return;
        }
        this.isShuttingDown = true;
        this.logger.info('Shutting down application');
        try {
            this.resourceMonitor.destroy();
            this.healthMonitor.cleanup();
            this.sseClient.cleanup();
            await this.stopAllStreams();
            this.streamManager.cleanup();
            this.performanceOptimizer.destroy();
            this.systemOptimizer.destroy();
            this.logger.info('Application shutdown complete');
            setTimeout(() => {
                process.exit(exitCode);
            }, 1000);
        }
        catch (error) {
            this.logger.error('Error during shutdown', error);
            process.exit(1);
        }
    }
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
exports.StreamManagerApp = StreamManagerApp;
if (require.main === module) {
    const app = new StreamManagerApp();
    app.start().catch((error) => {
        console.error('Failed to start application:', error);
        process.exit(1);
    });
}
//# sourceMappingURL=index.js.map