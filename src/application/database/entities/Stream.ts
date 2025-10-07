import { randomBytes } from "crypto";
import { BaseEntity } from "./Base";

export enum StreamState {
  PENDING = "pending",
  RUNNING = "running",
  STOPPED = "stopped",
  FAILED = "failed",
  RECONCILING = "reconciling",
}

interface StreamProps extends BaseEntity {
  cameraUrl: string;
  streamKey: string;
  courtId: string;
  state: StreamState;
  hasAudio: boolean;
  processId?: number;
}

export class StreamEntity implements BaseEntity {
  private constructor(private readonly props: StreamProps) {}

  public static create(
    cameraUrl: string,
    streamKey: string,
    courtId: string,
    hasAudio: boolean = false
  ): StreamEntity {
    const now = new Date();
    const timestamp = Date.now().toString(36);
    const random = randomBytes(8).toString("hex");
    const id = `stream_${timestamp}_${random}`;
    return new StreamEntity({
      id,
      cameraUrl,
      streamKey,
      courtId,
      state: StreamState.PENDING,
      hasAudio,
      createdAt: now,
      updatedAt: now,
    });
  }

  public static fromPersistence(props: StreamProps): StreamEntity {
    return new StreamEntity(props);
  }

  // Getters
  public get id(): string {
    return this.props.id;
  }

  public get cameraUrl(): string {
    return this.props.cameraUrl;
  }

  public get streamKey(): string {
    return this.props.streamKey;
  }

  public get courtId(): string {
    return this.props.courtId;
  }

  public get state(): StreamState {
    return this.props.state;
  }

  public get hasAudio(): boolean {
    return this.props.hasAudio;
  }

  public get processId(): number | undefined {
    return this.props.processId;
  }

  public get createdAt(): Date {
    return this.props.createdAt;
  }

  public get updatedAt(): Date {
    return this.props.updatedAt;
  }

  // Business methods
  public start(processId: number): void {
    if (
      this.props.state !== StreamState.PENDING &&
      this.props.state !== StreamState.STOPPED
    ) {
      throw new Error(`Cannot start stream in ${this.props.state} state`);
    }

    this.props.state = StreamState.RUNNING;
    this.props.processId = processId;
    this.props.updatedAt = new Date();
  }

  public stop(): void {
    this.props.state = StreamState.STOPPED;
    this.props.updatedAt = new Date();
  }

  public markAsFailed(error?: string): void {
    console.log("mark as failed was called");
    // ignore if the stream is already stopped
    if (this.props.state === StreamState.STOPPED) return;

    this.props.state = StreamState.FAILED;
    // Keep processId so we can still terminate the process later
    this.props.updatedAt = new Date();
  }

  public updateAudioDetection(hasAudio: boolean): void {
    this.props.hasAudio = hasAudio;
    this.props.updatedAt = new Date();
  }

  public clearProcessId(): void {
    this.props.processId = undefined;
    this.props.updatedAt = new Date();
  }

  public updateProcessId(processId: number): void {
    if (this.props.state !== StreamState.RUNNING) {
      throw new Error(
        `Cannot update processId for stream in ${this.props.state} state`
      );
    }

    this.props.processId = processId;
    this.props.updatedAt = new Date();
  }

  public isRunning(): boolean {
    return this.props.state === StreamState.RUNNING;
  }

  public isStopped(): boolean {
    return this.props.state === StreamState.STOPPED;
  }

  public isFailed(): boolean {
    return this.props.state === StreamState.FAILED;
  }

  public setAudio(hasAudio: boolean): void {
    this.props.hasAudio = hasAudio;
    this.props.updatedAt = new Date();
  }

  public toJSON(): any {
    return {
      id: this.props.id,
      cameraUrl: this.props.cameraUrl,
      streamKey: this.props.streamKey,
      courtId: this.props.courtId,
      state: this.props.state,
      hasAudio: this.props.hasAudio,
      processId: this.props.processId,
      createdAt: this.props.createdAt.toISOString(),
      updatedAt: this.props.updatedAt.toISOString(),
    };
  }
}
