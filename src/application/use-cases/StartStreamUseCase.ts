import * as path from "path";
import { Stream } from "../../domain/entities/Stream";
import { StreamId } from "../../domain/value-objects/StreamId";
import { StreamUrl } from "../../domain/value-objects/StreamUrl";
import { StreamRepository } from "../../domain/repositories/StreamRepository";
import { FFmpegService } from "../../domain/services/FFmpegService";
import { Logger } from "../interfaces/Logger";
import { HttpClient } from "../services/HttpClient";
import { Config } from "../../infrastructure/config/Config";
import { StreamState } from "../../domain/value-objects/StreamState";
import { AdDownloaderService } from "../../infrastructure/services/AdDownloaderService";
import {
  AdRotator,
  AdRotationRegistry,
} from "../../infrastructure/services/AdRotator";
import { HighlightSignalSource } from "../../domain/services/HighlightSignalSource";
import { HighlightBufferManager } from "../../infrastructure/services/HighlightBufferManager";
import { HighlightBufferRegistry } from "../../infrastructure/services/HighlightBufferRegistry";
import { safeSegment } from "../../infrastructure/utils/paths";
import { StopStreamUseCase } from "./StopStreamUseCase";
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
    private readonly httpClient: HttpClient,
    private readonly adDownloader: AdDownloaderService,
    private readonly adRotationRegistry: AdRotationRegistry,
    private readonly highlightBufferRegistry: HighlightBufferRegistry,
    private readonly highlightSignalSource?: HighlightSignalSource
  ) {}

  private async shouldStartNewStream(
    event: StartStreamRequest,
    stopUseCase: StopStreamUseCase
  ): Promise<ShouldStartStream> {
    const action = await this.validateStreamEvent(event);
    this.logger.info("Stream validation result", { action });
    if (action.isValid) return { isValid: true }; // return true for happy case

    // handle other event types
    const streamEvent = action.data;
    switch (streamEvent.action) {
      // stop all running streams, and run against the only one event received
      case StreamAction.MULTIPLE_STREAMS_RUNNING:
        await Promise.all(
          streamEvent.streamList.map((stream) =>
            stopUseCase.execute({
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
        await stopUseCase.execute({
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
    event: StartStreamRequest
  ): Promise<ValidationEvent> {
    // Find stream by camera URL and stream key
    const streams = await this.streamRepository.findAll();
    this.logger.info("All Streams", streams);

    // if the stream is in pending state, then we can ignore this event
    // pending are ignored since they're already in the process of starting up
    // stopped are ignored since that could be a stale retry
    const pendingStreams = streams.filter(
      (stream) =>
        stream.streamKey === event.streamKey &&
        (stream.state === StreamState.PENDING ||
          stream.state === StreamState.STOPPED)
    );

    this.logger.info("Pending Streams: ", pendingStreams);

    if (pendingStreams.length > 0) {
      return {
        isValid: false,
        data: {
          action: StreamAction.DUPLICATE_EVENT,
          stream: pendingStreams[0],
        },
      };
    }

    const runningStreams = streams.filter(
      (stream) =>
        stream.courtId === event.courtId && stream.state === StreamState.RUNNING
    );

    this.logger.info("Running Streams: ", runningStreams);

    // check if the stream is already running
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

    // a running process exists with a PID, but process is actually dead.
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
    stopUseCase: StopStreamUseCase
  ): Promise<StartStreamResponse> {
    // check if the stream should be started
    const handleResponse = await this.shouldStartNewStream(
      request,
      stopUseCase
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
      // Create stream entity
      const stream = Stream.create(
        streamId,
        cameraUrl,
        request.streamKey,
        request.courtId
      );
      // Save stream state with pending state. To stop any duplicate streams from starting
      await this.streamRepository.save(stream);

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
      stream.setAudio(hasAudio);

      // Start FFmpeg process
      this.logger.info("Starting FFmpeg process", { streamId: streamId.value });

      // This will attempt a retry if the stream gives a retryable error
      const onRetryStream = async (event: StartStreamRequest) => {
        this.logger.info("Stream retrying", { event });

        // fetch the updated state from the repository
        const updatedStream = await this.streamRepository.findById(streamId);
        if (!updatedStream || updatedStream.state === StreamState.STOPPED) {
          this.logger.error("Stream can not be retried", {
            streamId: streamId.value,
          });
          // No restart will follow, so tear down the rotator to avoid leaking
          // its timers (which would keep overwriting slot files for a dead stream).
          this.adRotationRegistry.stop(event.courtId);
          // Same for the highlight buffer's retention sweep — stop it so it
          // doesn't keep pruning a directory for a stream that won't restart.
          this.highlightBufferRegistry.stop(event.courtId);
          return;
        }

        // close the current running stream
        updatedStream.markAsFailed();
        await this.streamRepository.save(updatedStream);

        // start a new process
        await this.execute(request, stopUseCase);
      };

      // Tear down any rotator left over from a previous run on this court now,
      // before the (potentially slow) download, so the old rotator doesn't keep
      // overwriting slot files during the download window.
      this.adRotationRegistry.stop(request.courtId);
      // Likewise stop any prior highlight buffer sweep for this court; a fresh
      // one is started below once the new ffmpeg process is up.
      this.highlightBufferRegistry.stop(request.courtId);

      // Resolve the ad overlays before ffmpeg starts so the slot inputs exist.
      // Two paths, both fail-soft (a missing slot file simply adds no ad input):
      //  - Animated pool (any video/gif): pre-compose one looping MP4 per slot;
      //    rotation is baked into the looping video, so no live rotator is needed
      //    and the main encoder never restarts.
      //  - Still-only pool: keep the live file-swap rotator (cheap, reshuffles).
      const ads = request.ads ?? [];
      let adOverlayPaths: { left?: string | null; right?: string | null } = {};
      let rotator: AdRotator | null = null;

      if (this.adDownloader.hasAnimatedAds(ads)) {
        const slotVideos = await this.adDownloader.buildSlotVideos(
          ads,
          request.courtId,
          this.config.ads
        );
        adOverlayPaths = { left: slotVideos.left, right: slotVideos.right };
      } else if (ads.length > 0) {
        const adPool = await this.adDownloader.downloadPool(ads, request.courtId);
        const slotPaths = this.adDownloader.getSlotPaths(request.courtId);
        rotator = new AdRotator(
          request.courtId,
          adPool,
          slotPaths.left,
          slotPaths.right,
          this.config.ads,
          this.logger
        );
        rotator.prepare(); // writes initial slot file(s) — must precede ffmpeg start
        adOverlayPaths = { left: slotPaths.left, right: slotPaths.right };
      }

      // Per-court highlight buffer directory. Resolving it here (rather than
      // inside NodeFFmpegService) keeps the "is highlight capture on for
      // this court" decision at the application layer, alongside the other
      // per-request feature toggles (scorecard, ads). null/absent means "no
      // buffer branch" — NodeFFmpegService generates the command exactly as
      // it does today.
      //
      // Highlight buffer enablement is AUTOMATIC and per-box: it runs only when
      // the ESP32 highlight hardware is actually attached to this machine
      // (detected via its serial heartbeat), so no per-box env is needed.
      // `highlight.enabled` is only a force-off kill switch (default true).
      //
      // courtId comes straight from the SSE payload (unvalidated), so sanitize
      // it before using it as a path segment — same rule AdDownloaderService
      // applies for its per-court dir — so it can't traverse out of the buffer
      // root (e.g. a courtId of "../..") or contain path-hostile characters.
      // Also require a non-blank configured bufferDir: an explicit
      // HIGHLIGHT_BUFFER_DIR="" would otherwise resolve to the process CWD.
      const highlightHardwarePresent =
        this.highlightSignalSource?.isDevicePresent() ?? false;
      const highlightBufferBase = this.config.highlight.bufferDir.trim();
      const highlightBufferDir =
        this.config.highlight.enabled &&
        highlightHardwarePresent &&
        highlightBufferBase
          ? path.join(highlightBufferBase, safeSegment(request.courtId))
          : null;

      // Observability: make the per-stream buffer decision explicit in logs so
      // staging can see whether the highlight buffer turned on for this court
      // and, if not, exactly which gate blocked it (config vs hardware vs dir).
      this.logger.info("Highlight buffer decision", {
        courtId: request.courtId,
        active: highlightBufferDir !== null,
        enabledConfig: this.config.highlight.enabled,
        hardwarePresent: highlightHardwarePresent,
        bufferDir: highlightBufferDir,
      });

      const ffmpegProcess = await this.ffmpegService.startStream(
        cameraUrl,
        request.streamKey,
        hasAudio,
        request.courtId,
        {
          event: request,
          onRetryStream,
        },
        request.isScorecardActivated,
        adOverlayPaths,
        highlightBufferDir
      );

      // Register first so any exception after start() still has the rotator
      // tracked for cleanup, then begin rotation now that ffmpeg is up. The
      // animated path has no rotator (rotation is baked into the slot videos).
      if (rotator) {
        this.adRotationRegistry.set(request.courtId, rotator);
        rotator.start();
      }

      // Start the highlight buffer's retention sweep now that ffmpeg is writing
      // segments. Registered so stop/retry/shutdown reliably clear its timer.
      if (highlightBufferDir) {
        const bufferManager = new HighlightBufferManager(
          request.courtId,
          highlightBufferDir,
          this.config.highlight.bufferSegmentSec,
          this.config.highlight.bufferRetentionSec,
          this.logger
        );
        this.highlightBufferRegistry.set(request.courtId, bufferManager);
        bufferManager.start();
      }

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
      // otherwise just log and move on
      this.logger.error("Failed to start stream", {
        error: error instanceof Error ? error.message : String(error),
        cameraUrl: request.cameraUrl,
        streamKey: request.streamKey,
      });
      throw error;
    }
  }
}
