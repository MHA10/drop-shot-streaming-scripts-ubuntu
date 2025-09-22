import { StreamState, StreamStateValidator } from '../../../src/domain/value-objects/StreamState';

describe('StreamState Value Object', () => {
  describe('Enum Values', () => {
    it('should have correct string values', () => {
      expect(StreamState.PENDING).toBe('pending');
      expect(StreamState.RUNNING).toBe('running');
      expect(StreamState.STOPPED).toBe('stopped');
      expect(StreamState.FAILED).toBe('failed');
      expect(StreamState.RECONCILING).toBe('reconciling');
    });
  });

  describe('StreamStateValidator', () => {
    describe('Valid Transitions', () => {
      it('should allow PENDING to RUNNING', () => {
        expect(StreamStateValidator.isValidTransition(StreamState.PENDING, StreamState.RUNNING)).toBe(true);
      });

      it('should allow PENDING to FAILED', () => {
        expect(StreamStateValidator.isValidTransition(StreamState.PENDING, StreamState.FAILED)).toBe(true);
      });

      it('should allow RUNNING to STOPPED', () => {
        expect(StreamStateValidator.isValidTransition(StreamState.RUNNING, StreamState.STOPPED)).toBe(true);
      });

      it('should allow RUNNING to FAILED', () => {
        expect(StreamStateValidator.isValidTransition(StreamState.RUNNING, StreamState.FAILED)).toBe(true);
      });

      it('should allow RUNNING to RECONCILING', () => {
        expect(StreamStateValidator.isValidTransition(StreamState.RUNNING, StreamState.RECONCILING)).toBe(true);
      });

      it('should allow STOPPED to RUNNING', () => {
        expect(StreamStateValidator.isValidTransition(StreamState.STOPPED, StreamState.RUNNING)).toBe(true);
      });

      it('should allow STOPPED to PENDING', () => {
        expect(StreamStateValidator.isValidTransition(StreamState.STOPPED, StreamState.PENDING)).toBe(true);
      });

      it('should allow FAILED to PENDING', () => {
        expect(StreamStateValidator.isValidTransition(StreamState.FAILED, StreamState.PENDING)).toBe(true);
      });

      it('should allow FAILED to RUNNING', () => {
        expect(StreamStateValidator.isValidTransition(StreamState.FAILED, StreamState.RUNNING)).toBe(true);
      });

      it('should allow RECONCILING to RUNNING', () => {
        expect(StreamStateValidator.isValidTransition(StreamState.RECONCILING, StreamState.RUNNING)).toBe(true);
      });

      it('should allow RECONCILING to FAILED', () => {
        expect(StreamStateValidator.isValidTransition(StreamState.RECONCILING, StreamState.FAILED)).toBe(true);
      });

      it('should allow RECONCILING to STOPPED', () => {
        expect(StreamStateValidator.isValidTransition(StreamState.RECONCILING, StreamState.STOPPED)).toBe(true);
      });
    });

    describe('Invalid Transitions', () => {
      it('should not allow PENDING to STOPPED', () => {
        expect(StreamStateValidator.isValidTransition(StreamState.PENDING, StreamState.STOPPED)).toBe(false);
      });

      it('should not allow PENDING to RECONCILING', () => {
        expect(StreamStateValidator.isValidTransition(StreamState.PENDING, StreamState.RECONCILING)).toBe(false);
      });

      it('should not allow RUNNING to PENDING', () => {
        expect(StreamStateValidator.isValidTransition(StreamState.RUNNING, StreamState.PENDING)).toBe(false);
      });

      it('should not allow STOPPED to FAILED', () => {
        expect(StreamStateValidator.isValidTransition(StreamState.STOPPED, StreamState.FAILED)).toBe(false);
      });

      it('should not allow STOPPED to RECONCILING', () => {
        expect(StreamStateValidator.isValidTransition(StreamState.STOPPED, StreamState.RECONCILING)).toBe(false);
      });

      it('should not allow FAILED to STOPPED', () => {
        expect(StreamStateValidator.isValidTransition(StreamState.FAILED, StreamState.STOPPED)).toBe(false);
      });

      it('should not allow FAILED to RECONCILING', () => {
        expect(StreamStateValidator.isValidTransition(StreamState.FAILED, StreamState.RECONCILING)).toBe(false);
      });
    });

    describe('Get Allowed Transitions', () => {
      it('should return correct allowed transitions for PENDING', () => {
        const allowed = StreamStateValidator.getAllowedTransitions(StreamState.PENDING);
        expect(allowed).toEqual([StreamState.RUNNING, StreamState.FAILED]);
      });

      it('should return correct allowed transitions for RUNNING', () => {
        const allowed = StreamStateValidator.getAllowedTransitions(StreamState.RUNNING);
        expect(allowed).toEqual([StreamState.STOPPED, StreamState.FAILED, StreamState.RECONCILING]);
      });

      it('should return correct allowed transitions for STOPPED', () => {
        const allowed = StreamStateValidator.getAllowedTransitions(StreamState.STOPPED);
        expect(allowed).toEqual([StreamState.RUNNING, StreamState.PENDING]);
      });

      it('should return correct allowed transitions for FAILED', () => {
        const allowed = StreamStateValidator.getAllowedTransitions(StreamState.FAILED);
        expect(allowed).toEqual([StreamState.PENDING, StreamState.RUNNING]);
      });

      it('should return correct allowed transitions for RECONCILING', () => {
        const allowed = StreamStateValidator.getAllowedTransitions(StreamState.RECONCILING);
        expect(allowed).toEqual([StreamState.RUNNING, StreamState.FAILED, StreamState.STOPPED]);
      });
    });
  });
});