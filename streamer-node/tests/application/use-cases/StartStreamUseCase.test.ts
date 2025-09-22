import { StartStreamUseCase, StartStreamRequest, StartStreamResponse } from '../../../src/application/use-cases/StartStreamUseCase';
import { StreamRepository } from '../../../src/domain/repositories/StreamRepository';
import { FFmpegService, FFmpegProcess } from '../../../src/domain/services/FFmpegService';
import { Logger } from '../../../src/application/interfaces/Logger';
import { Stream } from '../../../src/domain/entities/Stream';
import { StreamId } from '../../../src/domain/value-objects/StreamId';
import { StreamUrl } from '../../../src/domain/value-objects/StreamUrl';

describe('StartStreamUseCase', () => {
  let useCase: StartStreamUseCase;
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

    useCase = new StartStreamUseCase(mockRepository, mockFFmpegService, mockLogger);
  });

  describe('execute', () => {
    it('should start a new stream successfully with audio detection', async () => {
      const cameraUrl = 'rtsp://camera1.example.com';
      const streamKey = 'stream1';
      const mockProcess: FFmpegProcess = {
        pid: 12345,
        command: {
          command: 'ffmpeg',
          args: ['-i', cameraUrl],
          fullCommand: 'ffmpeg -i rtsp://camera1.example.com'
        },
        startTime: new Date()
      };

      mockFFmpegService.detectAudio.mockResolvedValue(true);
      mockFFmpegService.startStream.mockResolvedValue(mockProcess);
      mockRepository.save.mockResolvedValue();

      const result = await useCase.execute({
        cameraUrl,
        streamKey,
        detectAudio: true
      });

      expect(result.streamId).toBeDefined();
      expect(result.processId).toBe(12345);
      expect(result.hasAudio).toBe(true);

      expect(mockFFmpegService.detectAudio).toHaveBeenCalledWith(
        expect.any(StreamUrl)
      );
      expect(mockFFmpegService.startStream).toHaveBeenCalledWith(
        expect.any(StreamUrl),
        streamKey,
        true
      );
      expect(mockRepository.save).toHaveBeenCalledWith(
        expect.any(Stream)
      );
    });

    it('should start a stream without audio detection', async () => {
      const cameraUrl = 'rtsp://camera1.example.com';
      const streamKey = 'stream1';
      const mockProcess: FFmpegProcess = {
        pid: 12345,
        command: {
          command: 'ffmpeg',
          args: ['-i', cameraUrl],
          fullCommand: 'ffmpeg -i rtsp://camera1.example.com'
        },
        startTime: new Date()
      };

      mockFFmpegService.startStream.mockResolvedValue(mockProcess);
      mockRepository.save.mockResolvedValue();

      const result = await useCase.execute({
        cameraUrl,
        streamKey
      });

      expect(result.streamId).toBeDefined();
      expect(result.processId).toBe(12345);
      expect(result.hasAudio).toBe(false);

      expect(mockFFmpegService.detectAudio).not.toHaveBeenCalled();
      expect(mockFFmpegService.startStream).toHaveBeenCalledWith(
        expect.any(StreamUrl),
        streamKey,
        false
      );
    });

    it('should handle FFmpeg service errors', async () => {
      const cameraUrl = 'rtsp://camera1.example.com';
      const streamKey = 'stream1';

      mockFFmpegService.startStream.mockRejectedValue(new Error('FFmpeg failed'));

      await expect(useCase.execute({
        cameraUrl,
        streamKey
      })).rejects.toThrow('FFmpeg failed');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to start stream',
        expect.objectContaining({
          error: 'FFmpeg failed',
          cameraUrl,
          streamKey
        })
      );
    });

    it('should handle audio detection when enabled', async () => {
      const cameraUrl = 'rtsp://camera1.example.com';
      const streamKey = 'stream1';
      const mockProcess: FFmpegProcess = {
        pid: 12345,
        command: {
          command: 'ffmpeg',
          args: ['-i', cameraUrl],
          fullCommand: 'ffmpeg -i rtsp://camera1.example.com'
        },
        startTime: new Date()
      };

      mockFFmpegService.detectAudio.mockResolvedValue(false);
      mockFFmpegService.startStream.mockResolvedValue(mockProcess);
      mockRepository.save.mockResolvedValue();

      const result = await useCase.execute({
        cameraUrl,
        streamKey,
        detectAudio: true
      });

      expect(result.hasAudio).toBe(false);
      expect(mockFFmpegService.detectAudio).toHaveBeenCalled();
      expect(mockFFmpegService.startStream).toHaveBeenCalledWith(
        expect.any(StreamUrl),
        streamKey,
        false
      );
    });
  });
});