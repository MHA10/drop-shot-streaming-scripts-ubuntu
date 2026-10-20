import { StreamId } from "../value-objects/StreamId";

export interface AdSpec {
  url: string;
  durationSec?: number;
}

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
  readonly action: "start" | "stop";
  readonly cameraUrl: string;
  readonly streamKey: string;
  readonly reconciliationMode?: boolean;
  readonly isScorecardActivated?: boolean;
  readonly ads?: AdSpec[];
  // Backend's id for this match, if it sends one in the start event. The
  // backend sends it in `match_state` instead (SSEMatchStateEvent); this field
  // stays as a fallback in case it is ever added here too.
  readonly matchId?: string;
}

// Backend `match_state` event: which scored match (live_match id) is active
// on a court right now. Sent when a match starts or ends, and repeated every
// minute while one is active. Null = no active match on that court.
export interface SSEMatchStateEvent extends DomainEvent {
  readonly eventType: "SSEMatchStateEvent";
  readonly courtId: string;
  readonly activeMatchId: string | null;
}

export type StreamDomainEvent =
  | StreamStartedEvent
  | StreamStoppedEvent
  | StreamFailedEvent
  | AudioDetectedEvent
  | SSEConnectionEvent
  | SSEStreamEvent
  | SSEMatchStateEvent;
