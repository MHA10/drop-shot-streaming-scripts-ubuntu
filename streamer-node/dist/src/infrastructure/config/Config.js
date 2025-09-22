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
exports.Config = void 0;
const dotenv = __importStar(require("dotenv"));
// Load environment variables
dotenv.config();
class Config {
    constructor() {
        this.config = this.loadConfig();
    }
    static getInstance() {
        if (!Config.instance) {
            Config.instance = new Config();
        }
        return Config.instance;
    }
    get() {
        return this.config;
    }
    loadConfig() {
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
    getEnvVar(key, defaultValue) {
        const value = process.env[key];
        if (value === undefined) {
            return defaultValue;
        }
        return value;
    }
    validate() {
        const errors = [];
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
exports.Config = Config;
//# sourceMappingURL=Config.js.map