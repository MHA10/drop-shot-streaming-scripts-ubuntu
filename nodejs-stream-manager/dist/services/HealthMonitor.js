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
exports.HealthMonitor = void 0;
const Logger_1 = require("../utils/Logger");
const ConfigManager_1 = require("../utils/ConfigManager");
const child_process_1 = require("child_process");
const util_1 = require("util");
const os = __importStar(require("os"));
const fs = __importStar(require("fs/promises"));
const execAsync = (0, util_1.promisify)(child_process_1.exec);
class HealthMonitor {
    constructor(streamManager) {
        this.monitoringInterval = null;
        this.isMonitoring = false;
        this.streamManager = streamManager;
        this.logger = Logger_1.Logger.getInstance();
        this.config = ConfigManager_1.ConfigManager.getInstance().getConfig();
    }
    startMonitoring() {
        if (this.isMonitoring) {
            this.logger.warn('Health monitoring already started');
            return;
        }
        this.logger.info('Starting health monitoring', {
            interval: this.config.server.healthCheckInterval
        });
        this.isMonitoring = true;
        this.monitoringInterval = setInterval(() => this.performHealthCheck(), this.config.server.healthCheckInterval);
        this.performHealthCheck();
    }
    stopMonitoring() {
        if (!this.isMonitoring) {
            return;
        }
        this.logger.info('Stopping health monitoring');
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }
        this.isMonitoring = false;
    }
    async performHealthCheck() {
        try {
            this.logger.debug('Performing system health check');
            await this.streamManager.performHealthCheck();
            await this.streamManager.validateAndRecoverStreams();
            const systemHealth = await this.getSystemHealth();
            this.checkCriticalConditions(systemHealth);
            this.logHealthSummary(systemHealth);
        }
        catch (error) {
            this.logger.error('Health check failed', error);
        }
    }
    async getSystemHealth() {
        const [cpuInfo, memoryInfo, diskInfo, networkInfo, processInfo] = await Promise.all([
            this.getCpuInfo(),
            this.getMemoryInfo(),
            this.getDiskInfo(),
            this.getNetworkInfo(),
            this.getProcessInfo()
        ]);
        return {
            cpu: cpuInfo,
            memory: memoryInfo,
            disk: diskInfo,
            network: networkInfo,
            processes: processInfo,
            uptime: os.uptime(),
            timestamp: Date.now()
        };
    }
    async getCpuInfo() {
        const loadAverage = os.loadavg();
        const cpuCount = os.cpus().length;
        const usage = Math.min(((loadAverage[0] ?? 0) / cpuCount) * 100, 100);
        let temperature;
        try {
            const tempData = await fs.readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8');
            temperature = parseInt(tempData.trim()) / 1000;
        }
        catch (error) {
        }
        const result = {
            usage: Math.round(usage * 100) / 100,
            loadAverage
        };
        if (temperature !== undefined) {
            result.temperature = temperature;
        }
        return result;
    }
    getMemoryInfo() {
        const total = os.totalmem();
        const free = os.freemem();
        const used = total - free;
        const percentage = (used / total) * 100;
        return {
            total,
            used,
            free,
            percentage: Math.round(percentage * 100) / 100
        };
    }
    async getDiskInfo() {
        try {
            const { stdout } = await execAsync('df -h / | tail -1');
            const parts = stdout.trim().split(/\s+/);
            if (parts.length >= 6 && parts[1] && parts[2] && parts[3] && parts[4]) {
                const total = this.parseSize(parts[1]);
                const used = this.parseSize(parts[2]);
                const free = this.parseSize(parts[3]);
                const percentage = parseFloat(parts[4].replace('%', ''));
                return { total, used, free, percentage };
            }
        }
        catch (error) {
            this.logger.debug('Failed to get disk info', { error });
        }
        return { total: 0, used: 0, free: 0, percentage: 0 };
    }
    parseSize(sizeStr) {
        const units = {
            'K': 1024,
            'M': 1024 * 1024,
            'G': 1024 * 1024 * 1024,
            'T': 1024 * 1024 * 1024 * 1024
        };
        const match = sizeStr.match(/^(\d+(?:\.\d+)?)([KMGT]?)$/);
        if (!match || !match[1])
            return 0;
        const value = parseFloat(match[1]);
        const unit = match[2] || '';
        return Math.round(value * (units[unit] || 1));
    }
    getNetworkInfo() {
        const interfaces = os.networkInterfaces();
        const networkInterfaces = [];
        for (const [name, addresses] of Object.entries(interfaces)) {
            if (addresses && Array.isArray(addresses)) {
                for (const addr of addresses) {
                    networkInterfaces.push({
                        name,
                        address: addr.address,
                        netmask: addr.netmask,
                        family: addr.family,
                        internal: addr.internal
                    });
                }
            }
        }
        return { interfaces: networkInterfaces };
    }
    async getProcessInfo() {
        try {
            const { stdout: totalProc } = await execAsync('ps aux | wc -l');
            const total = parseInt(totalProc.trim()) - 1;
            const { stdout: ffmpegProc } = await execAsync('pgrep -c ffmpeg || echo 0');
            const ffmpeg = parseInt(ffmpegProc.trim());
            return { total, ffmpeg };
        }
        catch (error) {
            this.logger.debug('Failed to get process info', { error });
            return { total: 0, ffmpeg: 0 };
        }
    }
    checkCriticalConditions(health) {
        const thresholds = this.config.performance;
        if (health.memory.percentage > thresholds.memoryThreshold) {
            this.logger.warn('High memory usage detected', {
                usage: health.memory.percentage,
                threshold: thresholds.memoryThreshold
            });
        }
        if (health.cpu.temperature && health.cpu.temperature > thresholds.temperatureThreshold) {
            this.logger.warn('High CPU temperature detected', {
                temperature: health.cpu.temperature,
                threshold: thresholds.temperatureThreshold
            });
        }
        if (health.disk.percentage > thresholds.diskThreshold) {
            this.logger.warn('High disk usage detected', {
                usage: health.disk.percentage,
                threshold: thresholds.diskThreshold
            });
        }
        const cpuLoadThreshold = 80;
        if (health.cpu.usage > cpuLoadThreshold) {
            this.logger.warn('High CPU load detected', {
                usage: health.cpu.usage,
                threshold: cpuLoadThreshold
            });
        }
    }
    logHealthSummary(health) {
        const streamStats = this.streamManager.getSystemStats();
        this.logger.debug('System health summary', {
            cpu: {
                usage: health.cpu.usage,
                temperature: health.cpu.temperature,
                load: health.cpu.loadAverage[0]
            },
            memory: {
                percentage: health.memory.percentage,
                used: Math.round(health.memory.used / 1024 / 1024),
                free: Math.round(health.memory.free / 1024 / 1024)
            },
            disk: {
                percentage: health.disk.percentage,
                free: Math.round(health.disk.free / 1024 / 1024 / 1024)
            },
            streams: {
                active: streamStats.streams.active,
                failed: streamStats.streams.failed,
                total: streamStats.streams.total
            },
            processes: {
                ffmpeg: health.processes.ffmpeg,
                total: health.processes.total
            },
            uptime: Math.round(health.uptime / 3600)
        });
    }
    async getDetailedReport() {
        const [systemHealth, streamStats] = await Promise.all([
            this.getSystemHealth(),
            Promise.resolve(this.streamManager.getSystemStats())
        ]);
        return {
            system: systemHealth,
            streams: streamStats,
            timestamp: Date.now()
        };
    }
    isHealthy() {
        return this.isMonitoring;
    }
    cleanup() {
        this.logger.info('Cleaning up health monitor');
        this.stopMonitoring();
    }
}
exports.HealthMonitor = HealthMonitor;
//# sourceMappingURL=HealthMonitor.js.map