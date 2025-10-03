import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

export interface AppConfig {
  server: {
    baseUrl: string;
  };
  images: {
    clientPath: string;
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
    this.validate();
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
        baseUrl: this.getEnvVar("BASE_URL", "https://api.drop-shot.live"),
      },
      images: {
        clientPath: this.getEnvVar("CLIENT_IMAGES_PATH", ""),
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

    if (!this.config.images.clientPath) {
      errors.push("CLIENT_IMAGES_PATH is required");
    }

    if (errors.length > 0) {
      throw new Error(`Configuration validation failed: ${errors.join(", ")}`);
    }
  }
}
