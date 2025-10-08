import { randomBytes } from "crypto";
import { BaseEntity } from "./Base";

export enum StreamState {
  PENDING = "pending",
  RUNNING = "running",
  STOPPED = "stopped",
  FAILED = "failed",
  RECONCILING = "reconciling",
}

interface StreamProps {
  cameraUrl: string;
  streamKey: string;
  courtId: string;
  state: StreamState;
  hasAudio: boolean;
  processId?: number;
}

export class StreamEntity extends BaseEntity {
  cameraUrl: string;
  streamKey: string;
  courtId: string;
  state: StreamState;
  hasAudio: boolean;
  processId?: number;
  private constructor(props: StreamProps) {
    super();
    this.cameraUrl = props.cameraUrl;
    this.streamKey = props.streamKey;
    this.courtId = props.courtId;
    this.state = props.state;
    this.hasAudio = props.hasAudio;
    this.processId = props.processId;
  }

  public static create(
    cameraUrl: string,
    streamKey: string,
    courtId: string,
    hasAudio: boolean = false
  ): StreamEntity {
    return new StreamEntity({
      cameraUrl,
      streamKey,
      courtId,
      state: StreamState.PENDING,
      hasAudio,
    });
  }

  public static fromPersistence(props: StreamProps): StreamEntity {
    return new StreamEntity(props);
  }

  // Business methods
  public start(processId: number): void {
    if (
      this.state !== StreamState.PENDING &&
      this.state !== StreamState.STOPPED
    ) {
      throw new Error(`Cannot start stream in ${this.state} state`);
    }

    this.state = StreamState.RUNNING;
    this.processId = processId;
    this.updatedAt = new Date();
  }

  public stop(): void {
    this.state = StreamState.STOPPED;
    this.updatedAt = new Date();
  }

  public markAsFailed(error?: string): void {
    console.log("mark as failed was called");
    // ignore if the stream is already stopped
    if (this.state === StreamState.STOPPED) return;

    this.state = StreamState.FAILED;
    // Keep processId so we can still terminate the process later
    this.updatedAt = new Date();
  }

  public updateAudioDetection(hasAudio: boolean): void {
    this.hasAudio = hasAudio;
    this.updatedAt = new Date();
  }

  public clearProcessId(): void {
    this.processId = undefined;
    this.updatedAt = new Date();
  }

  public updateProcessId(processId: number): void {
    if (this.state !== StreamState.RUNNING) {
      throw new Error(
        `Cannot update processId for stream in ${this.state} state`
      );
    }

    this.processId = processId;
    this.updatedAt = new Date();
  }

  public isRunning(): boolean {
    return this.state === StreamState.RUNNING;
  }

  public isStopped(): boolean {
    return this.state === StreamState.STOPPED;
  }

  public isFailed(): boolean {
    return this.state === StreamState.FAILED;
  }

  public setAudio(hasAudio: boolean): void {
    this.hasAudio = hasAudio;
    this.updatedAt = new Date();
  }

  public toJson() {
    return {
      id: this.id,
      cameraUrl: this.cameraUrl,
      streamKey: this.streamKey,
      courtId: this.courtId,
      state: this.state,
      hasAudio: this.hasAudio,
      processId: this.processId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
