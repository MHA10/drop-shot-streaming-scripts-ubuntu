"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const FileSystemStreamRepository_1 = require("../../../src/infrastructure/repositories/FileSystemStreamRepository");
const Stream_1 = require("../../../src/domain/entities/Stream");
const StreamId_1 = require("../../../src/domain/value-objects/StreamId");
const StreamUrl_1 = require("../../../src/domain/value-objects/StreamUrl");
const StreamState_1 = require("../../../src/domain/value-objects/StreamState");
const fs_1 = require("fs");
const path_1 = require("path");
// Mock fs module
jest.mock('fs', () => ({
    promises: {
        mkdir: jest.fn(),
        writeFile: jest.fn(),
        readFile: jest.fn(),
        readdir: jest.fn(),
        unlink: jest.fn(),
        access: jest.fn()
    }
}));
const mockFs = fs_1.promises;
describe('FileSystemStreamRepository', () => {
    let repository;
    let mockLogger;
    const testDir = '/tmp/test-streams';
    beforeEach(() => {
        mockLogger = {
            info: jest.fn(),
            error: jest.fn(),
            warn: jest.fn(),
            debug: jest.fn()
        };
        repository = new FileSystemStreamRepository_1.FileSystemStreamRepository(testDir, mockLogger);
        // Reset all mocks
        jest.clearAllMocks();
    });
    describe('save', () => {
        it('should save stream to file system', async () => {
            const streamId = StreamId_1.StreamId.create();
            const cameraUrl = StreamUrl_1.StreamUrl.create('rtsp://camera1.example.com');
            const stream = Stream_1.Stream.create(streamId, cameraUrl, 'stream1', true);
            mockFs.mkdir.mockResolvedValue(undefined);
            mockFs.writeFile.mockResolvedValue();
            await repository.save(stream);
            expect(mockFs.mkdir).toHaveBeenCalledWith(testDir, { recursive: true });
            expect(mockFs.writeFile).toHaveBeenCalledWith((0, path_1.join)(testDir, `${streamId.value}.json`), expect.stringContaining(streamId.value), 'utf8');
        });
        it('should handle file system errors', async () => {
            const streamId = StreamId_1.StreamId.create();
            const cameraUrl = StreamUrl_1.StreamUrl.create('rtsp://camera1.example.com');
            const stream = Stream_1.Stream.create(streamId, cameraUrl, 'stream1', true);
            mockFs.mkdir.mockResolvedValue(undefined);
            mockFs.writeFile.mockRejectedValue(new Error('Write failed'));
            await expect(repository.save(stream)).rejects.toThrow('Write failed');
            expect(mockLogger.error).toHaveBeenCalled();
        });
    });
    describe('findById', () => {
        it('should find stream by id', async () => {
            const streamId = StreamId_1.StreamId.create();
            const streamData = {
                id: streamId.value,
                cameraUrl: 'rtsp://camera1.example.com',
                streamKey: 'stream1',
                hasAudio: true,
                state: StreamState_1.StreamState.RUNNING,
                processId: 12345,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            mockFs.readFile.mockResolvedValue(JSON.stringify(streamData));
            const result = await repository.findById(streamId);
            expect(result).toBeInstanceOf(Stream_1.Stream);
            expect(result?.id.value).toBe(streamId.value);
            expect(mockFs.readFile).toHaveBeenCalledWith((0, path_1.join)(testDir, `${streamId.value}.json`), 'utf8');
        });
        it('should return null when stream not found', async () => {
            const streamId = StreamId_1.StreamId.create();
            mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });
            const result = await repository.findById(streamId);
            expect(result).toBeNull();
        });
        it('should handle invalid JSON data', async () => {
            const streamId = StreamId_1.StreamId.create();
            mockFs.readFile.mockResolvedValue('invalid json');
            await expect(repository.findById(streamId)).rejects.toThrow();
            expect(mockLogger.error).toHaveBeenCalled();
        });
    });
    describe('findAll', () => {
        it('should find all streams', async () => {
            const streamId1 = StreamId_1.StreamId.create();
            const streamId2 = StreamId_1.StreamId.create();
            mockFs.readdir.mockResolvedValue([
                `${streamId1.value}.json`,
                `${streamId2.value}.json`,
                'other-file.txt'
            ]);
            const streamData1 = {
                id: streamId1.value,
                cameraUrl: 'rtsp://camera1.example.com',
                streamKey: 'stream1',
                hasAudio: true,
                state: StreamState_1.StreamState.RUNNING,
                processId: 12345,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            const streamData2 = {
                id: streamId2.value,
                cameraUrl: 'rtsp://camera2.example.com',
                streamKey: 'stream2',
                hasAudio: false,
                state: StreamState_1.StreamState.STOPPED,
                processId: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            };
            mockFs.readFile
                .mockResolvedValueOnce(JSON.stringify(streamData1))
                .mockResolvedValueOnce(JSON.stringify(streamData2));
            const result = await repository.findAll();
            expect(result).toHaveLength(2);
            expect(result[0].id.value).toBe(streamId1.value);
            expect(result[1].id.value).toBe(streamId2.value);
        });
        it('should handle directory not found', async () => {
            mockFs.readdir.mockRejectedValue({ code: 'ENOENT' });
            await expect(repository.findAll()).rejects.toMatchObject({ code: 'ENOENT' });
            expect(mockLogger.error).toHaveBeenCalledWith('Failed to read all streams', expect.objectContaining({
                directory: expect.any(String),
                error: expect.any(String)
            }));
        });
    });
    describe('delete', () => {
        it('should delete stream file', async () => {
            const streamId = StreamId_1.StreamId.create();
            mockFs.unlink.mockResolvedValue();
            await repository.delete(streamId);
            expect(mockFs.unlink).toHaveBeenCalledWith((0, path_1.join)(testDir, `${streamId.value}.json`));
        });
        it('should handle file not found during delete', async () => {
            const streamId = StreamId_1.StreamId.create();
            mockFs.unlink.mockRejectedValue({ code: 'ENOENT' });
            // Should not throw error
            await repository.delete(streamId);
            // The implementation returns early for ENOENT, no logging
            expect(mockLogger.error).not.toHaveBeenCalled();
        });
    });
    describe('exists', () => {
        it('should return true when stream exists', async () => {
            const streamId = StreamId_1.StreamId.create();
            mockFs.access.mockResolvedValue();
            const result = await repository.exists(streamId);
            expect(result).toBe(true);
            expect(mockFs.access).toHaveBeenCalledWith((0, path_1.join)(testDir, `${streamId.value}.json`));
        });
        it('should return false when stream does not exist', async () => {
            const streamId = StreamId_1.StreamId.create();
            mockFs.access.mockRejectedValue({ code: 'ENOENT' });
            const result = await repository.exists(streamId);
            expect(result).toBe(false);
        });
    });
});
//# sourceMappingURL=FileSystemStreamRepository.test.js.map