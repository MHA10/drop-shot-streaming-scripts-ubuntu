import { StreamRepository } from '../../domain/repositories/StreamRepository';
import { FFmpegService } from '../../domain/services/FFmpegService';
import { SSEService } from '../../domain/services/SSEService';
import { StartStreamUseCase } from '../use-cases/StartStreamUseCase';
import { StopStreamUseCase } from '../use-cases/StopStreamUseCase';
import { Logger } from '../interfaces/Logger';
import { Config } from '../../infrastructure/config/Config';
export declare class StreamManagerService {
    private readonly streamRepository;
    private readonly ffmpegService;
    private readonly sseService;
    private readonly startStreamUseCase;
    private readonly stopStreamUseCase;
    private readonly logger;
    private readonly config;
    private healthCheckInterval?;
    private isRunning;
    constructor(streamRepository: StreamRepository, ffmpegService: FFmpegService, sseService: SSEService, startStreamUseCase: StartStreamUseCase, stopStreamUseCase: StopStreamUseCase, logger: Logger, config: Config);
    start(): Promise<void>;
    stop(): Promise<void>;
    private initializeSystem;
    private recoverStreams;
    private cleanupOrphanedProcesses;
    private setupSSEEventHandlers;
    private handleStreamEvent;
    private startHealthCheck;
    private performHealthCheck;
    private stopAllStreams;
    getStatus(): Promise<{
        isRunning: boolean;
        sseConnected: boolean;
        runningStreams: number;
        totalStreams: number;
    }>;
}
//# sourceMappingURL=StreamManagerService.d.ts.map