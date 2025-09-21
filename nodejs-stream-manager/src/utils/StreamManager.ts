import { Logger } from './Logger';
import { ConfigManager } from './ConfigManager';
import { HealthMonitor } from './HealthMonitor';
import { PerformanceOptimizer } from './PerformanceOptimizer';
import { ResourceMonitor } from './ResourceMonitor';
import { SSEClient } from './SSEClient';
import { StreamState, Config, SSEEvent } from '../types';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export class StreamManager {
    private logger: Logger;
    private config: Config;
    private healthMonitor: HealthMonitor;
    private performanceOptimizer: PerformanceOptimizer;
    private resourceMonitor: ResourceMonitor;
    private sseClient: SSEClient;
    private activeStreams: Map<string, StreamState>;
    private streamProcesses: Map<string, ChildProcess>;
    private isRunning: boolean;
    private healthCheckInterval?: NodeJS.Timeout;

    constructor() {
        this.logger = Logger.getInstance();
        this.config = ConfigManager.getInstance().get('server');
        this.healthMonitor = new HealthMonitor(this.logger);
        this.performanceOptimizer = new PerformanceOptimizer();
        this.resourceMonitor = new ResourceMonitor();
        this.sseClient = new SSEClient();
        this.activeStreams = new Map();
        this.streamProcesses = new Map();
        this.isRunning = false;

        this.setupEventHandlers();
    }

    private setupEventHandlers(): void {
        // Handle SSE events for stream management
        this.sseClient.on('message', (event: SSEEvent) => {
            this.handleSSEEvent(event);
        });

        // Handle process cleanup on exit
        process.on('SIGINT', () => this.shutdown());
        process.on('SIGTERM', () => this.shutdown());
    }

    private handleSSEEvent(event: SSEEvent): void {
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

    public async startStream(streamId: string, rtspUrl: string, rtmpUrl: string): Promise<boolean> {
        try {
            if (this.activeStreams.has(streamId)) {
                this.logger.warn(`Stream ${streamId} is already active`);
                return false;
            }

            this.logger.info(`Starting stream ${streamId}`, { rtspUrl, rtmpUrl });

            // Create stream state
            const streamState: StreamState = {
                id: streamId,
                rtspUrl,
                rtmpUrl,
                status: 'pending',
                startTime: new Date(),
                pid: 0,
                retryCount: 0
            };

            this.activeStreams.set(streamId, streamState);

            // Start FFmpeg process
            const ffmpegProcess = this.createFFmpegProcess(rtspUrl, rtmpUrl);
            
            if (!ffmpegProcess) {
                throw new Error('Failed to create FFmpeg process');
            }

            this.streamProcesses.set(streamId, ffmpegProcess);
            streamState.pid = ffmpegProcess.pid || 0;
            streamState.status = 'running';

            // Setup process event handlers
            ffmpegProcess.on('exit', (code, signal) => {
                this.handleStreamExit(streamId, code, signal);
            });

            ffmpegProcess.on('error', (error) => {
                this.handleStreamError(streamId, error);
            });

            this.logger.info(`Stream ${streamId} started successfully with PID ${streamState.pid}`);
            return true;

        } catch (error) {
            this.logger.error(`Failed to start stream ${streamId}`, error as Error);
            this.activeStreams.delete(streamId);
            return false;
        }
    }

    public async stopStream(streamId: string): Promise<boolean> {
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
                
                // Force kill after timeout
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

        } catch (error) {
            this.logger.error(`Failed to stop stream ${streamId}`, error as Error);
            return false;
        }
    }

    public async restartStream(streamId: string): Promise<boolean> {
        const streamState = this.activeStreams.get(streamId);
        if (!streamState) {
            this.logger.warn(`Cannot restart stream ${streamId} - not found`);
            return false;
        }

        this.logger.info(`Restarting stream ${streamId}`);

        const { rtspUrl, rtmpUrl } = streamState;
        await this.stopStream(streamId);
        
        // Wait a moment before restarting
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        return this.startStream(streamId, rtspUrl, rtmpUrl);
    }

    private createFFmpegProcess(rtspUrl: string, rtmpUrl: string): ChildProcess | null {
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

            const process = spawn('ffmpeg', ffmpegArgs, {
                stdio: ['ignore', 'pipe', 'pipe']
            });

            // Log FFmpeg output
            process.stdout?.on('data', (data) => {
                this.logger.debug(`FFmpeg stdout: ${data}`);
            });

            process.stderr?.on('data', (data) => {
                this.logger.debug(`FFmpeg stderr: ${data}`);
            });

            return process;

        } catch (error) {
            this.logger.error('Failed to create FFmpeg process', error as Error);
            return null;
        }
    }

    private handleStreamExit(streamId: string, code: number | null, signal: string | null): void {
        const streamState = this.activeStreams.get(streamId);
        if (!streamState) return;

        this.logger.warn(`Stream ${streamId} exited`, { code, signal });

        streamState.status = 'failed';
        streamState.lastError = `Process exited with code ${code}, signal ${signal}`;

        // Attempt restart if configured
        if (streamState.retryCount < 3) {
            streamState.retryCount++;
            this.logger.info(`Attempting to restart stream ${streamId} (retry ${streamState.retryCount}/3)`);
            
            setTimeout(() => {
                this.restartStream(streamId);
            }, 5000 * streamState.retryCount); // Exponential backoff
        } else {
            this.logger.error(`Stream ${streamId} failed permanently after 3 retries`);
            this.activeStreams.delete(streamId);
            this.streamProcesses.delete(streamId);
        }
    }

    private handleStreamError(streamId: string, error: Error): void {
        const streamState = this.activeStreams.get(streamId);
        if (!streamState) return;

        this.logger.error(`Stream ${streamId} error`, error);
        streamState.status = 'failed';
        streamState.lastError = error.message;
    }

    public getActiveStreams(): Map<string, StreamState> {
        return new Map(this.activeStreams);
    }

    public getStreamState(streamId: string): StreamState | undefined {
        return this.activeStreams.get(streamId);
    }

    public async start(): Promise<void> {
        if (this.isRunning) {
            this.logger.warn('StreamManager is already running');
            return;
        }

        this.logger.info('Starting StreamManager');
        this.isRunning = true;

        // Start health monitoring
        this.healthMonitor.start();
        
        // Start SSE client
        await this.sseClient.connect();

        // Start periodic health checks
        this.healthCheckInterval = setInterval(() => {
            this.performHealthCheck();
        }, 30000); // Every 30 seconds

        this.logger.info('StreamManager started successfully');
    }

    public async shutdown(): Promise<void> {
        if (!this.isRunning) return;

        this.logger.info('Shutting down StreamManager');
        this.isRunning = false;

        // Clear health check interval
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval);
        }

        // Stop all active streams
        const streamIds = Array.from(this.activeStreams.keys());
        for (const streamId of streamIds) {
            await this.stopStream(streamId);
        }

        // Disconnect SSE client
        this.sseClient.disconnect();

        // Stop monitoring services
        this.healthMonitor.stop();
        this.performanceOptimizer.destroy();
        this.resourceMonitor.destroy();

        this.logger.info('StreamManager shutdown complete');
    }

    private performHealthCheck(): void {
        this.logger.debug('Performing stream health check');

        for (const [streamId, streamState] of this.activeStreams) {
            const process = this.streamProcesses.get(streamId);
            
            if (!process || process.killed) {
                this.logger.warn(`Stream ${streamId} process is dead, attempting restart`);
                this.restartStream(streamId);
            }
        }
    }

    public getStatus(): {
        isRunning: boolean;
        activeStreamCount: number;
        totalStreams: number;
        healthStatus: any;
    } {
        return {
            isRunning: this.isRunning,
            activeStreamCount: this.activeStreams.size,
            totalStreams: this.streamProcesses.size,
            healthStatus: this.healthMonitor.getHealthStatus()
        };
    }
}