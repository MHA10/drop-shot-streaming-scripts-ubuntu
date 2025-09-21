import { StreamState, StreamConfig } from '../types';
export declare class StateManager {
    private states;
    private configs;
    private logger;
    private stateFile;
    private saveTimeout;
    constructor();
    private loadState;
    private saveState;
    private debouncedSave;
    setStreamState(streamId: string, state: Partial<StreamState>): void;
    getStreamState(streamId: string): StreamState | null;
    getAllStreamStates(): StreamState[];
    setStreamConfig(streamId: string, config: StreamConfig): void;
    getStreamConfig(streamId: string): StreamConfig | null;
    getAllStreamConfigs(): StreamConfig[];
    removeStream(streamId: string): void;
    getActiveStreams(): StreamState[];
    getFailedStreams(): StreamState[];
    incrementRetryCount(streamId: string): number;
    resetRetryCount(streamId: string): void;
    updateHealthCheck(streamId: string): void;
    getStreamsNeedingHealthCheck(intervalMs: number): StreamState[];
    markStreamAsActive(streamId: string, pid: number): void;
    markStreamAsFailed(streamId: string, errorMessage: string): void;
    markStreamAsRetrying(streamId: string): void;
    markStreamAsInactive(streamId: string): void;
    getStreamStats(): {
        total: number;
        active: number;
        failed: number;
        retrying: number;
    };
    cleanup(): void;
    exportState(): string;
    importState(data: string): boolean;
}
//# sourceMappingURL=StateManager.d.ts.map