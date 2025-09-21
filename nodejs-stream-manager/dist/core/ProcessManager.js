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
exports.ProcessManager = void 0;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const Logger_1 = require("../utils/Logger");
const ConfigManager_1 = require("../utils/ConfigManager");
class ProcessManager {
    constructor() {
        this.processes = new Map();
        this.processInfo = new Map();
        this.logger = Logger_1.Logger.getInstance();
        this.config = ConfigManager_1.ConfigManager.getInstance().getConfig();
        this.ensurePidDirectory();
    }
    ensurePidDirectory() {
        if (!fs.existsSync(this.config.paths.pidDir)) {
            fs.mkdirSync(this.config.paths.pidDir, { recursive: true });
        }
    }
    async startStream(streamConfig, audioDetection) {
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
            const ffmpeg = (0, child_process_1.spawn)('ffmpeg', command, {
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: false
            });
            if (!ffmpeg.pid) {
                throw new Error('Failed to start FFmpeg process');
            }
            const processInfo = {
                pid: ffmpeg.pid,
                streamId: streamConfig.id,
                startTime: Date.now(),
                command: `ffmpeg ${command.join(' ')}`,
                status: 'running'
            };
            this.processes.set(streamConfig.id, ffmpeg);
            this.processInfo.set(streamConfig.id, processInfo);
            this.writePidFile(streamConfig.id, ffmpeg.pid);
            this.setupProcessHandlers(streamConfig.id, ffmpeg);
            this.logger.stream(streamConfig.id, 'Stream started successfully', {
                pid: ffmpeg.pid,
                hasAudio: audioDetection.hasAudio
            });
            return processInfo;
        }
        catch (error) {
            this.logger.error('Failed to start stream', error, { streamId: streamConfig.id });
            return null;
        }
    }
    buildFFmpegCommand(streamConfig, audioDetection) {
        const command = [];
        command.push('-rtsp_transport', this.config.streaming.rtspTransport);
        command.push('-fflags', '+genpts');
        command.push('-avoid_negative_ts', 'make_zero');
        command.push('-i', streamConfig.rtspUrl);
        if (!audioDetection.hasAudio) {
            command.push('-f', 'lavfi');
            command.push('-i', this.config.streaming.silentAudioParams.source);
        }
        command.push('-c:v', streamConfig.videoParams.codec);
        command.push('-b:v', streamConfig.videoParams.bitrate);
        command.push('-s', streamConfig.videoParams.resolution);
        command.push('-r', streamConfig.videoParams.framerate);
        command.push('-g', streamConfig.videoParams.keyframeInterval);
        command.push('-preset', streamConfig.videoParams.preset);
        command.push('-c:a', streamConfig.audioParams.codec);
        command.push('-b:a', streamConfig.audioParams.bitrate);
        command.push('-ar', streamConfig.audioParams.sampleRate);
        command.push('-ac', streamConfig.audioParams.channels);
        if (!audioDetection.hasAudio) {
            command.push('-shortest');
        }
        command.push('-f', 'flv');
        command.push('-y');
        command.push(streamConfig.rtmpUrl);
        return command;
    }
    setupProcessHandlers(streamId, process) {
        let stdoutBuffer = '';
        let stderrBuffer = '';
        process.stdout?.on('data', (data) => {
            stdoutBuffer += data.toString();
            if (stdoutBuffer.length > 1000) {
                this.logger.debug('FFmpeg stdout', { streamId, output: stdoutBuffer.substring(0, 500) });
                stdoutBuffer = '';
            }
        });
        process.stderr?.on('data', (data) => {
            stderrBuffer += data.toString();
            const output = data.toString();
            if (output.includes('error') || output.includes('failed') || output.includes('warning')) {
                this.logger.warn('FFmpeg stderr', { streamId, output: output.substring(0, 200) });
            }
            if (stderrBuffer.length > 2000) {
                stderrBuffer = stderrBuffer.substring(1000);
            }
        });
        process.on('exit', (code, signal) => {
            this.logger.process(process.pid, 'Process exited', {
                streamId,
                code,
                signal,
                stderr: stderrBuffer.substring(-500)
            });
            const info = this.processInfo.get(streamId);
            if (info) {
                info.status = code === 0 ? 'stopped' : 'failed';
                this.processInfo.set(streamId, info);
            }
            this.cleanup(streamId);
        });
        process.on('error', (error) => {
            this.logger.error('Process error', error, {
                streamId,
                ...(process.pid && { pid: process.pid })
            });
            const info = this.processInfo.get(streamId);
            if (info) {
                info.status = 'failed';
                this.processInfo.set(streamId, info);
            }
            this.cleanup(streamId);
        });
    }
    stopStream(streamId) {
        const process = this.processes.get(streamId);
        if (!process) {
            this.logger.warn('Stream not found for stopping', { streamId });
            return false;
        }
        this.logger.stream(streamId, 'Stopping stream', {
            ...(process.pid && { pid: process.pid })
        });
        try {
            process.kill('SIGTERM');
            setTimeout(() => {
                if (!process.killed) {
                    this.logger.warn('Force killing stream process', {
                        streamId,
                        ...(process.pid && { pid: process.pid })
                    });
                    process.kill('SIGKILL');
                }
            }, this.config.streaming.processTimeoutMs);
            return true;
        }
        catch (error) {
            this.logger.error('Failed to stop stream', error, {
                streamId,
                ...(process.pid && { pid: process.pid })
            });
            return false;
        }
    }
    getProcessInfo(streamId) {
        return this.processInfo.get(streamId) || null;
    }
    getAllProcesses() {
        return Array.from(this.processInfo.values());
    }
    isStreamRunning(streamId) {
        const process = this.processes.get(streamId);
        const info = this.processInfo.get(streamId);
        return !!(process && !process.killed && info?.status === 'running');
    }
    validateProcess(streamId) {
        const process = this.processes.get(streamId);
        if (!process || process.killed) {
            return false;
        }
        try {
            process.kill(0);
            return true;
        }
        catch {
            this.cleanup(streamId);
            return false;
        }
    }
    cleanup(streamId) {
        this.processes.delete(streamId);
        this.removePidFile(streamId);
        setTimeout(() => {
            this.processInfo.delete(streamId);
        }, 60000);
    }
    writePidFile(streamId, pid) {
        try {
            const pidFile = path.join(this.config.paths.pidDir, `${streamId}.pid`);
            fs.writeFileSync(pidFile, pid.toString());
        }
        catch (error) {
            this.logger.error('Failed to write PID file', error, { streamId, pid });
        }
    }
    removePidFile(streamId) {
        try {
            const pidFile = path.join(this.config.paths.pidDir, `${streamId}.pid`);
            if (fs.existsSync(pidFile)) {
                fs.unlinkSync(pidFile);
            }
        }
        catch (error) {
            this.logger.error('Failed to remove PID file', error, { streamId });
        }
    }
    cleanupAll() {
        this.logger.info('Cleaning up all processes');
        for (const [streamId, process] of this.processes) {
            if (!process.killed) {
                this.stopStream(streamId);
            }
        }
    }
}
exports.ProcessManager = ProcessManager;
//# sourceMappingURL=ProcessManager.js.map