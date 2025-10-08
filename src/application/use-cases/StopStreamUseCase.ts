import { FFmpegService } from "../../domain/services/FFmpegService";
import { StreamRepository } from "../database/repositories/StreamRepository";
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
      const { streamId } = request;

      // Find the stream
      const stream = await this.streamRepository.findById(streamId);

      if (!stream) {
        this.logger.warn("Stream not found", { streamId: request.streamId });
        return { streamId: request.streamId, stopped: false };
      }

      stream.stop();
      await this.streamRepository.save(stream);

      // Stop FFmpeg process if it has a PID and the process is actually running
      if (stream.processId) {
        const isProcessRunning = await this.ffmpegService.isProcessRunning(
          stream.processId
        );

        this.logger.info("Checking FFmpeg process status", {
          streamId: request.streamId,
          processId: stream.processId,
          isProcessRunning,
          streamState: stream.state,
        });

        if (isProcessRunning) {
          this.logger.info("Stopping running FFmpeg process", {
            streamId: request.streamId,
            processId: stream.processId,
          });

          await this.ffmpegService.stopStream(stream.processId);

          // Clear the process ID after successfully stopping the process
          stream.clearProcessId();

          this.logger.info("FFmpeg process stopped and process ID cleared", {
            streamId: request.streamId,
            processId: stream.processId,
          });
        } else {
          this.logger.info(
            "FFmpeg process not running, skipping process termination",
            {
              streamId: request.streamId,
              processId: stream.processId,
            }
          );

          // Clear the process ID since the process is not running anyway
          stream.clearProcessId();
        }
      } else {
        this.logger.info(
          "No process ID found for stream, skipping process termination",
          {
            streamId: request.streamId,
          }
        );
      }

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
