"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Stream = void 0;
const StreamState_1 = require("../value-objects/StreamState");
class Stream {
    constructor(props) {
        this.props = props;
    }
    static create(id, cameraUrl, streamKey, hasAudio = false) {
        const now = new Date();
        return new Stream({
            id,
            cameraUrl,
            streamKey,
            state: StreamState_1.StreamState.PENDING,
            hasAudio,
            createdAt: now,
            updatedAt: now,
        });
    }
    static fromPersistence(props) {
        return new Stream(props);
    }
    // Getters
    get id() {
        return this.props.id;
    }
    get cameraUrl() {
        return this.props.cameraUrl;
    }
    get streamKey() {
        return this.props.streamKey;
    }
    get state() {
        return this.props.state;
    }
    get hasAudio() {
        return this.props.hasAudio;
    }
    get processId() {
        return this.props.processId;
    }
    get createdAt() {
        return this.props.createdAt;
    }
    get updatedAt() {
        return this.props.updatedAt;
    }
    // Business methods
    start(processId) {
        if (this.props.state !== StreamState_1.StreamState.PENDING &&
            this.props.state !== StreamState_1.StreamState.STOPPED) {
            throw new Error(`Cannot start stream in ${this.props.state} state`);
        }
        this.props.state = StreamState_1.StreamState.RUNNING;
        this.props.processId = processId;
        this.props.updatedAt = new Date();
    }
    stop() {
        if (this.props.state !== StreamState_1.StreamState.RUNNING) {
            throw new Error(`Cannot stop stream in ${this.props.state} state`);
        }
        this.props.state = StreamState_1.StreamState.STOPPED;
        this.props.processId = undefined;
        this.props.updatedAt = new Date();
    }
    markAsFailed(error) {
        this.props.state = StreamState_1.StreamState.FAILED;
        this.props.processId = undefined;
        this.props.updatedAt = new Date();
    }
    updateAudioDetection(hasAudio) {
        this.props.hasAudio = hasAudio;
        this.props.updatedAt = new Date();
    }
    isRunning() {
        return this.props.state === StreamState_1.StreamState.RUNNING;
    }
    isStopped() {
        return this.props.state === StreamState_1.StreamState.STOPPED;
    }
    isFailed() {
        return this.props.state === StreamState_1.StreamState.FAILED;
    }
    toJSON() {
        return {
            id: this.props.id.value,
            cameraUrl: this.props.cameraUrl.value,
            streamKey: this.props.streamKey,
            state: this.props.state,
            hasAudio: this.props.hasAudio,
            processId: this.props.processId,
            createdAt: this.props.createdAt.toISOString(),
            updatedAt: this.props.updatedAt.toISOString(),
        };
    }
}
exports.Stream = Stream;
//# sourceMappingURL=Stream.js.map