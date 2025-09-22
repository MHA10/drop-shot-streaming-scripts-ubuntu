import { StreamRepository } from "../../domain/repositories/StreamRepository";
import { FFmpegService } from "../../domain/services/FFmpegService";
import { Logger } from "../interfaces/Logger";
export interface StopStreamRequest {
    streamId: string;
}
export interface StopStreamResponse {
    streamId: string;
    stopped: boolean;
}
export declare class StopStreamUseCase {
    private readonly streamRepository;
    private readonly ffmpegService;
    private readonly logger;
    constructor(streamRepository: StreamRepository, ffmpegService: FFmpegService, logger: Logger);
    execute(request: StopStreamRequest): Promise<StopStreamResponse>;
}
//# sourceMappingURL=StopStreamUseCase.d.ts.map