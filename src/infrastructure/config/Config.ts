import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

export interface AppConfig {
  server: {
    baseUrl: string;
  };
  groundInfo: {
    groundId: string;
  };
  sse: {
    retryInterval: number;
    maxRetries: number;
  };
  stream: {
    persistentStateDir: string;
    tempStateDir: string;
    healthCheckInterval: number;
  };
  logging: {
    level: string;
    file?: string;
  };
  remoteLogging: {
    enabled: boolean;
    sourceId: string;
    batchSize: number;
    batchInterval: number;
    maxMemoryUsage: number;
    retryAttempts: number;
    retryDelay: number;
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
      server: {
        baseUrl: this.getEnvVar("BASE_URL", "https://api.drop-shot.live/"),
      },
      groundInfo: {
        groundId: this.getEnvVar("GROUND_ID", ""),
      },
      sse: {
        retryInterval: parseInt(this.getEnvVar("SSE_RETRY_INTERVAL", "5000")),
        maxRetries: parseInt(this.getEnvVar("SSE_MAX_RETRIES", "10")),
      },
      stream: {
        persistentStateDir: this.getEnvVar(
          "PERSISTENT_STATE_DIR",
          "/var/tmp/stream_registry"
        ),
        tempStateDir: this.getEnvVar("TEMP_STATE_DIR", "/tmp/stream_registry"),
        healthCheckInterval: parseInt(
          this.getEnvVar("HEALTH_CHECK_INTERVAL", "30000")
        ),
      },
      logging: {
        level: this.getEnvVar("LOG_LEVEL", "info"),
        file: process.env.LOG_FILE,
      },
      remoteLogging: {
        enabled: this.getEnvVar("REMOTE_LOGGING_ENABLED", "false") === "true",
        sourceId: this.getEnvVar(
          "REMOTE_LOGGING_SOURCE_ID",
          "raspberry-pi-001"
        ),
        batchSize: parseInt(this.getEnvVar("REMOTE_LOGGING_BATCH_SIZE", "50")),
        batchInterval: parseInt(
          this.getEnvVar("REMOTE_LOGGING_BATCH_INTERVAL", "300000")
        ), // 5 minutes
        maxMemoryUsage: parseInt(
          this.getEnvVar("REMOTE_LOGGING_MAX_MEMORY", "512000")
        ), // 500KB
        retryAttempts: parseInt(
          this.getEnvVar("REMOTE_LOGGING_RETRY_ATTEMPTS", "999999")
        ), // Infinite for errors
        retryDelay: parseInt(
          this.getEnvVar("REMOTE_LOGGING_RETRY_DELAY", "5000")
        ), // 5 seconds
      },
      environment: this.getEnvVar("NODE_ENV", "development"),
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

    if (!this.config.groundInfo.groundId) {
      errors.push("GROUND_ID is required");
    }

    if (this.config.sse.retryInterval <= 0) {
      errors.push("SSE_RETRY_INTERVAL must be positive");
    }

    if (this.config.sse.maxRetries <= 0) {
      errors.push("SSE_MAX_RETRIES must be positive");
    }

    if (!this.config.server.baseUrl) {
      errors.push("SERVER_BASE_URL is required");
    }

    if (errors.length > 0) {
      throw new Error(`Configuration validation failed: ${errors.join(", ")}`);
    }
  }
}
