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
    console.log("[CONFIG] Initializing application configuration...");
    console.log(
      "[CONFIG] Note: dotenv.config() was called at module load time"
    );
    console.log(
      "[CONFIG] Environment variables from npx command will override .env file values"
    );
    this.config = this.loadConfig();
    this.validate();
    console.log("[CONFIG] Configuration loaded successfully");
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
        groundId: this.getEnvVar("DROPSHOT_GROUND_ID", ""),
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

    // Special logging for DROPSHOT_GROUND_ID to confirm source
    if (key === "DROPSHOT_GROUND_ID") {
      console.log(`[CONFIG] Checking environment variable: ${key}`);
      console.log(`[CONFIG] Value from process.env: ${value || "undefined"}`);
      console.log(`[CONFIG] Default value: ${defaultValue}`);

      if (value === undefined) {
        console.log(
          `[CONFIG] WARNING: ${key} not found in environment, using default: ${defaultValue}`
        );
        return defaultValue;
      } else {
        console.log(
          `[CONFIG] CONFIRMED: ${key} loaded from environment (npx command): '${value}'`
        );
        console.log(
          `[CONFIG] This confirms the value is NOT from .env file but from OS environment`
        );
        return value;
      }
    }

    if (value === undefined) {
      return defaultValue;
    }
    return value;
  }

  public validate(): void {
    const errors: string[] = [];

    if (!this.config.groundInfo.groundId) {
      errors.push("DROPSHOT_GROUND_ID is required");
    }

    if (!this.config.images.clientPath) {
      errors.push("CLIENT_IMAGES_PATH is required");
    }

    if (errors.length > 0) {
      throw new Error(`Configuration validation failed: ${errors.join(", ")}`);
    }
  }
}
