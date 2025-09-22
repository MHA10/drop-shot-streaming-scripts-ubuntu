export declare enum StreamState {
    PENDING = "pending",
    RUNNING = "running",
    STOPPED = "stopped",
    FAILED = "failed",
    RECONCILING = "reconciling"
}
export declare class StreamStateValidator {
    static isValidTransition(from: StreamState, to: StreamState): boolean;
    static getAllowedTransitions(from: StreamState): StreamState[];
}
//# sourceMappingURL=StreamState.d.ts.map