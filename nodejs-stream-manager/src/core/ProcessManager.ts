import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ProcessInfo, StreamConfig, AudioDetectionResult } from '../types';
import { Logger } from '../utils/Logger';
import { ConfigManager } from '../utils/ConfigManager';

export class ProcessManager {
  private processes: Map<string, ChildProcess> = new Map();
  private processInfo: Map<string, ProcessInfo> = new Map();
  private logger: Logger;
  private config: ReturnType<ConfigManager['getConfig']>;

  constructor() {
    this.logger = Logger.getInstance();
    this.config = ConfigManager.getInstance().getConfig();
    this.ensurePidDirectory();
  }

  private ensurePidDirectory(): void {
    if (!fs.existsSync(this.config.paths.pidDir)) {
      fs.mkdirSync(this.config.paths.pidDir, { recursive: true });
    }
  }

  public async startStream(
    streamConfig: StreamConfig, 
    audioDetection: AudioDetectionResult
  ): Promise<ProcessInfo | null> {
    try {
      if (this.processes.has(streamConfig.id)) {
        this.logger.warn('Stream already running', { streamId: streamConfig.id });
        return this.processInfo.get(streamConfig.id) || null;
      }

      const command = this.buildFFmpegCommand(streamConfig, audioDetection);
      this.logger.info('Starting stream process', { 
        streamId: streamConfig.id, 
        command: command.join(' '),
        hasAudio: audioDetection.hasAudio 
      });

      const ffmpeg = spawn('ffmpeg', command, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false
      });

      if (!ffmpeg.pid) {
        throw new Error('Failed to start FFmpeg process');
      }

      const processInfo: ProcessInfo = {
        pid: ffmpeg.pid,
        streamId: streamConfig.id,
        startTime: Date.now(),
        command: `ffmpeg ${command.join(' ')}`,
        status: 'running'
      };

      this.processes.set(streamConfig.id, ffmpeg);
      this.processInfo.set(streamConfig.id, processInfo);
      this.writePidFile(streamConfig.id, ffmpeg.pid);

      // Handle process events
      this.setupProcessHandlers(streamConfig.id, ffmpeg);

      this.logger.stream(streamConfig.id, 'Stream started successfully', { 
        pid: ffmpeg.pid,
        hasAudio: audioDetection.hasAudio 
      });

      return processInfo;

    } catch (error) {
      this.logger.error('Failed to start stream', error as Error, { streamId: streamConfig.id });
      return null;
    }
  }

  private buildFFmpegCommand(streamConfig: StreamConfig, audioDetection: AudioDetectionResult): string[] {
    const command: string[] = [];

    // Input parameters
    command.push('-rtsp_transport', this.config.streaming.rtspTransport);
    command.push('-fflags', '+genpts');
    command.push('-avoid_negative_ts', 'make_zero');
    command.push('-i', streamConfig.rtspUrl);

    // Add silent audio if no audio detected
    if (!audioDetection.hasAudio) {
      command.push('-f', 'lavfi');
      command.push('-i', this.config.streaming.silentAudioParams.source);
    }

    // Video encoding parameters
    command.push('-c:v', streamConfig.videoParams.codec);
    command.push('-b:v', streamConfig.videoParams.bitrate);
    command.push('-s', streamConfig.videoParams.resolution);
    command.push('-r', streamConfig.videoParams.framerate);
    command.push('-g', streamConfig.videoParams.keyframeInterval);
    command.push('-preset', streamConfig.videoParams.preset);

    // Audio encoding parameters
    command.push('-c:a', streamConfig.audioParams.codec);
    command.push('-b:a', streamConfig.audioParams.bitrate);
    command.push('-ar', streamConfig.audioParams.sampleRate);
    command.push('-ac', streamConfig.audioParams.channels);

    // If using silent audio, ensure shortest stream duration
    if (!audioDetection.hasAudio) {
      command.push('-shortest');
    }

    // Output format and URL
    command.push('-f', 'flv');
    command.push('-y'); // Overwrite output
    command.push(streamConfig.rtmpUrl);

    return command;
  }

  private setupProcessHandlers(streamId: string, process: ChildProcess): void {
    let stdoutBuffer = '';
    let stderrBuffer = '';

    process.stdout?.on('data', (data) => {
      stdoutBuffer += data.toString();
      // Log significant stdout messages (keep buffer manageable)
      if (stdoutBuffer.length > 1000) {
        this.logger.debug('FFmpeg stdout', { streamId, output: stdoutBuffer.substring(0, 500) });
        stdoutBuffer = '';
      }
    });

    process.stderr?.on('data', (data) => {
      stderrBuffer += data.toString();
      // Log errors and important messages
      const output = data.toString();
      if (output.includes('error') || output.includes('failed') || output.includes('warning')) {
        this.logger.warn('FFmpeg stderr', { streamId, output: output.substring(0, 200) });
      }
      
      // Keep buffer manageable
      if (stderrBuffer.length > 2000) {
        stderrBuffer = stderrBuffer.substring(1000);
      }
    });

    process.on('exit', (code, signal) => {
      this.logger.process(process.pid!, 'Process exited', { 
        streamId, 
        code, 
        signal,
        stderr: stderrBuffer.substring(-500) // Last 500 chars of stderr
      });

      const info = this.processInfo.get(streamId);
      if (info) {
        info.status = code === 0 ? 'stopped' : 'failed';
        this.processInfo.set(streamId, info);
      }

      this.cleanup(streamId);
    });

    process.on('error', (error) => {
      this.logger.error('Process error', error, { streamId, pid: process.pid });
      
      const info = this.processInfo.get(streamId);
      if (info) {
        info.status = 'failed';
        this.processInfo.set(streamId, info);
      }

      this.cleanup(streamId);
    });
  }

  public stopStream(streamId: string): boolean {
    const process = this.processes.get(streamId);
    if (!process) {
      this.logger.warn('Stream not found for stopping', { streamId });
      return false;
    }

    this.logger.stream(streamId, 'Stopping stream', { pid: process.pid });

    try {
      // Graceful termination first
      process.kill('SIGTERM');
      
      // Force kill after timeout
      setTimeout(() => {
        if (!process.killed) {
          this.logger.warn('Force killing stream process', { streamId, pid: process.pid });
          process.kill('SIGKILL');
        }
      }, this.config.streaming.processTimeoutMs);

      return true;
    } catch (error) {
      this.logger.error('Failed to stop stream', error as Error, { streamId, pid: process.pid });
      return false;
    }
  }

  public getProcessInfo(streamId: string): ProcessInfo | null {
    return this.processInfo.get(streamId) || null;
  }

  public getAllProcesses(): ProcessInfo[] {
    return Array.from(this.processInfo.values());
  }

  public isStreamRunning(streamId: string): boolean {
    const process = this.processes.get(streamId);
    const info = this.processInfo.get(streamId);
    return !!(process && !process.killed && info?.status === 'running');
  }

  public validateProcess(streamId: string): boolean {
    const process = this.processes.get(streamId);
    if (!process || process.killed) {
      return false;
    }

    try {
      // Check if process is still alive
      process.kill(0);
      return true;
    } catch {
      // Process doesn't exist
      this.cleanup(streamId);
      return false;
    }
  }

  private cleanup(streamId: string): void {
    this.processes.delete(streamId);
    this.removePidFile(streamId);
    
    // Keep process info for a while for debugging
    setTimeout(() => {
      this.processInfo.delete(streamId);
    }, 60000); // Keep for 1 minute
  }

  private writePidFile(streamId: string, pid: number): void {
    try {
      const pidFile = path.join(this.config.paths.pidDir, `${streamId}.pid`);
      fs.writeFileSync(pidFile, pid.toString());
    } catch (error) {
      this.logger.error('Failed to write PID file', error as Error, { streamId, pid });
    }
  }

  private removePidFile(streamId: string): void {
    try {
      const pidFile = path.join(this.config.paths.pidDir, `${streamId}.pid`);
      if (fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
      }
    } catch (error) {
      this.logger.error('Failed to remove PID file', error as Error, { streamId });
    }
  }

  public cleanup(): void {
    this.logger.info('Cleaning up all processes');
    
    for (const [streamId, process] of this.processes) {
      if (!process.killed) {
        this.stopStream(streamId);
      }
    }
  }
}