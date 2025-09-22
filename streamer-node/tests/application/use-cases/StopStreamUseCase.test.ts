import { StopStreamUseCase } from '../../../src/application/use-cases/StopStreamUseCase';
import { StreamRepository } from '../../../src/domain/repositories/StreamRepository';
import { FFmpegService } from '../../../src/domain/services/FFmpegService';
import { Logger } from '../../../src/application/interfaces/Logger';
import { Stream } from '../../../src/domain/entities/Stream';
import { StreamId } from '../../../src/domain/value-objects/StreamId';
import { StreamUrl } from '../../../src/domain/value-objects/StreamUrl';
import { StreamState } from '../../../src/domain/value-objects/StreamState';

describe('StopStreamUseCase', () => {
  let useCase: StopStreamUseCase;
  let mockRepository: jest.Mocked<StreamRepository>;
  let mockFFmpegService: jest.Mocked<FFmpegService>;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    mockRepository = {
      save: jest.fn(),
      findById: jest.fn(),
      findAll: jest.fn(),
      findRunning: jest.fn(),
      findByState: jest.fn(),
      delete: jest.fn(),
      exists: jest.fn(),
      getAllIds: jest.fn(),
      clear: jest.fn()
    };

    mockFFmpegService = {
      startStream: jest.fn(),
      stopStream: jest.fn(),
      isProcessRunning: jest.fn(),
      detectAudio: jest.fn(),
      buildStreamCommand: jest.fn(),
      getRunningProcesses: jest.fn(),
      killAllProcesses: jest.fn()
    };

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn()
    };

    useCase = new StopStreamUseCase(mockRepository, mockFFmpegService, mockLogger);
  });

  describe('execute', () => {
    it('should stop stream successfully', async () => {
      const streamId = StreamId.create();
      const cameraUrl = StreamUrl.create('rtsp://example.com/stream');
      const mockStream = Stream.create(streamId, cameraUrl, 'stream-key', false);
      mockStream.start(123);

      mockRepository.findById.mockResolvedValue(mockStream);
      mockFFmpegService.stopStream.mockResolvedValue(undefined);

      const result = await useCase.execute({ streamId: streamId.value });

      expect(result).toEqual({
        streamId: streamId.value,
        stopped: true
      });

      expect(mockRepository.findById).toHaveBeenCalledWith(streamId);
      expect(mockFFmpegService.stopStream).toHaveBeenCalledWith(123);
      expect(mockRepository.save).toHaveBeenCalledWith(mockStream);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Stream stopped successfully',
        expect.objectContaining({
          streamId: streamId.value,
        })
      );
    });

    it('should return stopped false when stream not found', async () => {
      const streamId = StreamId.create();
      mockRepository.findById.mockResolvedValue(null);

      const result = await useCase.execute({ streamId: streamId.value });

      expect(result).toEqual({
        streamId: streamId.value,
        stopped: false
      });

      expect(mockFFmpegService.stopStream).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Stream not found',
        expect.objectContaining({
          streamId: streamId.value,
        })
      );
    });

    it('should handle FFmpeg service errors', async () => {
      const streamId = StreamId.create();
      const cameraUrl = StreamUrl.create('rtsp://camera1.example.com');
      const stream = Stream.create(streamId, cameraUrl, 'stream1', true);
      stream.start(12345);

      mockRepository.findById.mockResolvedValue(stream);
      mockFFmpegService.stopStream.mockRejectedValue(new Error('Failed to stop process'));

      await expect(useCase.execute({ streamId: streamId.value }))
        .rejects.toThrow('Failed to stop process');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to stop stream',
        expect.objectContaining({
          error: 'Failed to stop process',
          streamId: streamId.value
        })
      );
    });

    it('should handle stopping non-running stream', async () => {
      const streamId = StreamId.create();
      const cameraUrl = StreamUrl.create('rtsp://camera1.example.com');
      const stream = Stream.create(streamId, cameraUrl, 'stream1', true);
      // Stream is in PENDING state, not started

      mockRepository.findById.mockResolvedValue(stream);

      await expect(useCase.execute({ streamId: streamId.value }))
        .rejects.toThrow('Cannot stop stream in pending state');

      expect(mockFFmpegService.stopStream).not.toHaveBeenCalled();
    });
  });
});