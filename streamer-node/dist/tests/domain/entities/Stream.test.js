"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Stream_1 = require("../../../src/domain/entities/Stream");
const StreamId_1 = require("../../../src/domain/value-objects/StreamId");
const StreamUrl_1 = require("../../../src/domain/value-objects/StreamUrl");
const StreamState_1 = require("../../../src/domain/value-objects/StreamState");
describe('Stream Entity', () => {
    const validStreamId = StreamId_1.StreamId.create();
    const validCameraUrl = StreamUrl_1.StreamUrl.create('rtsp://example.com/stream');
    const validStreamKey = 'test-stream-key';
    describe('Creation', () => {
        it('should create a stream with valid parameters', () => {
            const stream = Stream_1.Stream.create(validStreamId, validCameraUrl, validStreamKey);
            expect(stream.id).toBe(validStreamId);
            expect(stream.cameraUrl).toBe(validCameraUrl);
            expect(stream.streamKey).toBe(validStreamKey);
            expect(stream.state).toBe(StreamState_1.StreamState.PENDING);
            expect(stream.hasAudio).toBe(false);
            expect(stream.processId).toBeUndefined();
            expect(stream.createdAt).toBeInstanceOf(Date);
            expect(stream.updatedAt).toBeInstanceOf(Date);
        });
        it('should create a stream with audio detection enabled', () => {
            const stream = Stream_1.Stream.create(validStreamId, validCameraUrl, validStreamKey, true);
            expect(stream.hasAudio).toBe(true);
        });
    });
    describe('State Management', () => {
        let stream;
        beforeEach(() => {
            stream = Stream_1.Stream.create(StreamId_1.StreamId.create(), validCameraUrl, validStreamKey);
        });
        it('should start a stream successfully', () => {
            const processId = 12345;
            stream.start(processId);
            expect(stream.state).toBe(StreamState_1.StreamState.RUNNING);
            expect(stream.processId).toBe(processId);
            expect(stream.isRunning()).toBe(true);
        });
        it('should stop a running stream', () => {
            stream.start(12345);
            stream.stop();
            expect(stream.state).toBe(StreamState_1.StreamState.STOPPED);
            expect(stream.processId).toBeUndefined();
            expect(stream.isStopped()).toBe(true);
        });
        it('should mark a stream as failed', () => {
            stream.markAsFailed('Test error');
            expect(stream.state).toBe(StreamState_1.StreamState.FAILED);
            expect(stream.processId).toBeUndefined();
            expect(stream.isFailed()).toBe(true);
        });
        it('should update audio detection', () => {
            expect(stream.hasAudio).toBe(false);
            stream.updateAudioDetection(true);
            expect(stream.hasAudio).toBe(true);
        });
        it('should throw error when starting already running stream', () => {
            stream.start(12345);
            expect(() => stream.start(54321)).toThrow('Cannot start stream in running state');
        });
        it('should throw error when stopping non-running stream', () => {
            expect(() => stream.stop()).toThrow('Cannot stop stream in pending state');
        });
    });
    describe('Serialization', () => {
        it('should serialize to JSON correctly', () => {
            const stream = Stream_1.Stream.create(validStreamId, validCameraUrl, validStreamKey);
            stream.start(12345);
            const json = stream.toJSON();
            expect(json).toEqual({
                id: validStreamId.value,
                cameraUrl: validCameraUrl.value,
                streamKey: validStreamKey,
                state: StreamState_1.StreamState.RUNNING,
                hasAudio: false,
                processId: 12345,
                createdAt: stream.createdAt.toISOString(),
                updatedAt: stream.updatedAt.toISOString()
            });
        });
    });
});
//# sourceMappingURL=Stream.test.js.map