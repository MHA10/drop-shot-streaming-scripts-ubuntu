import { StreamManagerService } from "../../../src/application/services/StreamManagerService";
import { StreamRepository } from "../../../src/domain/repositories/StreamRepository";
import { FFmpegService } from "../../../src/domain/services/FFmpegService";
import { SSEService } from "../../../src/domain/services/SSEService";
import { StartStreamUseCase } from "../../../src/application/use-cases/StartStreamUseCase";
import { StopStreamUseCase } from "../../../src/application/use-cases/StopStreamUseCase";
import { Logger } from "../../../src/application/interfaces/Logger";
import { Config } from "../../../src/infrastructure/config/Config";
import { SSEStreamEvent } from "../../../src/domain/events/StreamEvent";
import { Stream } from "../../../src/domain/entities/Stream";
import { StreamId } from "../../../src/domain/value-objects/StreamId";
import { StreamUrl } from "../../../src/domain/value-objects/StreamUrl";

describe("StreamManagerService", () => {
  let service: StreamManagerService;
  let mockStreamRepository: jest.Mocked<StreamRepository>;
  let mockFFmpegService: jest.Mocked<FFmpegService>;
  let mockSSEService: jest.Mocked<SSEService>;
  let mockStartStreamUseCase: jest.Mocked<StartStreamUseCase>;
  let mockStopStreamUseCase: jest.Mocked<StopStreamUseCase>;
  let mockLogger: jest.Mocked<Logger>;
  let mockConfig: jest.Mocked<Config>;

  beforeEach(() => {
    mockStreamRepository = {
      save: jest.fn(),
      findById: jest.fn(),
      findAll: jest.fn(),
      findRunning: jest.fn(),
      findByState: jest.fn(),
      delete: jest.fn(),
      exists: jest.fn(),
      getAllIds: jest.fn(),
      clear: jest.fn(),
    };

    mockFFmpegService = {
      startStream: jest.fn(),
      stopStream: jest.fn(),
      isProcessRunning: jest.fn(),
      detectAudio: jest.fn(),
      buildStreamCommand: jest.fn(),
      getRunningProcesses: jest.fn(),
      killAllProcesses: jest.fn(),
    };

    mockSSEService = {
      start: jest.fn(),
      stop: jest.fn(),
      isConnected: jest.fn(),
      onStreamEvent: jest.fn(),
      onConnectionChange: jest.fn(),
      getConnectionStatus: jest.fn(),
      getRetryCount: jest.fn(),
      reconnect: jest.fn(),
    };

    mockStartStreamUseCase = {
      execute: jest.fn(),
    } as any;

    mockStopStreamUseCase = {
      execute: jest.fn(),
    } as any;

    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    mockConfig = {
      getSSEUrl: jest.fn().mockReturnValue("http://localhost:3000/events"),
      getOutputDirectory: jest.fn().mockReturnValue("/tmp/streams"),
      getHealthCheckInterval: jest.fn().mockReturnValue(30000),
    } as any;

    service = new StreamManagerService(
      mockStreamRepository,
      mockFFmpegService,
      mockSSEService,
      mockStartStreamUseCase,
      mockStopStreamUseCase,
      mockLogger,
      mockConfig
    );
  });

  describe("handleStreamEvent - stop action", () => {
    it("should find and stop a running stream by camera URL and stream key", async () => {
      // Arrange
      const cameraUrl = "rtsp://camera1.example.com";
      const streamKey = "stream1";
      const streamId = StreamId.create();

      const runningStream = Stream.create(
        streamId,
        StreamUrl.create(cameraUrl),
        streamKey,
        true
      );
      runningStream.start(12345);

      const stopEvent: SSEStreamEvent = {
        eventId: "test-event-1",
        occurredOn: new Date(),
        eventType: "SSEStreamEvent",
        action: "stop",
        cameraUrl,
        streamKey,
        reconciliationMode: false,
      };

      mockStreamRepository.findAll.mockResolvedValue([runningStream]);
      mockStopStreamUseCase.execute.mockResolvedValue({
        streamId: streamId.value,
        stopped: true,
      });

      // Act
      await (service as any).handleStreamEvent(stopEvent);

      // Assert
      expect(mockStreamRepository.findAll).toHaveBeenCalledTimes(1);
      expect(mockStopStreamUseCase.execute).toHaveBeenCalledWith({
        streamId: streamId.value,
      });
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Handling SSE stream event",
        expect.objectContaining({
          action: "stop",
          cameraUrl,
          streamKey,
        })
      );
    });

    it("should warn when no running stream is found for stop event", async () => {
      // Arrange
      const cameraUrl = "rtsp://camera1.example.com";
      const streamKey = "stream1";

      const stoppedStream = Stream.create(
        StreamId.create(),
        StreamUrl.create(cameraUrl),
        streamKey,
        true
      );
      stoppedStream.start(99999); // Start first
      stoppedStream.stop(); // Then stop - Stream is stopped, not running

      const stopEvent: SSEStreamEvent = {
        eventId: "test-event-2",
        occurredOn: new Date(),
        eventType: "SSEStreamEvent",
        action: "stop",
        cameraUrl,
        streamKey,
        reconciliationMode: false,
      };

      mockStreamRepository.findAll.mockResolvedValue([stoppedStream]);

      // Act
      await (service as any).handleStreamEvent(stopEvent);

      // Assert
      expect(mockStreamRepository.findAll).toHaveBeenCalledTimes(1);
      expect(mockStopStreamUseCase.execute).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Stream not found for stop event",
        {
          cameraUrl,
          streamKey,
        }
      );
    });

    it("should find correct stream when multiple streams exist with different states", async () => {
      // Arrange
      const cameraUrl = "rtsp://camera1.example.com";
      const streamKey = "stream1";

      const failedStream = Stream.create(
        StreamId.create(),
        StreamUrl.create(cameraUrl),
        streamKey,
        true
      );
      failedStream.markAsFailed();

      const runningStreamId = StreamId.create();
      const runningStream = Stream.create(
        runningStreamId,
        StreamUrl.create(cameraUrl),
        streamKey,
        true
      );
      runningStream.start(12345);

      const stoppedStream = Stream.create(
        StreamId.create(),
        StreamUrl.create(cameraUrl),
        streamKey,
        true
      );
      stoppedStream.start(33333); // Start first
      stoppedStream.stop(); // Then stop

      const stopEvent: SSEStreamEvent = {
        eventId: "test-event-3",
        occurredOn: new Date(),
        eventType: "SSEStreamEvent",
        action: "stop",
        cameraUrl,
        streamKey,
        reconciliationMode: false,
      };

      mockStreamRepository.findAll.mockResolvedValue([
        failedStream,
        runningStream,
        stoppedStream,
      ]);
      mockStopStreamUseCase.execute.mockResolvedValue({
        streamId: runningStreamId.value,
        stopped: true,
      });

      // Act
      await (service as any).handleStreamEvent(stopEvent);

      // Assert
      expect(mockStreamRepository.findAll).toHaveBeenCalledTimes(1);
      expect(mockStopStreamUseCase.execute).toHaveBeenCalledWith({
        streamId: runningStreamId.value,
      });
      expect(mockStopStreamUseCase.execute).toHaveBeenCalledTimes(1);
    });

    it("should handle different camera URLs and stream keys correctly", async () => {
      // Arrange
      const targetCameraUrl = "rtsp://camera2.example.com";
      const targetStreamKey = "stream2";

      const otherStream = Stream.create(
        StreamId.create(),
        StreamUrl.create("rtsp://camera1.example.com"),
        "stream1",
        true
      );
      otherStream.start(11111);

      const targetStreamId = StreamId.create();
      const targetStream = Stream.create(
        targetStreamId,
        StreamUrl.create(targetCameraUrl),
        targetStreamKey,
        true
      );
      targetStream.start(22222);

      const stopEvent: SSEStreamEvent = {
        eventId: "test-event-4",
        occurredOn: new Date(),
        eventType: "SSEStreamEvent",
        action: "stop",
        cameraUrl: targetCameraUrl,
        streamKey: targetStreamKey,
        reconciliationMode: false,
      };

      mockStreamRepository.findAll.mockResolvedValue([
        otherStream,
        targetStream,
      ]);
      mockStopStreamUseCase.execute.mockResolvedValue({
        streamId: targetStreamId.value,
        stopped: true,
      });

      // Act
      await (service as any).handleStreamEvent(stopEvent);

      // Assert
      expect(mockStreamRepository.findAll).toHaveBeenCalledTimes(1);
      expect(mockStopStreamUseCase.execute).toHaveBeenCalledWith({
        streamId: targetStreamId.value,
      });
      expect(mockStopStreamUseCase.execute).toHaveBeenCalledTimes(1);
    });

    it("should handle errors during stream event processing", async () => {
      // Arrange
      const cameraUrl = "rtsp://camera1.example.com";
      const streamKey = "stream1";

      const stopEvent: SSEStreamEvent = {
        eventId: "test-event-5",
        occurredOn: new Date(),
        eventType: "SSEStreamEvent",
        action: "stop",
        cameraUrl,
        streamKey,
        reconciliationMode: false,
      };

      const error = new Error("Repository error");
      mockStreamRepository.findAll.mockRejectedValue(error);

      // Act
      await (service as any).handleStreamEvent(stopEvent);

      // Assert
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Failed to process stream event",
        {
          event: stopEvent,
          error: "Repository error",
        }
      );
    });
  });
});
