import { StreamEntity } from "../database/entities/Stream";

export interface StartStreamRequest {
  cameraUrl: string;
  streamKey: string;
  courtId: string;
  detectAudio?: boolean;
}

export interface StartStreamResponse {
  streamId: string;
  processId: number;
  hasAudio: boolean;
}

export enum StreamAction {
  MULTIPLE_STREAMS_RUNNING = "multiple_streams_running",
  STREAM_RUNNING_WITHOUT_PID = "stream_running_without_pid",
  DUPLICATE_EVENT = "duplicate_event",
  INVALID_YOUTUBE_STREAM_KEY = "invalid_youtube_stream_key",
  DEAD_PROCESS_DETECTED = "dead_process_detected",
}

export type StartStreamEvent =
  | {
      action: StreamAction.MULTIPLE_STREAMS_RUNNING;
      streamList: StreamEntity[];
    }
  | {
      action:
        | StreamAction.STREAM_RUNNING_WITHOUT_PID
        | StreamAction.DUPLICATE_EVENT
        | StreamAction.INVALID_YOUTUBE_STREAM_KEY
        | StreamAction.DEAD_PROCESS_DETECTED;
      stream: StreamEntity;
    };

type TrueOrFalse<T> = { isValid: true } | { isValid: false; data: T };

export type ValidationEvent = TrueOrFalse<StartStreamEvent>;

export type ShouldStartStream = TrueOrFalse<StartStreamResponse>;
