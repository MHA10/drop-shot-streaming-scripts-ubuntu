import { StartStreamRequest } from "../../application/interfaces/StartStreamUseCase.types";
import { StreamUrl } from "../value-objects/StreamUrl";

export interface FFmpegCommand {
  readonly command: string;
  readonly args: string[];
  readonly fullCommand: string;
}

export interface FFmpegProcess {
  readonly pid: number;
  readonly command: FFmpegCommand;
  readonly startTime: Date;
}

export interface AdOverlayPaths {
  left?: string | null;
  right?: string | null;
}

export interface FFmpegService {
  /**
   * Start an FFmpeg stream process
   */
  startStream(
    cameraUrl: StreamUrl,
    streamKey: string,
    hasAudio: boolean,
    courtId: string,
    retry: {
      event: StartStreamRequest;
      onRetryStream: (event: StartStreamRequest) => Promise<void>;
    },
    isScorecardActivated?: boolean,
    adPaths?: AdOverlayPaths
  ): Promise<FFmpegProcess>;

  /**
   * Stop an FFmpeg process by PID
   */
  stopStream(pid: number): Promise<void>;

  /**
   * Check if a process is running
   */
  isProcessRunning(pid: number): Promise<boolean>;

  /**
   * Detect if a stream has audio
   */
  detectAudio(cameraUrl: StreamUrl): Promise<boolean>;

  /**
   * Build FFmpeg command for streaming
   */
  buildStreamCommand(
    cameraUrl: StreamUrl,
    streamKey: string,
    hasAudio: boolean,
    courtId: string,
    isScorecardActivated?: boolean,
    adPaths?: AdOverlayPaths
  ): FFmpegCommand;

  /**
   * Get all running FFmpeg processes managed by this service
   */
  getRunningProcesses(): Promise<FFmpegProcess[]>;

  /**
   * Kill all FFmpeg processes (cleanup)
   */
  killAllProcesses(): Promise<void>;
}
