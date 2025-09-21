import * as fs from 'fs';
import * as path from 'path';
import { Config } from '../types';

export class ConfigManager {
  private static instance: ConfigManager;
  private config: Config;

  private constructor() {
    this.config = this.loadConfig();
  }

  public static getInstance(): ConfigManager {
    if (!ConfigManager.instance) {
      ConfigManager.instance = new ConfigManager();
    }
    return ConfigManager.instance;
  }

  private loadConfig(): Config {
    const configPath = path.join(__dirname, '../../config/default.json');
    
    try {
      const configFile = fs.readFileSync(configPath, 'utf8');
      const baseConfig = JSON.parse(configFile) as Config;
      
      // Override with environment variables if present
      return this.mergeWithEnvVars(baseConfig);
    } catch (error) {
      console.error('Failed to load configuration:', error);
      throw new Error('Configuration loading failed');
    }
  }

  private mergeWithEnvVars(config: Config): Config {
    return {
      ...config,
      server: {
        ...config.server,
        sseUrl: process.env.SSE_URL || config.server.sseUrl,
        reconnectInterval: parseInt(process.env.RECONNECT_INTERVAL || '') || config.server.reconnectInterval,
        healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL || '') || config.server.healthCheckInterval,
      },
      streaming: {
        ...config.streaming,
        maxRetries: parseInt(process.env.MAX_RETRIES || '') || config.streaming.maxRetries,
        retryBackoffMs: parseInt(process.env.RETRY_BACKOFF_MS || '') || config.streaming.retryBackoffMs,
        processTimeoutMs: parseInt(process.env.PROCESS_TIMEOUT_MS || '') || config.streaming.processTimeoutMs,
        videoParams: {
          ...config.streaming.videoParams,
          bitrate: process.env.VIDEO_BITRATE || config.streaming.videoParams.bitrate,
          resolution: process.env.VIDEO_RESOLUTION || config.streaming.videoParams.resolution,
          framerate: process.env.VIDEO_FRAMERATE || config.streaming.videoParams.framerate,
        },
        audioParams: {
          ...config.streaming.audioParams,
          bitrate: process.env.AUDIO_BITRATE || config.streaming.audioParams.bitrate,
          sampleRate: process.env.AUDIO_SAMPLE_RATE || config.streaming.audioParams.sampleRate,
        },
      },
      paths: {
        ...config.paths,
        stateFile: process.env.STATE_FILE || config.paths.stateFile,
        logFile: process.env.LOG_FILE || config.paths.logFile,
        pidDir: process.env.PID_DIR || config.paths.pidDir,
      },
      performance: {
        ...config.performance,
        maxConcurrentStreams: parseInt(process.env.MAX_CONCURRENT_STREAMS || '') || config.performance.maxConcurrentStreams,
        memoryLimitMB: parseInt(process.env.MEMORY_LIMIT_MB || '') || config.performance.memoryLimitMB,
        cpuThresholdPercent: parseInt(process.env.CPU_THRESHOLD_PERCENT || '') || config.performance.cpuThresholdPercent,
      },
    };
  }

  public getConfig(): Config {
    return { ...this.config };
  }

  public get<T extends keyof Config>(section: T): Config[T] {
    return this.config[section];
  }

  public updateConfig(updates: Partial<Config>): void {
    this.config = { ...this.config, ...updates };
  }

  public validateConfig(): boolean {
    const required = [
      this.config.server.sseUrl,
      this.config.paths.stateFile,
      this.config.paths.logFile,
      this.config.paths.pidDir,
    ];

    return required.every(value => value && value.trim().length > 0);
  }

  public ensureDirectories(): void {
    const dirs = [
      path.dirname(this.config.paths.stateFile),
      path.dirname(this.config.paths.logFile),
      this.config.paths.pidDir,
    ];

    dirs.forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }
}