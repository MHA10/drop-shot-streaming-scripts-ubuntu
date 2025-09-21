"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AudioDetector = void 0;
const child_process_1 = require("child_process");
const Logger_1 = require("../utils/Logger");
class AudioDetector {
    constructor() {
        this.logger = Logger_1.Logger.getInstance();
    }
    async detectAudio(rtspUrl, timeoutMs = 10000) {
        return new Promise((resolve) => {
            const startTime = Date.now();
            this.logger.debug('Starting audio detection', { rtspUrl, timeoutMs });
            const ffprobe = (0, child_process_1.spawn)('ffprobe', [
                '-v', 'quiet',
                '-print_format', 'json',
                '-show_streams',
                '-select_streams', 'a',
                '-rtsp_transport', 'tcp',
                '-analyzeduration', '2000000',
                '-probesize', '2000000',
                rtspUrl
            ]);
            let output = '';
            let errorOutput = '';
            const timeout = setTimeout(() => {
                this.logger.warn('Audio detection timeout', { rtspUrl, timeoutMs });
                ffprobe.kill('SIGKILL');
                resolve({
                    hasAudio: false,
                    audioStreams: 0,
                    error: 'Detection timeout'
                });
            }, timeoutMs);
            ffprobe.stdout.on('data', (data) => {
                output += data.toString();
            });
            ffprobe.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });
            ffprobe.on('close', (code) => {
                clearTimeout(timeout);
                const duration = Date.now() - startTime;
                try {
                    if (code === 0 && output.trim()) {
                        const result = JSON.parse(output);
                        const audioStreams = result.streams ? result.streams.length : 0;
                        const hasAudio = audioStreams > 0;
                        this.logger.performance('Audio detection completed', duration, {
                            rtspUrl,
                            hasAudio,
                            audioStreams,
                            code
                        });
                        resolve({
                            hasAudio,
                            audioStreams,
                        });
                    }
                    else {
                        this.logger.warn('Audio detection failed', {
                            rtspUrl,
                            code,
                            errorOutput: errorOutput.substring(0, 200),
                            duration
                        });
                        resolve({
                            hasAudio: false,
                            audioStreams: 0,
                            error: `ffprobe failed with code ${code}: ${errorOutput.substring(0, 100)}`
                        });
                    }
                }
                catch (parseError) {
                    this.logger.error('Failed to parse ffprobe output', parseError, {
                        rtspUrl,
                        output: output.substring(0, 200),
                        duration
                    });
                    resolve({
                        hasAudio: false,
                        audioStreams: 0,
                        error: 'Failed to parse detection output'
                    });
                }
            });
            ffprobe.on('error', (error) => {
                clearTimeout(timeout);
                this.logger.error('Audio detection process error', error, { rtspUrl });
                resolve({
                    hasAudio: false,
                    audioStreams: 0,
                    error: `Process error: ${error.message}`
                });
            });
        });
    }
    async detectAudioWithRetry(rtspUrl, maxRetries = 3, timeoutMs = 10000) {
        let lastError;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            this.logger.debug('Audio detection attempt', { rtspUrl, attempt, maxRetries });
            const result = await this.detectAudio(rtspUrl, timeoutMs);
            if (!result.error) {
                return result;
            }
            lastError = result.error;
            if (attempt < maxRetries) {
                const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
                this.logger.debug('Audio detection retry backoff', { rtspUrl, attempt, backoffMs });
                await this.sleep(backoffMs);
            }
        }
        this.logger.warn('Audio detection failed after all retries', {
            rtspUrl,
            maxRetries,
            lastError
        });
        return {
            hasAudio: false,
            audioStreams: 0,
            error: lastError || 'All retry attempts failed'
        };
    }
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    validateRtspUrl(url) {
        try {
            const parsed = new URL(url);
            return parsed.protocol === 'rtsp:' && parsed.hostname.length > 0;
        }
        catch {
            return false;
        }
    }
}
exports.AudioDetector = AudioDetector;
//# sourceMappingURL=AudioDetector.js.map