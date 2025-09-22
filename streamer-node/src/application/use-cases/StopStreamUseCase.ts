import { StreamId } from "../../domain/value-objects/StreamId";
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

export class StopStreamUseCase {
  constructor(
    private readonly streamRepository: StreamRepository,
    private readonly ffmpegService: FFmpegService,
    private readonly logger: Logger
  ) {}

  public async execute(
    request: StopStreamRequest
  ): Promise<StopStreamResponse> {
    this.logger.info("Stopping stream", { streamId: request.streamId });

    try {
      const streamId = StreamId.fromString(request.streamId);

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
    } catch (error) {
      this.logger.error("Failed to stop stream", {
        error: error instanceof Error ? error.message : String(error),
        streamId: request.streamId,
      });
      throw error;
    }
  }
}
