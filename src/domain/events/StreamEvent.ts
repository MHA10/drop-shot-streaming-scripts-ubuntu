import { StreamId } from "../value-objects/StreamId";

export interface DomainEvent {
  readonly eventId: string;
  readonly occurredOn: Date;
  readonly eventType: string;
}

export interface StreamStartedEvent extends DomainEvent {
  readonly eventType: "StreamStarted";
  readonly streamId: StreamId;
  readonly processId: number;
  readonly cameraUrl: string;
  readonly streamKey: string;
  readonly courtId: string;
}

export interface StreamStoppedEvent extends DomainEvent {
  readonly eventType: "StreamStopped";
  readonly streamId: StreamId;
  readonly courtId: string;
  readonly reason?: string;
}

export interface StreamFailedEvent extends DomainEvent {
  readonly eventType: "StreamFailed";
  readonly streamId: StreamId;
  readonly courtId: string;
  readonly error: string;
  readonly processId?: number;
}

export interface AudioDetectedEvent extends DomainEvent {
  readonly eventType: "AudioDetected";
  readonly streamId: StreamId;
  readonly courtId: string;
  readonly hasAudio: boolean;
}

export interface SSEConnectionEvent extends DomainEvent {
  readonly eventType: "SSEConnectionEvent";
  readonly status: "connected" | "disconnected" | "reconnecting";
  readonly retryCount?: number;
}

export interface SSEStreamEvent extends DomainEvent {
  readonly eventType: "SSEStreamEvent";
  readonly courtId: string;
  readonly action: "start" | "stop" | "version-update";
  readonly cameraUrl: string;
  readonly streamKey: string;
  readonly reconciliationMode?: boolean;
}

export type StreamDomainEvent =
  | StreamStartedEvent
  | StreamStoppedEvent
  | StreamFailedEvent
  | AudioDetectedEvent
  | SSEConnectionEvent
  | SSEStreamEvent;
