"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StreamManager = void 0;
const Logger_1 = require("./Logger");
const ConfigManager_1 = require("./ConfigManager");
const HealthMonitor_1 = require("./HealthMonitor");
const PerformanceOptimizer_1 = require("./PerformanceOptimizer");
const ResourceMonitor_1 = require("./ResourceMonitor");
const SSEClient_1 = require("./SSEClient");
const child_process_1 = require("child_process");
class StreamManager {
    constructor() {
        this.logger = Logger_1.Logger.getInstance();
        this.config = ConfigManager_1.ConfigManager.getInstance().get('server');
        this.healthMonitor = new HealthMonitor_1.HealthMonitor(this.logger);
        this.performanceOptimizer = new PerformanceOptimizer_1.PerformanceOptimizer();
        this.resourceMonitor = new ResourceMonitor_1.ResourceMonitor();
        this.sseClient = new SSEClient_1.SSEClient();
        this.activeStreams = new Map();
        this.streamProcesses = new Map();
        this.isRunning = false;
        this.setupEventHandlers();
    }
    setupEventHandlers() {
        this.sseClient.on('message', (event) => {
            this.handleSSEEvent(event);
        });
        process.on('SIGINT', () => this.shutdown());
        process.on('SIGTERM', () => this.shutdown());
    }
    handleSSEEvent(event) {
        this.logger.info(`Received SSE event: ${event.eventType}`, { event });
        switch (event.eventType) {
            case 'start':
                this.startStream(event.data.streamId, event.data.rtspUrl, event.data.rtmpUrl);
                break;
            case 'stop':
                this.stopStream(event.data.streamId);
                break;
            case 'restart':
                this.restartStream(event.data.streamId);
                break;
            default:
                this.logger.warn(`Unknown SSE event type: ${event.eventType}`);
        }
    }
    async startStream(streamId, rtspUrl, rtmpUrl) {
        try {
            if (this.activeStreams.has(streamId)) {
                this.logger.warn(`Stream ${streamId} is already active`);
                return false;
            }
            this.logger.info(`Starting stream ${streamId}`, { rtspUrl, rtmpUrl });
            const streamState = {
                id: streamId,
                rtspUrl,
                rtmpUrl,
                status: 'pending',
                startTime: new Date(),
                pid: 0,
                retryCount: 0
            };
            this.activeStreams.set(streamId, streamState);
            const ffmpegProcess = this.createFFmpegProcess(rtspUrl, rtmpUrl);
            if (!ffmpegProcess) {
                throw new Error('Failed to create FFmpeg process');
            }
            this.streamProcesses.set(streamId, ffmpegProcess);
            streamState.pid = ffmpegProcess.pid || 0;
            streamState.status = 'running';
            ffmpegProcess.on('exit', (code, signal) => {
                this.handleStreamExit(streamId, code, signal);
            });
            ffmpegProcess.on('error', (error) => {
                this.handleStreamError(streamId, error);
            });
            this.logger.info(`Stream ${streamId} started successfully with PID ${streamState.pid}`);
            return true;
        }
        catch (error) {
            this.logger.error(`Failed to start stream ${streamId}`, error);
            this.activeStreams.delete(streamId);
            return false;
        }
    }
    async stopStream(streamId) {
        try {
            const streamState = this.activeStreams.get(streamId);
            if (!streamState) {
                this.logger.warn(`Stream ${streamId} not found`);
                return false;
            }
            this.logger.info(`Stopping stream ${streamId}`);
            const process = this.streamProcesses.get(streamId);
            if (process && !process.killed) {
                process.kill('SIGTERM');
                setTimeout(() => {
                    if (!process.killed) {
                        process.kill('SIGKILL');
                    }
                }, 5000);
            }
            this.activeStreams.delete(streamId);
            this.streamProcesses.delete(streamId);
            this.logger.info(`Stream ${streamId} stopped successfully`);
            return true;
        }
        catch (error) {
            this.logger.error(`Failed to stop stream ${streamId}`, error);
            return false;
        }
    }
    async restartStream(streamId) {
        const streamState = this.activeStreams.get(streamId);
        if (!streamState) {
            this.logger.warn(`Cannot restart stream ${streamId} - not found`);
            return false;
        }
        this.logger.info(`Restarting stream ${streamId}`);
        const { rtspUrl, rtmpUrl } = streamState;
        await this.stopStream(streamId);
        await new Promise(resolve => setTimeout(resolve, 1000));
        return this.startStream(streamId, rtspUrl, rtmpUrl);
    }
    createFFmpegProcess(rtspUrl, rtmpUrl) {
        try {
            const ffmpegArgs = [
                '-rtsp_transport', 'tcp',
                '-fflags', '+genpts',
                '-avoid_negative_ts', 'make_zero',
                '-i', rtspUrl,
                '-c:v', 'libx264',
                '-preset', 'veryfast',
                '-b:v', '4500k',
                '-maxrate', '5000k',
                '-bufsize', '10000k',
                '-vf', 'scale=1920:1080',
                '-c:a', 'aac',
                '-b:a', '128k',
                '-ar', '44100',
                '-ac', '2',
                '-f', 'flv',
                rtmpUrl
            ];
            const process = (0, child_process_1.spawn)('ffmpeg', ffmpegArgs, {
                stdio: ['ignore', 'pipe', 'pipe']
            });
            process.stdout?.on('data', (data) => {
                this.logger.debug(`FFmpeg stdout: ${data}`);
            });
            process.stderr?.on('data', (data) => {
                this.logger.debug(`FFmpeg stderr: ${data}`);
            });
            return process;
        }
        catch (error) {
            this.logger.error('Failed to create FFmpeg process', error);
            return null;
        }
    }
    handleStreamExit(streamId, code, signal) {
        const streamState = this.activeStreams.get(streamId);
        if (!streamState)
            return;
        this.logger.warn(`Stream ${streamId} exited`, { code, signal });
        streamState.status = 'failed';
        streamState.lastError = `Process exited with code ${code}, signal ${signal}`;
        if (streamState.retryCount < 3) {
            streamState.retryCount++;
            this.logger.info(`Attempting to restart stream ${streamId} (retry ${streamState.retryCount}/3)`);
            setTimeout(() => {
                this.restartStream(streamId);
            }, 5000 * streamState.retryCount);
        }
        else {
            this.logger.error(`Stream ${streamId} failed permanently after 3 retries`);
            this.activeStreams.delete(streamId);
            this.streamProcesses.delete(streamId);
        }
    }
    handleStreamError(streamId, error) {
        const streamState = this.activeStreams.get(streamId);
        if (!streamState)
            return;
        this.logger.error(`Stream ${streamId} error`, error);
        streamState.status = 'failed';
        streamState.lastError = error.message;
    }
    getActiveStreams() {
        return new Map(this.activeStreams);
    }
    getStreamState(streamId) {
        return this.activeStreams.get(streamId);
    }
    async start() {
        if (this.isRunning) {
            this.logger.warn('StreamManager is already running');
            return;
        }
        this.logger.info('Starting StreamManager');
        this.isRunning = true;
        this.healthMonitor.start();
        await this.sseClient.connect();
        this.healthCheckInterval = setInterval(() => {
            this.performHealthCheck();
        }, 30000);
        this.logger.info('StreamManager started successfully');
    }
    async shutdown() {
        if (!this.isRunning)
            return;
        this.logger.info('Shutting down StreamManager');
        this.isRunning = false;
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
        }
        const streamIds = Array.from(this.activeStreams.keys());
        for (const streamId of streamIds) {
            await this.stopStream(streamId);
        }
        this.sseClient.disconnect();
        this.healthMonitor.stop();
        this.performanceOptimizer.destroy();
        this.resourceMonitor.destroy();
        this.logger.info('StreamManager shutdown complete');
    }
    performHealthCheck() {
        this.logger.debug('Performing stream health check');
        for (const [streamId, streamState] of this.activeStreams) {
            const process = this.streamProcesses.get(streamId);
            if (!process || process.killed) {
                this.logger.warn(`Stream ${streamId} process is dead, attempting restart`);
                this.restartStream(streamId);
            }
        }
    }
    getStatus() {
        return {
            isRunning: this.isRunning,
            activeStreamCount: this.activeStreams.size,
            totalStreams: this.streamProcesses.size,
            healthStatus: this.healthMonitor.getHealthStatus()
        };
    }
}
exports.StreamManager = StreamManager;
//# sourceMappingURL=StreamManager.js.map