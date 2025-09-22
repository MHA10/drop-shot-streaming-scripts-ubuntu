"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NodeFFmpegService = void 0;
const child_process_1 = require("child_process");
class NodeFFmpegService {
    constructor(logger, config) {
        this.logger = logger;
        this.config = config;
        this.runningProcesses = new Map();
    }
    async startStream(cameraUrl, streamKey, hasAudio) {
        const command = this.buildStreamCommand(cameraUrl, streamKey, hasAudio);
        this.logger.info("Command full form", command);
        this.logger.info("Starting FFmpeg process", {
            command: command.fullCommand,
            cameraUrl: cameraUrl.value,
            streamKey,
            hasAudio,
        });
        return new Promise((resolve, reject) => {
            const process = (0, child_process_1.spawn)(command.command, command.args, {
                stdio: ["ignore", "pipe", "pipe"],
                detached: false,
            });
            const ffmpegProcess = {
                pid: process.pid,
                command,
                startTime: new Date(),
            };
            // Handle process startup
            let resolved = false;
            const startupTimeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    process.kill("SIGTERM");
                    reject(new Error("FFmpeg process startup timeout"));
                }
            }, 10000); // 10 second timeout
            // Monitor stderr for startup confirmation
            process.stderr?.on("data", (data) => {
                const output = data.toString();
                this.logger.debug("FFmpeg stderr", { pid: process.pid, output });
                // Look for successful stream start indicators
                if (output.includes("Stream mapping:") ||
                    output.includes("Press [q] to stop")) {
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(startupTimeout);
                        this.runningProcesses.set(process.pid, ffmpegProcess);
                        resolve(ffmpegProcess);
                    }
                }
                // Check for errors
                if (output.includes("Connection refused") ||
                    output.includes("No route to host") ||
                    output.includes("Invalid data found")) {
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(startupTimeout);
                        process.kill("SIGTERM");
                        reject(new Error(`FFmpeg error: ${output}`));
                    }
                }
            });
            // Handle process exit
            process.on("exit", (code, signal) => {
                this.logger.info("FFmpeg process exited", {
                    pid: process.pid,
                    code,
                    signal,
                    cameraUrl: cameraUrl.value,
                });
                if (process.pid) {
                    this.runningProcesses.delete(process.pid);
                }
                if (!resolved && code !== 0) {
                    resolved = true;
                    clearTimeout(startupTimeout);
                    reject(new Error(`FFmpeg process exited with code ${code}`));
                }
            });
            // Handle spawn errors
            process.on("error", (error) => {
                this.logger.error("FFmpeg process error", { error: error.message });
                if (!resolved) {
                    resolved = true;
                    clearTimeout(startupTimeout);
                    reject(error);
                }
            });
        });
    }
    async stopStream(pid) {
        this.logger.info("Stopping FFmpeg process", { pid });
        const ffmpegProcess = this.runningProcesses.get(pid);
        if (!ffmpegProcess) {
            this.logger.warn("Process not found in running processes", { pid });
            // Try to kill the process anyway using Node.js process.kill
            try {
                process.kill(pid, "SIGTERM");
                // Wait a bit, then force kill if needed
                setTimeout(() => {
                    try {
                        process.kill(pid, "SIGKILL");
                    }
                    catch (error) {
                        // Process might already be dead
                    }
                }, 5000);
            }
            catch (error) {
                // Process might not exist
            }
            return;
        }
        return new Promise((resolve) => {
            try {
                process.kill(pid, "SIGTERM");
                // Force kill after 5 seconds if not terminated
                const forceKillTimeout = setTimeout(() => {
                    try {
                        process.kill(pid, "SIGKILL");
                    }
                    catch (error) {
                        // Process might already be dead
                    }
                }, 5000);
                // Clean up when process actually exits
                const checkInterval = setInterval(() => {
                    if (!this.runningProcesses.has(pid)) {
                        clearTimeout(forceKillTimeout);
                        clearInterval(checkInterval);
                        resolve();
                    }
                }, 100);
                // Fallback timeout
                setTimeout(() => {
                    clearTimeout(forceKillTimeout);
                    clearInterval(checkInterval);
                    this.runningProcesses.delete(pid);
                    resolve();
                }, 10000);
            }
            catch (error) {
                this.logger.error("Error stopping FFmpeg process", { pid, error });
                this.runningProcesses.delete(pid);
                resolve();
            }
        });
    }
    async isProcessRunning(pid) {
        try {
            // Check if process exists and is running
            process.kill(pid, 0);
            return true;
        }
        catch (error) {
            return false;
        }
    }
    async detectAudio(cameraUrl) {
        this.logger.info("Detecting audio for stream", {
            cameraUrl: cameraUrl.value,
        });
        const ffmpegConfig = this.config.get().ffmpeg;
        const args = [
            ...ffmpegConfig.rtspInputParams.split(" "),
            "-i",
            cameraUrl.value,
            "-t",
            "5", // Test for 5 seconds
            "-f",
            "null",
            "-",
        ];
        return new Promise((resolve) => {
            const process = (0, child_process_1.spawn)("ffmpeg", args, {
                stdio: ["ignore", "pipe", "pipe"],
            });
            let hasAudio = false;
            const timeout = setTimeout(() => {
                process.kill("SIGTERM");
                resolve(hasAudio);
            }, 10000); // 10 second timeout
            process.stderr?.on("data", (data) => {
                const output = data.toString();
                // Look for audio stream indicators
                if (output.includes("Stream #") && output.includes("Audio:")) {
                    hasAudio = true;
                }
            });
            process.on("exit", () => {
                clearTimeout(timeout);
                resolve(hasAudio);
            });
            process.on("error", (error) => {
                this.logger.error("Audio detection error", { error: error.message });
                clearTimeout(timeout);
                resolve(false);
            });
        });
    }
    buildStreamCommand(cameraUrl, streamKey, hasAudio) {
        const ffmpegConfig = this.config.get().ffmpeg;
        const rtmpUrl = `rtmp://a.rtmp.youtube.com/live2/${streamKey}`;
        let args = [];
        // Add input parameters
        args.push(...ffmpegConfig.rtspInputParams.split(" "));
        args.push("-i", cameraUrl.value);
        if (hasAudio) {
            // With audio - use the exact command from bash script
            args.push(...ffmpegConfig.outputParamsVideo.split(" "));
            args.push(...ffmpegConfig.outputParamsAudio.split(" "));
        }
        else {
            // Without audio - add null audio source like in bash script
            args.push("-f", "lavfi");
            args.push("-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
            args.push(...ffmpegConfig.outputParamsVideo.split(" "));
            args.push("-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2", "-shortest");
        }
        args.push(rtmpUrl);
        const fullCommand = `ffmpeg ${args.join(" ")}`;
        return {
            command: "ffmpeg",
            args,
            fullCommand,
        };
    }
    async getRunningProcesses() {
        return Array.from(this.runningProcesses.values());
    }
    async killAllProcesses() {
        this.logger.info("Killing all FFmpeg processes", {
            count: this.runningProcesses.size,
        });
        const killPromises = Array.from(this.runningProcesses.keys()).map((pid) => this.stopStream(pid));
        await Promise.all(killPromises);
        this.runningProcesses.clear();
    }
}
exports.NodeFFmpegService = NodeFFmpegService;
//# sourceMappingURL=NodeFFmpegService.js.map