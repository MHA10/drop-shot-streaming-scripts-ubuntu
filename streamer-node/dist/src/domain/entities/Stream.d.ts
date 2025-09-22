import { StreamId } from "../value-objects/StreamId";
import { StreamUrl } from "../value-objects/StreamUrl";
import { StreamState } from "../value-objects/StreamState";
export interface StreamProps {
    id: StreamId;
    cameraUrl: StreamUrl;
    streamKey: string;
    state: StreamState;
    hasAudio: boolean;
    processId?: number;
    createdAt: Date;
    updatedAt: Date;
}
export declare class Stream {
    private props;
    private constructor();
    static create(id: StreamId, cameraUrl: StreamUrl, streamKey: string, hasAudio?: boolean): Stream;
    static fromPersistence(props: StreamProps): Stream;
    get id(): StreamId;
    get cameraUrl(): StreamUrl;
    get streamKey(): string;
    get state(): StreamState;
    get hasAudio(): boolean;
    get processId(): number | undefined;
    get createdAt(): Date;
    get updatedAt(): Date;
    start(processId: number): void;
    stop(): void;
    markAsFailed(error?: string): void;
    updateAudioDetection(hasAudio: boolean): void;
    isRunning(): boolean;
    isStopped(): boolean;
    isFailed(): boolean;
    toJSON(): any;
}
//# sourceMappingURL=Stream.d.ts.map