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
exports.PerformanceOptimizer = void 0;
const Logger_1 = require("./Logger");
const ConfigManager_1 = require("./ConfigManager");
const child_process_1 = require("child_process");
const util_1 = require("util");
const fs = __importStar(require("fs/promises"));
const os = __importStar(require("os"));
const execAsync = (0, util_1.promisify)(child_process_1.exec);
class PerformanceOptimizer {
    constructor() {
        this.lastMetrics = null;
        this.gcTimer = null;
        this.logger = new Logger_1.Logger('PerformanceOptimizer');
        this.config = ConfigManager_1.ConfigManager.getInstance();
        this.optimizationSettings = this.loadOptimizationSettings();
        this.setupGarbageCollection();
    }
    loadOptimizationSettings() {
        const config = this.config.get();
        return {
            maxConcurrentStreams: config.streaming?.maxConcurrentStreams || 2,
            memoryThreshold: config.performance?.memoryThreshold || 80,
            cpuThreshold: config.performance?.cpuThreshold || 85,
            temperatureThreshold: config.performance?.temperatureThreshold || 70,
            enableGpuAcceleration: config.performance?.enableGpuAcceleration || false,
            enableHardwareDecoding: config.performance?.enableHardwareDecoding || false,
            ffmpegNiceLevel: config.performance?.ffmpegNiceLevel || 10,
            gcInterval: config.performance?.gcInterval || 300000,
        };
    }
    setupGarbageCollection() {
        if (this.gcTimer) {
            clearInterval(this.gcTimer);
        }
        this.gcTimer = setInterval(() => {
            this.forceGarbageCollection();
        }, this.optimizationSettings.gcInterval);
    }
    forceGarbageCollection() {
        if (global.gc) {
            const beforeMemory = process.memoryUsage();
            global.gc();
            const afterMemory = process.memoryUsage();
            const freed = beforeMemory.heapUsed - afterMemory.heapUsed;
            if (freed > 0) {
                this.logger.debug('Garbage collection freed memory', {
                    freedBytes: freed,
                    freedMB: Math.round(freed / 1024 / 1024 * 100) / 100,
                    beforeHeap: Math.round(beforeMemory.heapUsed / 1024 / 1024 * 100) / 100,
                    afterHeap: Math.round(afterMemory.heapUsed / 1024 / 1024 * 100) / 100,
                });
            }
        }
    }
    async getPerformanceMetrics() {
        try {
            const [cpu, memory, disk, network, processes] = await Promise.all([
                this.getCpuMetrics(),
                this.getMemoryMetrics(),
                this.getDiskMetrics(),
                this.getNetworkMetrics(),
                this.getProcessMetrics(),
            ]);
            const metrics = {
                cpu,
                memory,
                disk,
                network,
                processes,
            };
            this.lastMetrics = metrics;
            return metrics;
        }
        catch (error) {
            this.logger.error('Failed to get performance metrics', error);
            throw error;
        }
    }
    async getCpuMetrics() {
        const cpus = os.cpus();
        let totalIdle = 0;
        let totalTick = 0;
        cpus.forEach(cpu => {
            for (const type in cpu.times) {
                totalTick += cpu.times[type];
            }
            totalIdle += cpu.times.idle;
        });
        const usage = Math.round((1 - totalIdle / totalTick) * 100);
        const temperature = await this.getCpuTemperature();
        const frequency = await this.getCpuFrequency();
        const throttled = await this.getThrottleStatus();
        return {
            usage,
            temperature,
            frequency,
            throttled,
        };
    }
    async getCpuTemperature() {
        try {
            const tempData = await fs.readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8');
            return parseInt(tempData.trim()) / 1000;
        }
        catch {
            try {
                const { stdout } = await execAsync('vcgencmd measure_temp');
                const match = stdout.match(/temp=(\d+\.\d+)/);
                return match ? parseFloat(match[1]) : 0;
            }
            catch {
                return 0;
            }
        }
    }
    async getCpuFrequency() {
        try {
            const freqData = await fs.readFile('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq', 'utf8');
            return parseInt(freqData.trim()) / 1000;
        }
        catch {
            try {
                const { stdout } = await execAsync('vcgencmd measure_clock arm');
                const match = stdout.match(/frequency\(45\)=(\d+)/);
                return match ? parseInt(match[1]) / 1000000 : 0;
            }
            catch {
                return 0;
            }
        }
    }
    async getThrottleStatus() {
        try {
            const { stdout } = await execAsync('vcgencmd get_throttled');
            const match = stdout.match(/throttled=0x(\w+)/);
            if (match) {
                const throttleValue = parseInt(match[1], 16);
                return throttleValue !== 0;
            }
            return false;
        }
        catch {
            return false;
        }
    }
    async getMemoryMetrics() {
        const memInfo = await fs.readFile('/proc/meminfo', 'utf8');
        const lines = memInfo.split('\n');
        const getValue = (key) => {
            const line = lines.find(l => l.startsWith(key));
            if (line) {
                const match = line.match(/(\d+)/);
                return match ? parseInt(match[1]) * 1024 : 0;
            }
            return 0;
        };
        const total = getValue('MemTotal');
        const available = getValue('MemAvailable');
        const free = getValue('MemFree');
        const used = total - available;
        const usage = Math.round((used / total) * 100);
        return {
            total,
            used,
            free,
            usage,
            available,
        };
    }
    async getDiskMetrics() {
        try {
            const { stdout } = await execAsync('df -B1 /');
            const lines = stdout.split('\n');
            const dataLine = lines[1];
            const parts = dataLine.split(/\s+/);
            const total = parseInt(parts[1]);
            const used = parseInt(parts[2]);
            const free = parseInt(parts[3]);
            const usage = Math.round((used / total) * 100);
            return {
                total,
                used,
                free,
                usage,
            };
        }
        catch (error) {
            this.logger.warn('Failed to get disk metrics', { error });
            return {
                total: 0,
                used: 0,
                free: 0,
                usage: 0,
            };
        }
    }
    async getNetworkMetrics() {
        try {
            const netDev = await fs.readFile('/proc/net/dev', 'utf8');
            const lines = netDev.split('\n');
            let bytesReceived = 0;
            let bytesSent = 0;
            let packetsReceived = 0;
            let packetsSent = 0;
            for (const line of lines) {
                if (line.includes(':') && !line.includes('lo:')) {
                    const parts = line.split(/\s+/);
                    if (parts.length >= 10) {
                        bytesReceived += parseInt(parts[1]) || 0;
                        packetsReceived += parseInt(parts[2]) || 0;
                        bytesSent += parseInt(parts[9]) || 0;
                        packetsSent += parseInt(parts[10]) || 0;
                    }
                }
            }
            return {
                bytesReceived,
                bytesSent,
                packetsReceived,
                packetsSent,
            };
        }
        catch (error) {
            this.logger.warn('Failed to get network metrics', { error });
            return {
                bytesReceived: 0,
                bytesSent: 0,
                packetsReceived: 0,
                packetsSent: 0,
            };
        }
    }
    async getProcessMetrics() {
        try {
            const { stdout: totalProc } = await execAsync('ps aux | wc -l');
            const { stdout: ffmpegProc } = await execAsync('pgrep -f ffmpeg | wc -l');
            const { stdout: nodeProc } = await execAsync('pgrep -f node | wc -l');
            return {
                total: parseInt(totalProc.trim()) - 1,
                ffmpeg: parseInt(ffmpegProc.trim()),
                node: parseInt(nodeProc.trim()),
            };
        }
        catch (error) {
            this.logger.warn('Failed to get process metrics', { error });
            return {
                total: 0,
                ffmpeg: 0,
                node: 0,
            };
        }
    }
    async optimizeForCurrentLoad() {
        const metrics = await this.getPerformanceMetrics();
        await this.checkMemoryPressure(metrics.memory);
        await this.checkCpuLoad(metrics.cpu);
        await this.checkTemperature(metrics.cpu.temperature);
        await this.optimizeProcesses(metrics.processes);
    }
    async checkMemoryPressure(memory) {
        if (memory.usage > this.optimizationSettings.memoryThreshold) {
            this.logger.warn('High memory usage detected', {
                usage: memory.usage,
                threshold: this.optimizationSettings.memoryThreshold,
                usedMB: Math.round(memory.used / 1024 / 1024),
                totalMB: Math.round(memory.total / 1024 / 1024),
            });
            this.forceGarbageCollection();
            if (memory.usage > 90) {
                try {
                    await execAsync('sync && echo 1 > /proc/sys/vm/drop_caches');
                    this.logger.info('Cleared system caches due to critical memory usage');
                }
                catch (error) {
                    this.logger.warn('Failed to clear system caches', { error });
                }
            }
        }
    }
    async checkCpuLoad(cpu) {
        if (cpu.usage > this.optimizationSettings.cpuThreshold) {
            this.logger.warn('High CPU usage detected', {
                usage: cpu.usage,
                threshold: this.optimizationSettings.cpuThreshold,
                temperature: cpu.temperature,
                throttled: cpu.throttled,
            });
            try {
                await execAsync(`renice ${this.optimizationSettings.ffmpegNiceLevel} -p $(pgrep -f ffmpeg)`);
                this.logger.info('Reduced FFmpeg process priority');
            }
            catch (error) {
                this.logger.debug('No FFmpeg processes to renice or renice failed', { error });
            }
        }
    }
    async checkTemperature(temperature) {
        if (temperature > this.optimizationSettings.temperatureThreshold) {
            this.logger.warn('High temperature detected', {
                temperature,
                threshold: this.optimizationSettings.temperatureThreshold,
            });
            if (temperature > this.optimizationSettings.temperatureThreshold + 10) {
                this.logger.error('Critical temperature reached, implementing emergency throttling');
                try {
                    await execAsync('echo powersave > /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor');
                    this.logger.info('Switched to powersave CPU governor');
                }
                catch (error) {
                    this.logger.warn('Failed to change CPU governor', { error });
                }
            }
        }
    }
    async optimizeProcesses(processes) {
        if (processes.ffmpeg > this.optimizationSettings.maxConcurrentStreams) {
            this.logger.warn('Too many FFmpeg processes detected', {
                current: processes.ffmpeg,
                max: this.optimizationSettings.maxConcurrentStreams,
            });
        }
        this.logger.debug('Process metrics', {
            total: processes.total,
            ffmpeg: processes.ffmpeg,
            node: processes.node,
        });
    }
    getOptimizedFFmpegOptions(inputUrl, outputUrl) {
        const options = [];
        if (this.optimizationSettings.enableHardwareDecoding) {
            options.push('-hwaccel', 'auto');
        }
        if (this.optimizationSettings.enableGpuAcceleration) {
            try {
                options.push('-c:v', 'h264_v4l2m2m');
            }
            catch {
                options.push('-c:v', 'libx264');
            }
        }
        else {
            options.push('-c:v', 'libx264');
        }
        options.push('-preset', 'ultrafast', '-tune', 'zerolatency', '-threads', '2', '-bufsize', '1000k', '-maxrate', '2500k', '-g', '60', '-sc_threshold', '0', '-profile:v', 'baseline', '-level', '3.1');
        options.push('-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2');
        options.push('-avoid_negative_ts', 'make_zero', '-fflags', '+genpts', '-max_muxing_queue_size', '1024');
        return options;
    }
    async getSystemRecommendations() {
        const metrics = await this.getPerformanceMetrics();
        const recommendations = [];
        if (metrics.memory.usage > 85) {
            recommendations.push('Consider increasing swap space or reducing concurrent streams');
        }
        if (metrics.cpu.usage > 90) {
            recommendations.push('CPU usage is high - consider reducing stream quality or enabling hardware acceleration');
        }
        if (metrics.cpu.temperature > 70) {
            recommendations.push('CPU temperature is high - improve cooling or reduce workload');
        }
        if (metrics.processes.ffmpeg > this.optimizationSettings.maxConcurrentStreams) {
            recommendations.push(`Too many FFmpeg processes (${metrics.processes.ffmpeg}/${this.optimizationSettings.maxConcurrentStreams})`);
        }
        if (metrics.disk.usage > 90) {
            recommendations.push('Disk space is low - clean up logs or increase storage');
        }
        return recommendations;
    }
    destroy() {
        if (this.gcTimer) {
            clearInterval(this.gcTimer);
            this.gcTimer = null;
        }
    }
}
exports.PerformanceOptimizer = PerformanceOptimizer;
//# sourceMappingURL=PerformanceOptimizer.js.map