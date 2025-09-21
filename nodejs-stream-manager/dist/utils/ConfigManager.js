"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigManager = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class ConfigManager {
    constructor() {
        this.config = this.loadConfig();
    }
    static getInstance() {
        if (!ConfigManager.instance) {
            ConfigManager.instance = new ConfigManager();
        }
        return ConfigManager.instance;
    }
    loadConfig() {
        const configPath = path.join(__dirname, '../../config/default.json');
        try {
            const configFile = fs.readFileSync(configPath, 'utf8');
            const baseConfig = JSON.parse(configFile);
            return this.mergeWithEnvVars(baseConfig);
        }
        catch (error) {
            console.error('Failed to load configuration:', error);
            throw new Error('Configuration loading failed');
        }
    }
    mergeWithEnvVars(config) {
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
    getConfig() {
        return { ...this.config };
    }
    get(section) {
        return this.config[section];
    }
    updateConfig(updates) {
        this.config = { ...this.config, ...updates };
    }
    validateConfig() {
        const required = [
            this.config.server.sseUrl,
            this.config.paths.stateFile,
            this.config.paths.logFile,
            this.config.paths.pidDir,
        ];
        return required.every(value => value && value.trim().length > 0);
    }
    ensureDirectories() {
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
exports.ConfigManager = ConfigManager;
//# sourceMappingURL=ConfigManager.js.map