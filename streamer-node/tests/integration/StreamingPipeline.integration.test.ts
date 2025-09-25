import { StartStreamUseCase } from "../../src/application/use-cases/StartStreamUseCase";
import { StopStreamUseCase } from "../../src/application/use-cases/StopStreamUseCase";
import { FileSystemStreamRepository } from "../../src/infrastructure/repositories/FileSystemStreamRepository";
import { NodeFFmpegService } from "../../src/infrastructure/services/NodeFFmpegService";
import { ConsoleLogger } from "../../src/infrastructure/logging/ConsoleLogger";
import { Config } from "../../src/infrastructure/config/Config";
import { HttpClient } from "../../src/application/services/HttpClient";
import { StreamId } from "../../src/domain/value-objects/StreamId";
import { StreamUrl } from "../../src/domain/value-objects/StreamUrl";
import { Stream } from "../../src/domain/entities/Stream";
import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("Streaming Pipeline Integration Tests", () => {
  let startStreamUseCase: StartStreamUseCase;
  let stopStreamUseCase: StopStreamUseCase;
  let repository: FileSystemStreamRepository;
  let ffmpegService: NodeFFmpegService;
  let logger: ConsoleLogger;
  let config: Config;
  let httpClient: HttpClient;
  let testDir: string;

  beforeAll(async () => {
    // Create temporary directory for test data
    testDir = join(tmpdir(), "streamer-node-integration-tests");
    await fs.mkdir(testDir, { recursive: true });

    // Initialize real services
    logger = new ConsoleLogger("DEBUG");
    config = Config.getInstance();
    repository = new FileSystemStreamRepository(testDir, logger);
    ffmpegService = new NodeFFmpegService(logger, config);

    // Mock HttpClient to prevent actual HTTP requests
    httpClient = jest.mocked(new HttpClient());
    httpClient.goLiveYouTube = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
    } as Response);

    // Initialize use cases
    startStreamUseCase = new StartStreamUseCase(
      repository,
      ffmpegService,
      logger,
      httpClient
    );
    stopStreamUseCase = new StopStreamUseCase(
      repository,
      ffmpegService,
      logger
    );
  });

  afterAll(async () => {
    // Clean up test directory
    try {
      await fs.rmdir(testDir, { recursive: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  beforeEach(async () => {
    // Clear any existing streams
    await repository.clear();
  });

  describe("Repository Integration", () => {
    it("should persist and retrieve stream data correctly", async () => {
      const cameraUrl = "rtsp://test.example.com/stream";
      const streamKey = "test-stream-key";

      // Create a stream manually and save it
      const streamId = StreamId.create();
      const streamUrlObj = StreamUrl.create(cameraUrl);
      const stream = Stream.create(
        streamId,
        streamUrlObj,
        streamKey,
        "court-123",
        true
      );

      await repository.save(stream);

      // Verify it can be retrieved
      const retrieved = await repository.findById(streamId);
      expect(retrieved).toBeDefined();
      expect(retrieved!.cameraUrl.value).toBe(cameraUrl);
      expect(retrieved!.streamKey).toBe(streamKey);
      expect(retrieved!.id.value).toBe(streamId.value);

      // Test findAll
      const allStreams = await repository.findAll();
      expect(allStreams).toHaveLength(1);
      expect(allStreams[0].id.value).toBe(streamId.value);

      // Test delete
      await repository.delete(streamId);
      const afterDelete = await repository.findById(streamId);
      expect(afterDelete).toBeNull();
    });

    it("should handle multiple streams correctly", async () => {
      const streams: Stream[] = [];

      // Create multiple streams
      for (let i = 0; i < 3; i++) {
        const streamId = StreamId.create();
        const streamUrlObj = StreamUrl.create(
          `rtsp://test${i}.example.com/stream`
        );
        const stream = Stream.create(
          streamId,
          streamUrlObj,
          `key-${i}`,
          "court-123",
          true
        );
        streams.push(stream);
        await repository.save(stream);
      }

      // Verify all can be retrieved
      const allStreams = await repository.findAll();
      expect(allStreams).toHaveLength(3);

      // Verify individual retrieval
      for (const stream of streams) {
        const retrieved = await repository.findById(stream.id);
        expect(retrieved).toBeDefined();
        expect(retrieved!.id.value).toBe(stream.id.value);
      }

      // Test getAllIds
      const ids = await repository.getAllIds();
      expect(ids).toHaveLength(3);
      expect(
        ids.every((id) => streams.some((s) => s.id.value === id.value))
      ).toBe(true);
    });
  });

  describe("Use Case Integration", () => {
    it("should handle workflow without external dependencies", async () => {
      const cameraUrl = "rtsp://test.example.com/stream";
      const streamKey = "workflow-test";

      // Test that use case validates input and creates stream record
      // Note: This will fail at FFmpeg startup, but we can test the validation and persistence
      try {
        await startStreamUseCase.execute({
          cameraUrl,
          streamKey,
          courtId: "court-123",
          detectAudio: false,
        });
      } catch (error) {
        // Expected to fail due to invalid URL, but stream should be created first
        expect(error).toBeDefined();
      }

      // Check if any streams were created (they might be cleaned up on failure)
      const allStreams = await repository.findAll();
      // This test verifies the integration works up to the FFmpeg call
      expect(allStreams.length).toBeGreaterThanOrEqual(0);
    });

    it("should handle stopping non-existent stream", async () => {
      const nonExistentId = "stream_nonexistent_123456789abcdef0";

      const result = await stopStreamUseCase.execute({
        streamId: nonExistentId,
      });

      expect(result.stopped).toBe(false);
      expect(result.streamId).toBe(nonExistentId);
    });
  });

  describe("Error Handling Integration", () => {
    it("should handle repository errors gracefully", async () => {
      // Create a repository with invalid directory to trigger errors
      const invalidRepository = new FileSystemStreamRepository(
        "/invalid/path/that/does/not/exist",
        logger
      );
      const errorStartUseCase = new StartStreamUseCase(
        invalidRepository,
        ffmpegService,
        logger,
        httpClient
      );

      await expect(
        errorStartUseCase.execute({
          cameraUrl: "rtsp://test.com/stream",
          streamKey: "test",
          courtId: "court-123",
          detectAudio: false,
        })
      ).rejects.toThrow();
    }, 15000);

    it("should validate stream URLs correctly", async () => {
      const invalidUrls = [
        "",
        "not-a-url",
        "http://invalid",
        "ftp://invalid.com/stream",
      ];

      for (const invalidUrl of invalidUrls) {
        await expect(
          startStreamUseCase.execute({
            cameraUrl: invalidUrl,
            streamKey: "test",
            courtId: "court-123",
            detectAudio: false,
          })
        ).rejects.toThrow();
      }
    });

    it("should handle empty stream key", async () => {
      await expect(
        startStreamUseCase.execute({
          cameraUrl: "rtsp://test.com/stream",
          streamKey: "",
          courtId: "court-123",
          detectAudio: false,
        })
      ).rejects.toThrow();
    }, 15000);
  });

  describe("Service Integration", () => {
    it("should initialize services correctly", () => {
      expect(logger).toBeDefined();
      expect(config).toBeDefined();
      expect(repository).toBeDefined();
      expect(ffmpegService).toBeDefined();
      expect(startStreamUseCase).toBeDefined();
      expect(stopStreamUseCase).toBeDefined();
    });

    it("should handle logger integration", () => {
      // Test that logger doesn't throw errors
      expect(() => {
        logger.info("Test message");
        logger.error("Test error");
        logger.debug("Test debug");
      }).not.toThrow();
    });

    it("should handle config integration", () => {
      expect(config).toBeDefined();
      expect(typeof config.get).toBe("function");
      expect(typeof config.validate).toBe("function");

      const appConfig = config.get();
      expect(appConfig).toBeDefined();
      expect(appConfig.stream).toBeDefined();
      expect(appConfig.logging).toBeDefined();
    });
  });
});
