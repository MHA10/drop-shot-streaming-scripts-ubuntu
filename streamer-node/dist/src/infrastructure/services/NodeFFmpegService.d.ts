import { FFmpegService, FFmpegCommand, FFmpegProcess } from "../../domain/services/FFmpegService";
import { StreamUrl } from "../../domain/value-objects/StreamUrl";
import { Logger } from "../../application/interfaces/Logger";
import { Config } from "../config/Config";
export declare class NodeFFmpegService implements FFmpegService {
    private readonly logger;
    private readonly config;
    private runningProcesses;
    constructor(logger: Logger, config: Config);
    startStream(cameraUrl: StreamUrl, streamKey: string, hasAudio: boolean): Promise<FFmpegProcess>;
    stopStream(pid: number): Promise<void>;
    isProcessRunning(pid: number): Promise<boolean>;
    detectAudio(cameraUrl: StreamUrl): Promise<boolean>;
    buildStreamCommand(cameraUrl: StreamUrl, streamKey: string, hasAudio: boolean): FFmpegCommand;
    getRunningProcesses(): Promise<FFmpegProcess[]>;
    killAllProcesses(): Promise<void>;
}
//# sourceMappingURL=NodeFFmpegService.d.ts.map