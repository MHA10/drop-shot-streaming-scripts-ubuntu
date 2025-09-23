import { Stream } from '../../../src/domain/entities/Stream';
import { StreamId } from '../../../src/domain/value-objects/StreamId';
import { StreamUrl } from '../../../src/domain/value-objects/StreamUrl';
import { StreamState } from '../../../src/domain/value-objects/StreamState';

describe('Stream Entity', () => {
  const validStreamId = StreamId.create();
  const validCameraUrl = StreamUrl.create('rtsp://example.com/stream');
  const validStreamKey = 'test-stream-key';
  const validCourtId = 'court-123';

  describe('Creation', () => {
    it('should create a stream with valid parameters', () => {
      const stream = Stream.create(validStreamId, validCameraUrl, validStreamKey, validCourtId);

      expect(stream.id).toBe(validStreamId);
      expect(stream.cameraUrl).toBe(validCameraUrl);
      expect(stream.streamKey).toBe(validStreamKey);
      expect(stream.courtId).toBe(validCourtId);
      expect(stream.state).toBe(StreamState.PENDING);
      expect(stream.hasAudio).toBe(false);
      expect(stream.processId).toBeUndefined();
      expect(stream.createdAt).toBeInstanceOf(Date);
      expect(stream.updatedAt).toBeInstanceOf(Date);
    });

    it('should create a stream with audio detection enabled', () => {
      const stream = Stream.create(validStreamId, validCameraUrl, validStreamKey, validCourtId, true);
      expect(stream.hasAudio).toBe(true);
    });
  });

  describe('State Management', () => {
    let stream: Stream;

    beforeEach(() => {
      stream = Stream.create(StreamId.create(), validCameraUrl, validStreamKey, validCourtId);
    });

    it('should start a stream successfully', () => {
      const processId = 12345;
      
      stream.start(processId);

      expect(stream.state).toBe(StreamState.RUNNING);
      expect(stream.processId).toBe(processId);
      expect(stream.isRunning()).toBe(true);
    });

    it('should stop a running stream', () => {
      stream.start(12345);
      
      stream.stop();

      expect(stream.state).toBe(StreamState.STOPPED);
      expect(stream.processId).toBeUndefined();
      expect(stream.isStopped()).toBe(true);
    });

    it('should mark a stream as failed', () => {
      stream.markAsFailed('Test error');

      expect(stream.state).toBe(StreamState.FAILED);
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
      const stream = Stream.create(validStreamId, validCameraUrl, validStreamKey, validCourtId);
      stream.start(12345);
      
      const json = stream.toJSON();
      
      expect(json).toEqual({
        id: validStreamId.value,
        cameraUrl: validCameraUrl.value,
        streamKey: validStreamKey,
        courtId: validCourtId,
        state: StreamState.RUNNING,
        hasAudio: false,
        processId: 12345,
        createdAt: stream.createdAt.toISOString(),
        updatedAt: stream.updatedAt.toISOString()
      });
    });
  });
});