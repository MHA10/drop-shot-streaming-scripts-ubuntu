import { Stream } from "../../domain/entities/Stream";
import { StreamId } from "../../domain/value-objects/StreamId";
import { StreamUrl } from "../../domain/value-objects/StreamUrl";
import { StreamRepository } from "../../domain/repositories/StreamRepository";
import { FFmpegService } from "../../domain/services/FFmpegService";
import { Logger } from "../interfaces/Logger";
import { HttpClient } from "../services/HttpClient";
import { Config } from "../../infrastructure/config/Config";
import { StreamState } from "../../domain/value-objects/StreamState";
import { StopStreamRequest, StopStreamResponse } from "./StopStreamUseCase";
import {
  ShouldStartStream,
  StartStreamRequest,
  StartStreamResponse,
  StreamAction,
  ValidationEvent,
} from "../interfaces/StartStreamUseCase.types";

export class StartStreamUseCase {
  private readonly config = Config.getInstance().get();

  constructor(
    private readonly streamRepository: StreamRepository,
    private readonly ffmpegService: FFmpegService,
    private readonly logger: Logger,
    private readonly httpClient: HttpClient
  ) {}

  private async shouldStartNewStream(
    event: StartStreamRequest,
    stopStream: (request: StopStreamRequest) => Promise<StopStreamResponse>
  ): Promise<ShouldStartStream> {
    // Find stream by camera URL and stream key
    const streams = await this.streamRepository.findAll();
    const runningStreams = streams.filter(
      (stream) =>
        stream.courtId === event.courtId && stream.state === StreamState.RUNNING
    );
    const action = await this.validateStreamEvent(runningStreams, event);
    if (action.isValid) return { isValid: true }; // return true for happy case

    // handle other event types
    const streamEvent = action.data;
    switch (streamEvent.action) {
      // stop all running streams, and run against the only one event received
      case StreamAction.MULTIPLE_STREAMS_RUNNING:
        await Promise.all(
          streamEvent.streamList.map((stream) =>
            stopStream({
              streamId: stream.id.toString(),
            })
          )
        );
        return { isValid: true };
      // update the file with the failed state against process
      case StreamAction.STREAM_RUNNING_WITHOUT_PID:
      case StreamAction.DEAD_PROCESS_DETECTED:
        streamEvent.stream.markAsFailed();
        await this.streamRepository.save(streamEvent.stream);
        return { isValid: true };
      // ignore the event is received for a stream that is already running
      case StreamAction.DUPLICATE_EVENT:
        return {
          isValid: false,
          data: {
            streamId: streamEvent.stream.id.toString(),
            hasAudio: streamEvent.stream.hasAudio,
            processId: streamEvent.stream.processId!,
          },
        };
      // restart the stream since the youtube stream key is no longer valid
      case StreamAction.INVALID_YOUTUBE_STREAM_KEY:
        await stopStream({
          streamId: streamEvent.stream.id.toString(),
        });
        return { isValid: true };
    }
  }

  /**
   * Validates if a new stream can be started by checking:
   * 1. No existing streams (valid to start)
   * 2. Multiple streams on same court (invalid)
   * 3. Stream exists but missing process ID (invalid)
   * 4. Different stream key than existing (invalid)
   * 5. Process already running (duplicate event)
   * 6. Process dead but stream marked as running (stale state)
   */
  private async validateStreamEvent(
    runningStreams: Stream[],
    event: StartStreamRequest
  ): Promise<ValidationEvent> {
    const targetStream = runningStreams.length > 0 ? runningStreams[0] : null;

    if (!targetStream) {
      // there is no running stream. Safe to say stream can be started
      return {
        isValid: true,
      };
    }

    // check if there are multiple streams on a single court - ideally this should never be the case
    if (runningStreams.length > 1) {
      return {
        isValid: false,
        data: {
          action: StreamAction.MULTIPLE_STREAMS_RUNNING,
          streamList: runningStreams,
        },
      };
    }

    // stream file info update issue - stream was saved without pid - ideally this should never be the case
    if (!targetStream.processId) {
      return {
        isValid: false,
        data: {
          action: StreamAction.STREAM_RUNNING_WITHOUT_PID,
          stream: targetStream,
        },
      };
    }

    // check if the incoming event is not a duplicate
    if (targetStream.streamKey !== event.streamKey) {
      return {
        isValid: false,
        data: {
          action: StreamAction.INVALID_YOUTUBE_STREAM_KEY,
          stream: targetStream,
        },
      };
    }

    const ffmpegProcess = await this.ffmpegService.isProcessRunning(
      targetStream.processId
    );
    // check if the process is already running - this means the event is duplicate
    if (ffmpegProcess) {
      return {
        isValid: false,
        data: {
          action: StreamAction.DUPLICATE_EVENT,
          stream: targetStream,
        },
      };
    }

    return {
      isValid: false,
      data: {
        action: StreamAction.DEAD_PROCESS_DETECTED,
        stream: targetStream,
      },
    };
  }

  public async execute(
    request: StartStreamRequest,
    stopProcess: (request: StopStreamRequest) => Promise<StopStreamResponse>
  ): Promise<StartStreamResponse> {
    // check if the stream should be started
    const handleResponse = await this.shouldStartNewStream(
      request,
      stopProcess
    );
    if (!handleResponse.isValid) return handleResponse.data;

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

      // Create PID update callback for retries
      const onPidUpdate = async (newPid: number) => {
        this.logger.info("Updating stream PID after retry", {
          streamId: streamId.value,
          oldPid: stream.processId,
          newPid,
        });
        stream.updateProcessId(newPid);
        await this.streamRepository.save(stream);
      };

      const ffmpegProcess = await this.ffmpegService.startStream(
        cameraUrl,
        request.streamKey,
        hasAudio,
        5, // maxRetries
        5000, // retryDelayMs
        onPidUpdate
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
