import { StreamConfig, StreamState, AudioDetectionResult, ProcessInfo } from '../types';
import { AudioDetector } from './AudioDetector';
import { ProcessManager } from './ProcessManager';
import { StateManager } from './StateManager';
import { Logger } from '../utils/Logger';
import { ConfigManager } from '../utils/ConfigManager';

export class StreamManager {
  private audioDetector: AudioDetector;
  private processManager: ProcessManager;
  private stateManager: StateManager;
  private logger: Logger;
  private config: ReturnType<ConfigManager['getConfig']>;

  constructor() {
    this.audioDetector = new AudioDetector();
    this.processManager = new ProcessManager();
    this.stateManager = new StateManager();
    this.logger = Logger.getInstance();
    this.config = ConfigManager.getInstance().getConfig();
  }

  public async startStream(streamConfig: StreamConfig): Promise<boolean> {
    const { id: streamId } = streamConfig;
    
    try {
      this.logger.stream(streamId, 'Starting stream request', {
        rtspUrl: streamConfig.rtspUrl,
        rtmpUrl: streamConfig.rtmpUrl
      });

      // Check if stream is already running
      if (this.processManager.isStreamRunning(streamId)) {
        this.logger.warn('Stream already running', { streamId });
        return true;
      }

      // Validate RTSP URL
      if (!this.audioDetector.validateRtspUrl(streamConfig.rtspUrl)) {
        throw new Error('Invalid RTSP URL format');
      }

      // Mark as retrying to prevent duplicate starts
      this.stateManager.markStreamAsRetrying(streamId);
      this.stateManager.setStreamConfig(streamId, streamConfig);

      // Detect audio in the stream
      this.logger.stream(streamId, 'Detecting audio streams');
      const audioDetection = await this.audioDetector.detectAudioWithRetry(
        streamConfig.rtspUrl,
        3, // max retries
        10000 // timeout ms
      );

      if (audioDetection.error) {
        this.logger.warn('Audio detection had issues, proceeding without audio', {
          streamId,
          error: audioDetection.error
        });
      }

      // Update stream config with audio detection results
      const updatedConfig: StreamConfig = {
        ...streamConfig,
        audioParams: {
          ...streamConfig.audioParams,
          hasAudio: audioDetection.hasAudio
        }
      };

      // Start the FFmpeg process
      const processInfo = await this.processManager.startStream(updatedConfig, audioDetection);
      
      if (!processInfo) {
        throw new Error('Failed to start FFmpeg process');
      }

      // Update state as active
      this.stateManager.markStreamAsActive(streamId, processInfo.pid);
      this.stateManager.resetRetryCount(streamId);

      this.logger.stream(streamId, 'Stream started successfully', {
        pid: processInfo.pid,
        hasAudio: audioDetection.hasAudio,
        audioStreams: audioDetection.audioStreams
      });

      return true;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error('Failed to start stream', error as Error, { streamId });
      
      this.stateManager.markStreamAsFailed(streamId, errorMessage);
      return false;
    }
  }

  public stopStream(streamId: string): boolean {
    try {
      this.logger.stream(streamId, 'Stopping stream request');

      const success = this.processManager.stopStream(streamId);
      
      if (success) {
        this.stateManager.markStreamAsInactive(streamId);
        this.logger.stream(streamId, 'Stream stopped successfully');
      } else {
        this.logger.warn('Failed to stop stream process', { streamId });
      }

      return success;
    } catch (error) {
      this.logger.error('Error stopping stream', error as Error, { streamId });
      return false;
    }
  }

  public async restartStream(streamId: string): Promise<boolean> {
    this.logger.stream(streamId, 'Restarting stream');

    // Stop the stream first
    this.stopStream(streamId);

    // Wait a moment for cleanup
    await this.sleep(2000);

    // Get the stored config and restart
    const config = this.stateManager.getStreamConfig(streamId);
    if (!config) {
      this.logger.error('No config found for stream restart', undefined, { streamId });
      return false;
    }

    return this.startStream(config);
  }

  public getStreamStatus(streamId: string): StreamState | null {
    return this.stateManager.getStreamState(streamId);
  }

  public getAllStreamStatuses(): StreamState[] {
    return this.stateManager.getAllStreamStates();
  }

  public getProcessInfo(streamId: string): ProcessInfo | null {
    return this.processManager.getProcessInfo(streamId);
  }

  public getAllProcessInfo(): ProcessInfo[] {
    return this.processManager.getAllProcesses();
  }

  public async validateAndRecoverStreams(): Promise<void> {
    this.logger.info('Starting stream validation and recovery');

    const activeStreams = this.stateManager.getActiveStreams();
    
    for (const stream of activeStreams) {
      try {
        const isValid = this.processManager.validateProcess(stream.id);
        
        if (!isValid) {
          this.logger.warn('Stream process not found, attempting recovery', { 
            streamId: stream.id,
            pid: stream.pid 
          });

          // Check retry limits
          const retryCount = this.stateManager.incrementRetryCount(stream.id);
          const maxRetries = this.config.streaming.maxRetries;

          if (retryCount <= maxRetries) {
            this.logger.stream(stream.id, 'Attempting stream recovery', { 
              retryCount, 
              maxRetries 
            });

            const config = this.stateManager.getStreamConfig(stream.id);
            if (config) {
              // Add exponential backoff
              const backoffMs = Math.min(
                this.config.streaming.retryBackoffMs * Math.pow(2, retryCount - 1),
                30000 // Max 30 seconds
              );
              
              await this.sleep(backoffMs);
              await this.startStream(config);
            }
          } else {
            this.logger.error('Stream exceeded max retries, marking as failed', undefined, {
              streamId: stream.id,
              retryCount,
              maxRetries
            });
            
            this.stateManager.markStreamAsFailed(
              stream.id, 
              `Exceeded max retries (${maxRetries})`
            );
          }
        } else {
          // Process is valid, update health check
          this.stateManager.updateHealthCheck(stream.id);
        }
      } catch (error) {
        this.logger.error('Error during stream validation', error as Error, { 
          streamId: stream.id 
        });
      }
    }
  }

  public async performHealthCheck(): Promise<void> {
    const healthCheckInterval = this.config.server.healthCheckInterval;
    const streamsNeedingCheck = this.stateManager.getStreamsNeedingHealthCheck(healthCheckInterval);

    if (streamsNeedingCheck.length === 0) {
      return;
    }

    this.logger.debug('Performing health check', { 
      streamsCount: streamsNeedingCheck.length 
    });

    for (const stream of streamsNeedingCheck) {
      try {
        const isRunning = this.processManager.isStreamRunning(stream.id);
        const isValid = this.processManager.validateProcess(stream.id);

        if (isRunning && isValid) {
          this.stateManager.updateHealthCheck(stream.id);
          this.logger.debug('Stream health check passed', { streamId: stream.id });
        } else {
          this.logger.warn('Stream failed health check', { 
            streamId: stream.id,
            isRunning,
            isValid 
          });
          
          // This will be handled by validateAndRecoverStreams
        }
      } catch (error) {
        this.logger.error('Health check error', error as Error, { streamId: stream.id });
      }
    }
  }

  public getSystemStats(): {
    streams: ReturnType<StateManager['getStreamStats']>;
    processes: { total: number; running: number };
    uptime: number;
  } {
    const processes = this.getAllProcessInfo();
    const runningProcesses = processes.filter(p => p.status === 'running');

    return {
      streams: this.stateManager.getStreamStats(),
      processes: {
        total: processes.length,
        running: runningProcesses.length
      },
      uptime: process.uptime()
    };
  }

  public async recoverFromBoot(): Promise<void> {
    this.logger.info('Recovering streams after system boot');

    const configs = this.stateManager.getAllStreamConfigs();
    const activeStreams = this.stateManager.getActiveStreams();

    // Reset all active streams to inactive first
    for (const stream of activeStreams) {
      this.stateManager.markStreamAsInactive(stream.id);
    }

    // Wait for system to stabilize
    await this.sleep(5000);

    // Restart all configured streams
    for (const config of configs) {
      try {
        this.logger.stream(config.id, 'Recovering stream from boot');
        await this.startStream(config);
        
        // Stagger the starts to avoid overwhelming the system
        await this.sleep(2000);
      } catch (error) {
        this.logger.error('Failed to recover stream from boot', error as Error, {
          streamId: config.id
        });
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  public cleanup(): void {
    this.logger.info('Cleaning up StreamManager');
    this.processManager.cleanup();
    this.stateManager.cleanup();
  }
}