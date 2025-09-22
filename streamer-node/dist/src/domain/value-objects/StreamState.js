"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StreamStateValidator = exports.StreamState = void 0;
var StreamState;
(function (StreamState) {
    StreamState["PENDING"] = "pending";
    StreamState["RUNNING"] = "running";
    StreamState["STOPPED"] = "stopped";
    StreamState["FAILED"] = "failed";
    StreamState["RECONCILING"] = "reconciling";
})(StreamState || (exports.StreamState = StreamState = {}));
class StreamStateValidator {
    static isValidTransition(from, to) {
        const validTransitions = {
            [StreamState.PENDING]: [StreamState.RUNNING, StreamState.FAILED],
            [StreamState.RUNNING]: [StreamState.STOPPED, StreamState.FAILED, StreamState.RECONCILING],
            [StreamState.STOPPED]: [StreamState.RUNNING, StreamState.PENDING],
            [StreamState.FAILED]: [StreamState.PENDING, StreamState.RUNNING],
            [StreamState.RECONCILING]: [StreamState.RUNNING, StreamState.FAILED, StreamState.STOPPED]
        };
        return validTransitions[from]?.includes(to) ?? false;
    }
    static getAllowedTransitions(from) {
        const validTransitions = {
            [StreamState.PENDING]: [StreamState.RUNNING, StreamState.FAILED],
            [StreamState.RUNNING]: [StreamState.STOPPED, StreamState.FAILED, StreamState.RECONCILING],
            [StreamState.STOPPED]: [StreamState.RUNNING, StreamState.PENDING],
            [StreamState.FAILED]: [StreamState.PENDING, StreamState.RUNNING],
            [StreamState.RECONCILING]: [StreamState.RUNNING, StreamState.FAILED, StreamState.STOPPED]
        };
        return validTransitions[from] ?? [];
    }
}
exports.StreamStateValidator = StreamStateValidator;
//# sourceMappingURL=StreamState.js.map