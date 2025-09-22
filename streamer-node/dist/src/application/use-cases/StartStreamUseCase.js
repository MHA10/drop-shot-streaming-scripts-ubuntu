"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StartStreamUseCase = void 0;
const Stream_1 = require("../../domain/entities/Stream");
const StreamId_1 = require("../../domain/value-objects/StreamId");
const StreamUrl_1 = require("../../domain/value-objects/StreamUrl");
class StartStreamUseCase {
    constructor(streamRepository, ffmpegService, logger) {
        this.streamRepository = streamRepository;
        this.ffmpegService = ffmpegService;
        this.logger = logger;
    }
    async execute(request) {
        this.logger.info('Starting stream', { cameraUrl: request.cameraUrl, streamKey: request.streamKey });
        try {
            // Create value objects
            const streamId = StreamId_1.StreamId.create();
            const cameraUrl = StreamUrl_1.StreamUrl.create(request.cameraUrl);
            // Detect audio if requested
            let hasAudio = false;
            if (request.detectAudio) {
                this.logger.info('Detecting audio for stream', { streamId: streamId.value });
                hasAudio = await this.ffmpegService.detectAudio(cameraUrl);
                this.logger.info('Audio detection result', { streamId: streamId.value, hasAudio });
            }
            // Create stream entity
            const stream = Stream_1.Stream.create(streamId, cameraUrl, request.streamKey, hasAudio);
            // Start FFmpeg process
            this.logger.info('Starting FFmpeg process', { streamId: streamId.value });
            const ffmpegProcess = await this.ffmpegService.startStream(cameraUrl, request.streamKey, hasAudio);
            // Update stream with process ID
            stream.start(ffmpegProcess.pid);
            // Save stream state
            await this.streamRepository.save(stream);
            this.logger.info('Stream started successfully', {
                streamId: streamId.value,
                processId: ffmpegProcess.pid,
                hasAudio
            });
            return {
                streamId: streamId.value,
                processId: ffmpegProcess.pid,
                hasAudio
            };
        }
        catch (error) {
            this.logger.error('Failed to start stream', {
                error: error instanceof Error ? error.message : String(error),
                cameraUrl: request.cameraUrl,
                streamKey: request.streamKey
            });
            throw error;
        }
    }
}
exports.StartStreamUseCase = StartStreamUseCase;
//# sourceMappingURL=StartStreamUseCase.js.map