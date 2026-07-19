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
  ads: {
    defaultDurationSec: number;
    minDurationSec: number;
    maxDurationSec: number;
    clipFps: number;
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
  supabase: {
    enabled: boolean;
    url: string;
    anonKey: string;
    tableName: string;
    channelName: string;
  };
  cloudinary: {
    cloudName: string;
    apiKey: string;
    apiSecret: string;
  };
  highlight: {
    // Master enable for the highlight buffer. Ships DEFAULT FALSE for now: the
    // rolling buffer has no retention/cleanup yet (Phase 2), so auto-running it
    // could fill the disk — and because it's a second output of the live
    // ffmpeg, a full disk can take the live stream down too. Presence-based
    // auto-enable is already wired (isDevicePresent gates it too); once Phase 2
    // bounds the buffer, flip this default to true for the intended zero-config
    // behavior. Until then, set HIGHLIGHT_ENABLED=true only on a test box.
    enabled: boolean;
    bufferDir: string;
    bufferSegmentSec: number;
    // Window geometry: a highlight clip spans [event - preRoll, event + postRoll],
    // where event ≈ signal receipt - lagMargin (the mesh delay). The rolling
    // buffer must retain at least this whole span; bufferRetentionSec is that
    // span plus a safety pad, and bounds on-disk buffer size (retention/cleanup).
    preRollSec: number;
    postRollSec: number;
    lagMarginSec: number;
    bufferRetentionSec: number;
    outputDir: string;
    serialPortPath: string;
    serialBaudRate: number;
    // Debug/test knobs (default off) so the flow can be exercised on a box
    // WITHOUT the ESP32 button hardware. forcePresent makes isDevicePresent()
    // true; triggerFile, when set, fires a highlight whenever that file appears.
    forcePresent: boolean;
    triggerFile: string;
    // Ball-tracking reframe (Phase 5). Default OFF: the classical-CV reframer
    // is unvalidated without real padel footage, so by default the reel is the
    // full-frame clip with logos. When enabled it runs a Python/OpenCV pass
    // (requires python3 + opencv-python on the box) and falls back to full
    // frame on any failure. reelAspect is the target crop aspect, e.g. "9:16".
    ballTracking: {
      enabled: boolean;
    };
    reelAspect: string;
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
    // Highlight window values parsed once and reused (fields + derived
    // retention default) to avoid re-reading the same env vars.
    const hlPreRollSec = this.parseIntEnv("HIGHLIGHT_PRE_ROLL_SEC", 25);
    const hlPostRollSec = this.parseIntEnv("HIGHLIGHT_POST_ROLL_SEC", 5);
    const hlLagMarginSec = this.parseIntEnv("HIGHLIGHT_LAG_MARGIN_SEC", 5);

    return {
      server: {
        baseUrl: this.getEnvVar("BASE_URL", "https://api.drop-shot.live"),
      },
      images: {
        clientPath: this.getEnvVar("CLIENT_IMAGES_PATH", "./public/client.png"),
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
      ads: {
        defaultDurationSec: this.parseIntEnv("AD_DEFAULT_DURATION_SEC", 12),
        minDurationSec: this.parseIntEnv("AD_MIN_DURATION_SEC", 5),
        maxDurationSec: this.parseIntEnv("AD_MAX_DURATION_SEC", 120),
        clipFps: this.parseIntEnv("AD_CLIP_FPS", 15),
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
      supabase: {
        enabled: this.getEnvVar("SUPABASE_ENABLED", "false") === "true",
        url: this.getEnvVar("SUPABASE_URL", ""),
        anonKey: this.getEnvVar("SUPABASE_ANON_KEY", ""),
        tableName: this.getEnvVar("SUPABASE_TABLE_NAME", "score_board"),
        channelName: this.getEnvVar("SUPABASE_CHANNEL_NAME", "score_board_channel"),
      },
      cloudinary: {
        cloudName: this.getEnvVar("REACT_APP_CLOUDINARY_CLOUD_NAME", "duca7omur"),
        apiKey: this.getEnvVar("CLOUDINARY_API_KEY", ""),
        apiSecret: this.getEnvVar("CLOUDINARY_API_SECRET", ""),
      },
      highlight: {
        // Default false until Phase 2 retention bounds the buffer (see the
        // interface comment). Strict: only the literal "true" enables it.
        enabled: this.getEnvVar("HIGHLIGHT_ENABLED", "false") === "true",
        bufferDir: this.getEnvVar("HIGHLIGHT_BUFFER_DIR", "./highlight-buffer"),
        // Floor at 2s: segment filenames use whole-second (%s) timestamps, so a
        // 1s segment length could emit two files in the same second and clobber
        // one, punching a gap in the buffer.
        bufferSegmentSec: Math.max(
          2,
          this.parseIntEnv("HIGHLIGHT_BUFFER_SEGMENT_SEC", 2)
        ),
        preRollSec: hlPreRollSec,
        postRollSec: hlPostRollSec,
        lagMarginSec: hlLagMarginSec,
        // Default = full window (pre + post + lag) + 10s safety pad. Overridable,
        // but must stay ≥ the window or extraction can lose the leading edge.
        bufferRetentionSec: this.parseIntEnv(
          "HIGHLIGHT_BUFFER_RETENTION_SEC",
          hlPreRollSec + hlPostRollSec + hlLagMarginSec + 10
        ),
        outputDir: this.getEnvVar("HIGHLIGHT_OUTPUT_DIR", "./highlights"),
        // "auto" → discover the ESP32 among connected serial devices; or an
        // explicit path like "/dev/ttyUSB0". Baud must match esp32-leader.ino.
        serialPortPath: this.getEnvVar("HIGHLIGHT_SERIAL_PORT", "auto"),
        serialBaudRate: this.parseIntEnv("HIGHLIGHT_SERIAL_BAUD", 115200),
        forcePresent: this.getEnvVar("HIGHLIGHT_FORCE_PRESENT", "false") === "true",
        triggerFile: this.getEnvVar("HIGHLIGHT_TRIGGER_FILE", ""),
        ballTracking: {
          enabled:
            this.getEnvVar("HIGHLIGHT_BALL_TRACKING_ENABLED", "false") === "true",
        },
        reelAspect: this.getEnvVar("HIGHLIGHT_REEL_ASPECT", "9:16"),
      },
      environment: this.getEnvVar("NODE_ENV", "development"),
    };
  }

  // Parse a positive integer env var, falling back when missing/invalid. Guards
  // against NaN and non-positive values (a negative would otherwise pass through
  // and, e.g., let an ad duration clamp to a zero-length clip).
  private parseIntEnv(key: string, fallback: number): number {
    const value = parseInt(this.getEnvVar(key, String(fallback)), 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
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
