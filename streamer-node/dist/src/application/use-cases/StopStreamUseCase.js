"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StopStreamUseCase = void 0;
const StreamId_1 = require("../../domain/value-objects/StreamId");
class StopStreamUseCase {
    constructor(streamRepository, ffmpegService, logger) {
        this.streamRepository = streamRepository;
        this.ffmpegService = ffmpegService;
        this.logger = logger;
    }
    async execute(request) {
        this.logger.info("Stopping stream", { streamId: request.streamId });
        try {
            const streamId = StreamId_1.StreamId.fromString(request.streamId);
            // Find the stream
            const stream = await this.streamRepository.findById(streamId);
            this.logger.info("Found stream", {
                stream: stream,
                isRunning: stream?.isRunning(),
            });
            if (!stream) {
                this.logger.warn("Stream not found", { streamId: request.streamId });
                return { streamId: request.streamId, stopped: false };
            }
            // Stop FFmpeg process if running
            if (stream.processId && stream.isRunning()) {
                this.logger.info("Stopping FFmpeg process", {
                    streamId: request.streamId,
                    processId: stream.processId,
                });
                await this.ffmpegService.stopStream(stream.processId);
            }
            // Update stream state
            stream.stop();
            await this.streamRepository.save(stream);
            this.logger.info("Stream stopped successfully", {
                streamId: request.streamId,
            });
            return {
                streamId: request.streamId,
                stopped: true,
            };
        }
        catch (error) {
            this.logger.error("Failed to stop stream", {
                error: error instanceof Error ? error.message : String(error),
                streamId: request.streamId,
            });
            throw error;
        }
    }
}
exports.StopStreamUseCase = StopStreamUseCase;
//# sourceMappingURL=StopStreamUseCase.js.map