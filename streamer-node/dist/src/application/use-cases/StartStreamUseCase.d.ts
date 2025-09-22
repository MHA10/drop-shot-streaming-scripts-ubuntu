import { StreamRepository } from '../../domain/repositories/StreamRepository';
import { FFmpegService } from '../../domain/services/FFmpegService';
import { Logger } from '../interfaces/Logger';
export interface StartStreamRequest {
    cameraUrl: string;
    streamKey: string;
    detectAudio?: boolean;
}
export interface StartStreamResponse {
    streamId: string;
    processId: number;
    hasAudio: boolean;
}
export declare class StartStreamUseCase {
    private readonly streamRepository;
    private readonly ffmpegService;
    private readonly logger;
    constructor(streamRepository: StreamRepository, ffmpegService: FFmpegService, logger: Logger);
    execute(request: StartStreamRequest): Promise<StartStreamResponse>;
}
//# sourceMappingURL=StartStreamUseCase.d.ts.map