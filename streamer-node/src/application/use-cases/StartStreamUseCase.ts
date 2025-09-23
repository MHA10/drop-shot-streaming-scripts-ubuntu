import { Stream } from "../../domain/entities/Stream";
import { StreamId } from "../../domain/value-objects/StreamId";
import { StreamUrl } from "../../domain/value-objects/StreamUrl";
import { StreamRepository } from "../../domain/repositories/StreamRepository";
import { FFmpegService } from "../../domain/services/FFmpegService";
import { Logger } from "../interfaces/Logger";
import { HttpClient } from "../services/HttpClient";
import { Config } from "../../infrastructure/config/Config";

export interface StartStreamRequest {
  cameraUrl: string;
  streamKey: string;
  courtId: string;
  detectAudio?: boolean;
}

export interface StartStreamResponse {
  streamId: string;
  processId: number;
  hasAudio: boolean;
}

export class StartStreamUseCase {
  private readonly config = Config.getInstance().get();

  constructor(
    private readonly streamRepository: StreamRepository,
    private readonly ffmpegService: FFmpegService,
    private readonly logger: Logger,
    private readonly httpClient: HttpClient
  ) {}

  public async execute(
    request: StartStreamRequest
  ): Promise<StartStreamResponse> {
    this.logger.info("Starting stream", {
      cameraUrl: request.cameraUrl,
      streamKey: request.streamKey,
      courtId: request.courtId,
    });

    try {
      // Create value objects
      const streamId = StreamId.create();
      const cameraUrl = StreamUrl.create(request.cameraUrl);

      // Detect audio if requested
      let hasAudio = false;
      if (request.detectAudio) {
        this.logger.info("Detecting audio for stream", {
          streamId: streamId.value,
        });
        hasAudio = await this.ffmpegService.detectAudio(cameraUrl);
        this.logger.info("Audio detection result", {
          streamId: streamId.value,
          hasAudio,
        });
      }

      // Create stream entity
      const stream = Stream.create(
        streamId,
        cameraUrl,
        request.streamKey,
        request.courtId,
        hasAudio
      );

      // Start FFmpeg process
      this.logger.info("Starting FFmpeg process", { streamId: streamId.value });
      const ffmpegProcess = await this.ffmpegService.startStream(
        cameraUrl,
        request.streamKey,
        hasAudio
      );

      // Update stream with process ID
      stream.start(ffmpegProcess.pid);

      // Save stream state
      await this.streamRepository.save(stream);

      this.logger.info("Stream started successfully", {
        streamId: streamId.value,
        processId: ffmpegProcess.pid,
        hasAudio,
      });

      // notify server that the stream has started to go live on YouTube
      await this.httpClient.goLiveYouTube(
        this.config.groundInfo.groundId,
        stream.courtId,
        stream.streamKey
      );

      return {
        streamId: streamId.value,
        processId: ffmpegProcess.pid,
        hasAudio,
      };
    } catch (error) {
      this.logger.error("Failed to start stream", {
        error: error instanceof Error ? error.message : String(error),
        cameraUrl: request.cameraUrl,
        streamKey: request.streamKey,
      });
      throw error;
    }
  }
}
