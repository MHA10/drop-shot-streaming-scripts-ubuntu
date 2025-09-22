"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const StartStreamUseCase_1 = require("../../../src/application/use-cases/StartStreamUseCase");
const Stream_1 = require("../../../src/domain/entities/Stream");
const StreamUrl_1 = require("../../../src/domain/value-objects/StreamUrl");
describe('StartStreamUseCase', () => {
    let useCase;
    let mockRepository;
    let mockFFmpegService;
    let mockLogger;
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
        useCase = new StartStreamUseCase_1.StartStreamUseCase(mockRepository, mockFFmpegService, mockLogger);
    });
    describe('execute', () => {
        it('should start a new stream successfully with audio detection', async () => {
            const cameraUrl = 'rtsp://camera1.example.com';
            const streamKey = 'stream1';
            const mockProcess = {
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
            expect(mockFFmpegService.detectAudio).toHaveBeenCalledWith(expect.any(StreamUrl_1.StreamUrl));
            expect(mockFFmpegService.startStream).toHaveBeenCalledWith(expect.any(StreamUrl_1.StreamUrl), streamKey, true);
            expect(mockRepository.save).toHaveBeenCalledWith(expect.any(Stream_1.Stream));
        });
        it('should start a stream without audio detection', async () => {
            const cameraUrl = 'rtsp://camera1.example.com';
            const streamKey = 'stream1';
            const mockProcess = {
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
            expect(mockFFmpegService.startStream).toHaveBeenCalledWith(expect.any(StreamUrl_1.StreamUrl), streamKey, false);
        });
        it('should handle FFmpeg service errors', async () => {
            const cameraUrl = 'rtsp://camera1.example.com';
            const streamKey = 'stream1';
            mockFFmpegService.startStream.mockRejectedValue(new Error('FFmpeg failed'));
            await expect(useCase.execute({
                cameraUrl,
                streamKey
            })).rejects.toThrow('FFmpeg failed');
            expect(mockLogger.error).toHaveBeenCalledWith('Failed to start stream', expect.objectContaining({
                error: 'FFmpeg failed',
                cameraUrl,
                streamKey
            }));
        });
        it('should handle audio detection when enabled', async () => {
            const cameraUrl = 'rtsp://camera1.example.com';
            const streamKey = 'stream1';
            const mockProcess = {
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
            expect(mockFFmpegService.startStream).toHaveBeenCalledWith(expect.any(StreamUrl_1.StreamUrl), streamKey, false);
        });
    });
});
//# sourceMappingURL=StartStreamUseCase.test.js.map