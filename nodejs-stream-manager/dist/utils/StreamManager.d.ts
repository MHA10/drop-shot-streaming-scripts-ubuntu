import { StreamState } from '../types';
export declare class StreamManager {
    private logger;
    private config;
    private healthMonitor;
    private performanceOptimizer;
    private resourceMonitor;
    private sseClient;
    private activeStreams;
    private streamProcesses;
    private isRunning;
    private healthCheckInterval?;
    constructor();
    private setupEventHandlers;
    private handleSSEEvent;
    startStream(streamId: string, rtspUrl: string, rtmpUrl: string): Promise<boolean>;
    stopStream(streamId: string): Promise<boolean>;
    restartStream(streamId: string): Promise<boolean>;
    private createFFmpegProcess;
    private handleStreamExit;
    private handleStreamError;
    getActiveStreams(): Map<string, StreamState>;
    getStreamState(streamId: string): StreamState | undefined;
    start(): Promise<void>;
    shutdown(): Promise<void>;
    private performHealthCheck;
    getStatus(): {
        isRunning: boolean;
        activeStreamCount: number;
        totalStreams: number;
        healthStatus: any;
    };
}
//# sourceMappingURL=StreamManager.d.ts.map