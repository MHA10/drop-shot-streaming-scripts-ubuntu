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
const os = __importStar(require("os"));
const fs = __importStar(require("fs"));
class HealthMonitor {
    constructor(logger) {
        this.isRunning = false;
        this.checkInterval = 30000;
        this.lastHealthCheck = new Date();
        this.logger = logger;
    }
    start() {
        if (this.isRunning) {
            this.logger.warn('HealthMonitor is already running');
            return;
        }
        this.isRunning = true;
        this.logger.info('Starting HealthMonitor');
        this.performHealthCheck();
        this.intervalId = setInterval(() => {
            this.performHealthCheck();
        }, this.checkInterval);
    }
    stop() {
        if (!this.isRunning) {
            return;
        }
        this.isRunning = false;
        this.logger.info('Stopping HealthMonitor');
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
    }
    getHealthStatus() {
        const systemMetrics = this.getSystemMetrics();
        const uptime = process.uptime();
        let status = 'healthy';
        if (systemMetrics.cpu.usage > 90 || systemMetrics.memory.percentage > 90) {
            status = 'critical';
        }
        else if (systemMetrics.cpu.usage > 70 || systemMetrics.memory.percentage > 80) {
            status = 'warning';
        }
        return {
            status,
            uptime,
            activeStreams: 0,
            systemMetrics,
            lastCheck: this.lastHealthCheck
        };
    }
    performHealthCheck() {
        this.lastHealthCheck = new Date();
        const healthStatus = this.getHealthStatus();
        this.logger.info('Health check completed', {
            status: healthStatus.status,
            cpuUsage: healthStatus.systemMetrics.cpu.usage,
            memoryUsage: healthStatus.systemMetrics.memory.percentage,
            uptime: healthStatus.uptime
        });
        if (healthStatus.status === 'warning') {
            this.logger.warn('System health warning detected', {
                systemMetrics: healthStatus.systemMetrics
            });
        }
        else if (healthStatus.status === 'critical') {
            this.logger.error('Critical system health detected', undefined, {
                systemMetrics: healthStatus.systemMetrics
            });
        }
    }
    getSystemMetrics() {
        const cpuUsage = this.getCpuUsage();
        const memoryInfo = this.getMemoryInfo();
        const diskInfo = this.getDiskInfo();
        const networkInfo = this.getNetworkInfo();
        const temperature = this.getCpuTemperature();
        return {
            cpu: {
                usage: cpuUsage,
                ...(temperature !== undefined && { temperature })
            },
            memory: memoryInfo,
            disk: diskInfo,
            network: networkInfo
        };
    }
    getCpuUsage() {
        const cpus = os.cpus();
        let totalIdle = 0;
        let totalTick = 0;
        cpus.forEach(cpu => {
            for (const type in cpu.times) {
                totalTick += cpu.times[type];
            }
            totalIdle += cpu.times.idle;
        });
        const idle = totalIdle / cpus.length;
        const total = totalTick / cpus.length;
        const usage = 100 - ~~(100 * idle / total);
        return Math.max(0, Math.min(100, usage));
    }
    getMemoryInfo() {
        const total = os.totalmem();
        const free = os.freemem();
        const used = total - free;
        const percentage = (used / total) * 100;
        return {
            used: Math.round(used / 1024 / 1024),
            total: Math.round(total / 1024 / 1024),
            percentage: Math.round(percentage * 100) / 100
        };
    }
    getDiskInfo() {
        try {
            const stats = fs.statSync(process.cwd());
            return {
                used: 0,
                total: 0,
                percentage: 0
            };
        }
        catch (error) {
            this.logger.error('Failed to get disk info', error);
            return {
                used: 0,
                total: 0,
                percentage: 0
            };
        }
    }
    getNetworkInfo() {
        return {
            bytesIn: 0,
            bytesOut: 0
        };
    }
    getCpuTemperature() {
        try {
            if (fs.existsSync('/sys/class/thermal/thermal_zone0/temp')) {
                const tempStr = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8');
                return parseInt(tempStr.trim()) / 1000;
            }
        }
        catch (error) {
        }
        return undefined;
    }
    setCheckInterval(intervalMs) {
        this.checkInterval = intervalMs;
        if (this.isRunning && this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = setInterval(() => {
                this.performHealthCheck();
            }, this.checkInterval);
        }
    }
}
exports.HealthMonitor = HealthMonitor;
//# sourceMappingURL=HealthMonitor.js.map