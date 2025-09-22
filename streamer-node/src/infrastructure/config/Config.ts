import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

export interface AppConfig {
  sse: {
    endpoint: string;
    retryInterval: number;
    maxRetries: number;
  };
  stream: {
    persistentStateDir: string;
    tempStateDir: string;
    healthCheckInterval: number;
  };
  ffmpeg: {
    rtspInputParams: string;
    outputParamsVideo: string;
    outputParamsAudio: string;
  };
  logging: {
    level: string;
    file?: string;
  };
  environment: string;
}

export class Config {
  private static instance: Config;
  private config: AppConfig;

  private constructor() {
    this.config = this.loadConfig();
  }

  public static getInstance(): Config {
    if (!Config.instance) {
      Config.instance = new Config();
    }
    return Config.instance;
  }

  public get(): AppConfig {
    return this.config;
  }

  private loadConfig(): AppConfig {
    return {
      sse: {
        endpoint: this.getEnvVar('SSE_ENDPOINT', 'https://api.drop-shot.live/api/v1/padel-grounds/385136f6-7cf0-4e7f-b601-fea90079c227/events'),
        retryInterval: parseInt(this.getEnvVar('SSE_RETRY_INTERVAL', '5000')),
        maxRetries: parseInt(this.getEnvVar('SSE_MAX_RETRIES', '10')),
      },
      stream: {
        persistentStateDir: this.getEnvVar('PERSISTENT_STATE_DIR', '/var/tmp/stream_registry'),
        tempStateDir: this.getEnvVar('TEMP_STATE_DIR', '/tmp/stream_registry'),
        healthCheckInterval: parseInt(this.getEnvVar('HEALTH_CHECK_INTERVAL', '30000')),
      },
      ffmpeg: {
        rtspInputParams: this.getEnvVar('RTSP_INPUT_PARAMS', '-rtsp_transport tcp -use_wallclock_as_timestamps 1 -fflags +genpts'),
        outputParamsVideo: this.getEnvVar('OUTPUT_PARAMS_VIDEO', '-c:v libx264 -preset veryfast -tune zerolatency -crf 23 -maxrate 2500k -bufsize 5000k -pix_fmt yuv420p -g 50 -f flv'),
        outputParamsAudio: this.getEnvVar('OUTPUT_PARAMS_AUDIO', '-c:a aac -b:a 128k -ar 44100 -ac 2'),
      },
      logging: {
        level: this.getEnvVar('LOG_LEVEL', 'info'),
        file: process.env.LOG_FILE,
      },
      environment: this.getEnvVar('NODE_ENV', 'development'),
    };
  }

  private getEnvVar(key: string, defaultValue: string): string {
    const value = process.env[key];
    if (value === undefined) {
      return defaultValue;
    }
    return value;
  }

  public validate(): void {
    const errors: string[] = [];

    if (!this.config.sse.endpoint) {
      errors.push('SSE_ENDPOINT is required');
    }

    if (this.config.sse.retryInterval <= 0) {
      errors.push('SSE_RETRY_INTERVAL must be positive');
    }

    if (this.config.sse.maxRetries <= 0) {
      errors.push('SSE_MAX_RETRIES must be positive');
    }

    if (errors.length > 0) {
      throw new Error(`Configuration validation failed: ${errors.join(', ')}`);
    }
  }
}