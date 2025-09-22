"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const StreamState_1 = require("../../../src/domain/value-objects/StreamState");
describe('StreamState Value Object', () => {
    describe('Enum Values', () => {
        it('should have correct string values', () => {
            expect(StreamState_1.StreamState.PENDING).toBe('pending');
            expect(StreamState_1.StreamState.RUNNING).toBe('running');
            expect(StreamState_1.StreamState.STOPPED).toBe('stopped');
            expect(StreamState_1.StreamState.FAILED).toBe('failed');
            expect(StreamState_1.StreamState.RECONCILING).toBe('reconciling');
        });
    });
    describe('StreamStateValidator', () => {
        describe('Valid Transitions', () => {
            it('should allow PENDING to RUNNING', () => {
                expect(StreamState_1.StreamStateValidator.isValidTransition(StreamState_1.StreamState.PENDING, StreamState_1.StreamState.RUNNING)).toBe(true);
            });
            it('should allow PENDING to FAILED', () => {
                expect(StreamState_1.StreamStateValidator.isValidTransition(StreamState_1.StreamState.PENDING, StreamState_1.StreamState.FAILED)).toBe(true);
            });
            it('should allow RUNNING to STOPPED', () => {
                expect(StreamState_1.StreamStateValidator.isValidTransition(StreamState_1.StreamState.RUNNING, StreamState_1.StreamState.STOPPED)).toBe(true);
            });
            it('should allow RUNNING to FAILED', () => {
                expect(StreamState_1.StreamStateValidator.isValidTransition(StreamState_1.StreamState.RUNNING, StreamState_1.StreamState.FAILED)).toBe(true);
            });
            it('should allow RUNNING to RECONCILING', () => {
                expect(StreamState_1.StreamStateValidator.isValidTransition(StreamState_1.StreamState.RUNNING, StreamState_1.StreamState.RECONCILING)).toBe(true);
            });
            it('should allow STOPPED to RUNNING', () => {
                expect(StreamState_1.StreamStateValidator.isValidTransition(StreamState_1.StreamState.STOPPED, StreamState_1.StreamState.RUNNING)).toBe(true);
            });
            it('should allow STOPPED to PENDING', () => {
                expect(StreamState_1.StreamStateValidator.isValidTransition(StreamState_1.StreamState.STOPPED, StreamState_1.StreamState.PENDING)).toBe(true);
            });
            it('should allow FAILED to PENDING', () => {
                expect(StreamState_1.StreamStateValidator.isValidTransition(StreamState_1.StreamState.FAILED, StreamState_1.StreamState.PENDING)).toBe(true);
            });
            it('should allow FAILED to RUNNING', () => {
                expect(StreamState_1.StreamStateValidator.isValidTransition(StreamState_1.StreamState.FAILED, StreamState_1.StreamState.RUNNING)).toBe(true);
            });
            it('should allow RECONCILING to RUNNING', () => {
                expect(StreamState_1.StreamStateValidator.isValidTransition(StreamState_1.StreamState.RECONCILING, StreamState_1.StreamState.RUNNING)).toBe(true);
            });
            it('should allow RECONCILING to FAILED', () => {
                expect(StreamState_1.StreamStateValidator.isValidTransition(StreamState_1.StreamState.RECONCILING, StreamState_1.StreamState.FAILED)).toBe(true);
            });
            it('should allow RECONCILING to STOPPED', () => {
                expect(StreamState_1.StreamStateValidator.isValidTransition(StreamState_1.StreamState.RECONCILING, StreamState_1.StreamState.STOPPED)).toBe(true);
            });
        });
        describe('Invalid Transitions', () => {
            it('should not allow PENDING to STOPPED', () => {
                expect(StreamState_1.StreamStateValidator.isValidTransition(StreamState_1.StreamState.PENDING, StreamState_1.StreamState.STOPPED)).toBe(false);
            });
            it('should not allow PENDING to RECONCILING', () => {
                expect(StreamState_1.StreamStateValidator.isValidTransition(StreamState_1.StreamState.PENDING, StreamState_1.StreamState.RECONCILING)).toBe(false);
            });
            it('should not allow RUNNING to PENDING', () => {
                expect(StreamState_1.StreamStateValidator.isValidTransition(StreamState_1.StreamState.RUNNING, StreamState_1.StreamState.PENDING)).toBe(false);
            });
            it('should not allow STOPPED to FAILED', () => {
                expect(StreamState_1.StreamStateValidator.isValidTransition(StreamState_1.StreamState.STOPPED, StreamState_1.StreamState.FAILED)).toBe(false);
            });
            it('should not allow STOPPED to RECONCILING', () => {
                expect(StreamState_1.StreamStateValidator.isValidTransition(StreamState_1.StreamState.STOPPED, StreamState_1.StreamState.RECONCILING)).toBe(false);
            });
            it('should not allow FAILED to STOPPED', () => {
                expect(StreamState_1.StreamStateValidator.isValidTransition(StreamState_1.StreamState.FAILED, StreamState_1.StreamState.STOPPED)).toBe(false);
            });
            it('should not allow FAILED to RECONCILING', () => {
                expect(StreamState_1.StreamStateValidator.isValidTransition(StreamState_1.StreamState.FAILED, StreamState_1.StreamState.RECONCILING)).toBe(false);
            });
        });
        describe('Get Allowed Transitions', () => {
            it('should return correct allowed transitions for PENDING', () => {
                const allowed = StreamState_1.StreamStateValidator.getAllowedTransitions(StreamState_1.StreamState.PENDING);
                expect(allowed).toEqual([StreamState_1.StreamState.RUNNING, StreamState_1.StreamState.FAILED]);
            });
            it('should return correct allowed transitions for RUNNING', () => {
                const allowed = StreamState_1.StreamStateValidator.getAllowedTransitions(StreamState_1.StreamState.RUNNING);
                expect(allowed).toEqual([StreamState_1.StreamState.STOPPED, StreamState_1.StreamState.FAILED, StreamState_1.StreamState.RECONCILING]);
            });
            it('should return correct allowed transitions for STOPPED', () => {
                const allowed = StreamState_1.StreamStateValidator.getAllowedTransitions(StreamState_1.StreamState.STOPPED);
                expect(allowed).toEqual([StreamState_1.StreamState.RUNNING, StreamState_1.StreamState.PENDING]);
            });
            it('should return correct allowed transitions for FAILED', () => {
                const allowed = StreamState_1.StreamStateValidator.getAllowedTransitions(StreamState_1.StreamState.FAILED);
                expect(allowed).toEqual([StreamState_1.StreamState.PENDING, StreamState_1.StreamState.RUNNING]);
            });
            it('should return correct allowed transitions for RECONCILING', () => {
                const allowed = StreamState_1.StreamStateValidator.getAllowedTransitions(StreamState_1.StreamState.RECONCILING);
                expect(allowed).toEqual([StreamState_1.StreamState.RUNNING, StreamState_1.StreamState.FAILED, StreamState_1.StreamState.STOPPED]);
            });
        });
    });
});
//# sourceMappingURL=StreamState.test.js.map