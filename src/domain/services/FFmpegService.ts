import { StartStreamRequest } from "../../application/interfaces/StartStreamUseCase.types";

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

export interface FFmpegService {
  /**
   * Start an FFmpeg stream process
   */
  startStream(
    cameraUrl: string,
    streamKey: string,
    hasAudio: boolean,
    retry: {
      event: StartStreamRequest;
      onRetryStream: (event: StartStreamRequest) => Promise<void>;
    }
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
  detectAudio(cameraUrl: string): Promise<boolean>;

  /**
   * Build FFmpeg command for streaming
   */
  buildStreamCommand(
    cameraUrl: string,
    streamKey: string,
    hasAudio: boolean
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
