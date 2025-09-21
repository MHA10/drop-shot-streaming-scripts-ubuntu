import { StreamConfig, StreamState, ProcessInfo } from '../types';
import { StateManager } from './StateManager';
export declare class StreamManager {
    private audioDetector;
    private processManager;
    private stateManager;
    private logger;
    private config;
    constructor();
    startStream(streamConfig: StreamConfig): Promise<boolean>;
    stopStream(streamId: string): boolean;
    restartStream(streamId: string): Promise<boolean>;
    getStreamStatus(streamId: string): StreamState | null;
    getAllStreamStatuses(): StreamState[];
    getProcessInfo(streamId: string): ProcessInfo | null;
    getAllProcessInfo(): ProcessInfo[];
    validateAndRecoverStreams(): Promise<void>;
    performHealthCheck(): Promise<void>;
    getSystemStats(): {
        streams: ReturnType<StateManager['getStreamStats']>;
        processes: {
            total: number;
            running: number;
        };
        uptime: number;
    };
    recoverFromBoot(): Promise<void>;
    private sleep;
    cleanup(): void;
}
//# sourceMappingURL=StreamManager.d.ts.map