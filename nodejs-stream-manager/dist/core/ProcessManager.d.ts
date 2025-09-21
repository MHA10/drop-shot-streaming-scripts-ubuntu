import { ProcessInfo, StreamConfig, AudioDetectionResult } from '../types';
export declare class ProcessManager {
    private processes;
    private processInfo;
    private logger;
    private config;
    constructor();
    private ensurePidDirectory;
    startStream(streamConfig: StreamConfig, audioDetection: AudioDetectionResult): Promise<ProcessInfo | null>;
    private buildFFmpegCommand;
    private setupProcessHandlers;
    stopStream(streamId: string): boolean;
    getProcessInfo(streamId: string): ProcessInfo | null;
    getAllProcesses(): ProcessInfo[];
    isStreamRunning(streamId: string): boolean;
    validateProcess(streamId: string): boolean;
    private writePidFile;
    private removePidFile;
}
//# sourceMappingURL=ProcessManager.d.ts.map