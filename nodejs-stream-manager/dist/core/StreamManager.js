"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StreamManager = void 0;
const AudioDetector_1 = require("./AudioDetector");
const ProcessManager_1 = require("./ProcessManager");
const StateManager_1 = require("./StateManager");
const Logger_1 = require("../utils/Logger");
const ConfigManager_1 = require("../utils/ConfigManager");
class StreamManager {
    constructor() {
        this.audioDetector = new AudioDetector_1.AudioDetector();
        this.processManager = new ProcessManager_1.ProcessManager();
        this.stateManager = new StateManager_1.StateManager();
        this.logger = Logger_1.Logger.getInstance();
        this.config = ConfigManager_1.ConfigManager.getInstance().getConfig();
    }
    async startStream(streamConfig) {
        const { id: streamId } = streamConfig;
        try {
            this.logger.stream(streamId, 'Starting stream request', {
                rtspUrl: streamConfig.rtspUrl,
                rtmpUrl: streamConfig.rtmpUrl
            });
            if (this.processManager.isStreamRunning(streamId)) {
                this.logger.warn('Stream already running', { streamId });
                return true;
            }
            if (!this.audioDetector.validateRtspUrl(streamConfig.rtspUrl)) {
                throw new Error('Invalid RTSP URL format');
            }
            this.stateManager.markStreamAsRetrying(streamId);
            this.stateManager.setStreamConfig(streamId, streamConfig);
            this.logger.stream(streamId, 'Detecting audio streams');
            const audioDetection = await this.audioDetector.detectAudioWithRetry(streamConfig.rtspUrl, 3, 10000);
            if (audioDetection.error) {
                this.logger.warn('Audio detection had issues, proceeding without audio', {
                    streamId,
                    error: audioDetection.error
                });
            }
            const updatedConfig = {
                ...streamConfig,
                audioParams: {
                    ...streamConfig.audioParams,
                    hasAudio: audioDetection.hasAudio
                }
            };
            const processInfo = await this.processManager.startStream(updatedConfig, audioDetection);
            if (!processInfo) {
                throw new Error('Failed to start FFmpeg process');
            }
            this.stateManager.markStreamAsActive(streamId, processInfo.pid);
            this.stateManager.resetRetryCount(streamId);
            this.logger.stream(streamId, 'Stream started successfully', {
                pid: processInfo.pid,
                hasAudio: audioDetection.hasAudio,
                audioStreams: audioDetection.audioStreams
            });
            return true;
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            this.logger.error('Failed to start stream', error, { streamId });
            this.stateManager.markStreamAsFailed(streamId, errorMessage);
            return false;
        }
    }
    stopStream(streamId) {
        try {
            this.logger.stream(streamId, 'Stopping stream request');
            const success = this.processManager.stopStream(streamId);
            if (success) {
                this.stateManager.markStreamAsInactive(streamId);
                this.logger.stream(streamId, 'Stream stopped successfully');
            }
            else {
                this.logger.warn('Failed to stop stream process', { streamId });
            }
            return success;
        }
        catch (error) {
            this.logger.error('Error stopping stream', error, { streamId });
            return false;
        }
    }
    async restartStream(streamId) {
        this.logger.stream(streamId, 'Restarting stream');
        this.stopStream(streamId);
        await this.sleep(2000);
        const config = this.stateManager.getStreamConfig(streamId);
        if (!config) {
            this.logger.error('No config found for stream restart', undefined, { streamId });
            return false;
        }
        return this.startStream(config);
    }
    getStreamStatus(streamId) {
        return this.stateManager.getStreamState(streamId);
    }
    getAllStreamStatuses() {
        return this.stateManager.getAllStreamStates();
    }
    getProcessInfo(streamId) {
        return this.processManager.getProcessInfo(streamId);
    }
    getAllProcessInfo() {
        return this.processManager.getAllProcesses();
    }
    async validateAndRecoverStreams() {
        this.logger.info('Starting stream validation and recovery');
        const activeStreams = this.stateManager.getActiveStreams();
        for (const stream of activeStreams) {
            try {
                const isValid = this.processManager.validateProcess(stream.id);
                if (!isValid) {
                    this.logger.warn('Stream process not found, attempting recovery', {
                        streamId: stream.id,
                        pid: stream.pid ?? -1
                    });
                    const retryCount = this.stateManager.incrementRetryCount(stream.id);
                    const maxRetries = this.config.streaming.maxRetries;
                    if (retryCount <= maxRetries) {
                        this.logger.stream(stream.id, 'Attempting stream recovery', {
                            retryCount,
                            maxRetries
                        });
                        const config = this.stateManager.getStreamConfig(stream.id);
                        if (config) {
                            const backoffMs = Math.min(this.config.streaming.retryBackoffMs * Math.pow(2, retryCount - 1), 30000);
                            await this.sleep(backoffMs);
                            await this.startStream(config);
                        }
                    }
                    else {
                        this.logger.error('Stream exceeded max retries, marking as failed', undefined, {
                            streamId: stream.id,
                            retryCount,
                            maxRetries
                        });
                        this.stateManager.markStreamAsFailed(stream.id, `Exceeded max retries (${maxRetries})`);
                    }
                }
                else {
                    this.stateManager.updateHealthCheck(stream.id);
                }
            }
            catch (error) {
                this.logger.error('Error during stream validation', error, {
                    streamId: stream.id
                });
            }
        }
    }
    async performHealthCheck() {
        const healthCheckInterval = this.config.server.healthCheckInterval;
        const streamsNeedingCheck = this.stateManager.getStreamsNeedingHealthCheck(healthCheckInterval);
        if (streamsNeedingCheck.length === 0) {
            return;
        }
        this.logger.debug('Performing health check', {
            streamsCount: streamsNeedingCheck.length
        });
        for (const stream of streamsNeedingCheck) {
            try {
                const isRunning = this.processManager.isStreamRunning(stream.id);
                const isValid = this.processManager.validateProcess(stream.id);
                if (isRunning && isValid) {
                    this.stateManager.updateHealthCheck(stream.id);
                    this.logger.debug('Stream health check passed', { streamId: stream.id });
                }
                else {
                    this.logger.warn('Stream failed health check', {
                        streamId: stream.id,
                        isRunning,
                        isValid
                    });
                }
            }
            catch (error) {
                this.logger.error('Health check error', error, { streamId: stream.id });
            }
        }
    }
    getSystemStats() {
        const processes = this.getAllProcessInfo();
        const runningProcesses = processes.filter(p => p.status === 'running');
        return {
            streams: this.stateManager.getStreamStats(),
            processes: {
                total: processes.length,
                running: runningProcesses.length
            },
            uptime: process.uptime()
        };
    }
    async recoverFromBoot() {
        this.logger.info('Recovering streams after system boot');
        const configs = this.stateManager.getAllStreamConfigs();
        const activeStreams = this.stateManager.getActiveStreams();
        for (const stream of activeStreams) {
            this.stateManager.markStreamAsInactive(stream.id);
        }
        await this.sleep(5000);
        for (const config of configs) {
            try {
                this.logger.stream(config.id, 'Recovering stream from boot');
                await this.startStream(config);
                await this.sleep(2000);
            }
            catch (error) {
                this.logger.error('Failed to recover stream from boot', error, {
                    streamId: config.id
                });
            }
        }
    }
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    cleanup() {
        this.logger.info('Cleaning up StreamManager');
        this.processManager.cleanupAll();
        this.stateManager.cleanup();
    }
}
exports.StreamManager = StreamManager;
//# sourceMappingURL=StreamManager.js.map