import { StreamId } from '../../../src/domain/value-objects/StreamId';

describe('StreamId Value Object', () => {
  describe('Creation', () => {
    it('should create a new StreamId with custom format', () => {
      const streamId = StreamId.create();
      
      expect(streamId).toBeInstanceOf(StreamId);
      expect(streamId.value).toMatch(/^stream_[a-z0-9]+_[a-f0-9]{16}$/);
    });

    it('should create StreamId from valid string', () => {
      const validId = 'stream_abc123_def456789abcdef0';
      const streamId = StreamId.fromString(validId);
      
      expect(streamId.value).toBe(validId);
    });

    it('should accept any non-empty string', () => {
      const customId = 'custom-stream-id';
      const streamId = StreamId.fromString(customId);
      
      expect(streamId.value).toBe(customId);
    });

    it('should throw error for empty string', () => {
      expect(() => StreamId.fromString('')).toThrow('StreamId cannot be empty');
    });
  });

  describe('Equality', () => {
    it('should return true for equal StreamIds', () => {
      const uuid = '123e4567-e89b-12d3-a456-426614174000';
      const streamId1 = StreamId.fromString(uuid);
      const streamId2 = StreamId.fromString(uuid);
      
      expect(streamId1.equals(streamId2)).toBe(true);
    });

    it('should return false for different StreamIds', () => {
      const streamId1 = StreamId.create();
      const streamId2 = StreamId.create();
      
      expect(streamId1.equals(streamId2)).toBe(false);
    });
  });

  describe('String Conversion', () => {
    it('should convert to string correctly', () => {
      const uuid = '123e4567-e89b-12d3-a456-426614174000';
      const streamId = StreamId.fromString(uuid);
      
      expect(streamId.toString()).toBe(uuid);
    });
  });
});