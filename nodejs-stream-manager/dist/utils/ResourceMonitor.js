"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResourceMonitor = void 0;
const Logger_1 = require("./Logger");
const ConfigManager_1 = require("./ConfigManager");
const PerformanceOptimizer_1 = require("./PerformanceOptimizer");
const events_1 = require("events");
class ResourceMonitor extends events_1.EventEmitter {
    constructor() {
        super();
        this.monitoringInterval = null;
        this.alertHistory = [];
        this.maxAlertHistory = 100;
        this.isMonitoring = false;
        this.logger = Logger_1.Logger.getInstance();
        this.config = ConfigManager_1.ConfigManager.getInstance().getConfig();
        this.performanceOptimizer = new PerformanceOptimizer_1.PerformanceOptimizer();
        this.thresholds = this.loadThresholds();
    }
    loadThresholds() {
        return {
            memory: {
                warning: this.config.monitoring?.thresholds?.memory?.warning || 75,
                critical: this.config.monitoring?.thresholds?.memory?.critical || 90,
            },
            cpu: {
                warning: this.config.monitoring?.thresholds?.cpu?.warning || 80,
                critical: this.config.monitoring?.thresholds?.cpu?.critical || 95,
            },
            temperature: {
                warning: this.config.monitoring?.thresholds?.temperature?.warning || 70,
                critical: this.config.monitoring?.thresholds?.temperature?.critical || 80,
            },
            disk: {
                warning: this.config.monitoring?.thresholds?.disk?.warning || 85,
                critical: this.config.monitoring?.thresholds?.disk?.critical || 95,
            },
        };
    }
    startMonitoring(intervalMs = 30000) {
        if (this.isMonitoring) {
            this.logger.warn('Resource monitoring is already running');
            return;
        }
        this.logger.info('Starting resource monitoring', { intervalMs });
        this.isMonitoring = true;
        this.performResourceCheck();
        this.monitoringInterval = setInterval(() => {
            this.performResourceCheck();
        }, intervalMs);
        this.emit('monitoring_started', { intervalMs });
    }
    stopMonitoring() {
        if (!this.isMonitoring) {
            this.logger.warn('Resource monitoring is not running');
            return;
        }
        this.logger.info('Stopping resource monitoring');
        this.isMonitoring = false;
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = null;
        }
        this.emit('monitoring_stopped');
    }
    async performResourceCheck() {
        try {
            const metrics = await this.performanceOptimizer.getPerformanceMetrics();
            this.checkMemoryUsage(metrics.memory.usage);
            this.checkCpuUsage(metrics.cpu.usage);
            this.checkTemperature(metrics.cpu.temperature);
            this.checkDiskUsage(metrics.disk.usage);
            this.checkProcessCount(metrics.processes);
            this.emit('metrics_updated', metrics);
            await this.performanceOptimizer.optimizeForCurrentLoad();
        }
        catch (error) {
            this.logger.error('Failed to perform resource check', error);
            this.emit('monitoring_error', error);
        }
    }
    checkMemoryUsage(usage) {
        if (usage >= this.thresholds.memory.critical) {
            this.createAlert('memory', 'critical', `Critical memory usage: ${usage}%`, usage, this.thresholds.memory.critical, ['Restart services', 'Clear caches', 'Reduce concurrent streams']);
        }
        else if (usage >= this.thresholds.memory.warning) {
            this.createAlert('memory', 'warning', `High memory usage: ${usage}%`, usage, this.thresholds.memory.warning, ['Monitor closely', 'Consider reducing load']);
        }
    }
    checkCpuUsage(usage) {
        if (usage >= this.thresholds.cpu.critical) {
            this.createAlert('cpu', 'critical', `Critical CPU usage: ${usage}%`, usage, this.thresholds.cpu.critical, ['Reduce stream quality', 'Enable hardware acceleration', 'Limit concurrent streams']);
        }
        else if (usage >= this.thresholds.cpu.warning) {
            this.createAlert('cpu', 'warning', `High CPU usage: ${usage}%`, usage, this.thresholds.cpu.warning, ['Monitor performance', 'Consider optimization']);
        }
    }
    checkTemperature(temperature) {
        if (temperature >= this.thresholds.temperature.critical) {
            this.createAlert('temperature', 'critical', `Critical temperature: ${temperature}°C`, temperature, this.thresholds.temperature.critical, ['Improve cooling', 'Reduce workload immediately', 'Check thermal throttling']);
        }
        else if (temperature >= this.thresholds.temperature.warning) {
            this.createAlert('temperature', 'warning', `High temperature: ${temperature}°C`, temperature, this.thresholds.temperature.warning, ['Monitor cooling', 'Consider workload reduction']);
        }
    }
    checkDiskUsage(usage) {
        if (usage >= this.thresholds.disk.critical) {
            this.createAlert('disk', 'critical', `Critical disk usage: ${usage}%`, usage, this.thresholds.disk.critical, ['Clean up logs', 'Remove old files', 'Expand storage']);
        }
        else if (usage >= this.thresholds.disk.warning) {
            this.createAlert('disk', 'warning', `High disk usage: ${usage}%`, usage, this.thresholds.disk.warning, ['Plan cleanup', 'Monitor growth']);
        }
    }
    checkProcessCount(processes) {
        const maxFFmpeg = this.config.streaming?.maxConcurrentStreams || 2;
        if (processes.ffmpeg > maxFFmpeg) {
            this.createAlert('process', 'warning', `Too many FFmpeg processes: ${processes.ffmpeg}/${maxFFmpeg}`, processes.ffmpeg, maxFFmpeg, ['Stop unnecessary streams', 'Check for stuck processes']);
        }
        if (processes.total > 200) {
            this.createAlert('process', 'warning', `High process count: ${processes.total}`, processes.total, 200, ['Check for process leaks', 'Restart services if needed']);
        }
    }
    createAlert(type, level, message, value, threshold, recommendations) {
        const alert = {
            type,
            level,
            message,
            value,
            threshold,
            timestamp: new Date(),
            ...(recommendations && { recommendations }),
        };
        this.alertHistory.unshift(alert);
        if (this.alertHistory.length > this.maxAlertHistory) {
            this.alertHistory = this.alertHistory.slice(0, this.maxAlertHistory);
        }
        if (level === 'critical') {
            this.logger.error(`Critical ${type} alert: ${message}`, undefined, {
                alertType: type,
                value,
                threshold,
                recommendations
            });
        }
        else {
            this.logger.warn(`${type} warning: ${message}`, {
                alertType: type,
                value,
                threshold,
                recommendations
            });
        }
        this.emit('resource_alert', alert);
        if (level === 'critical') {
            this.handleCriticalAlert(alert);
        }
    }
    async handleCriticalAlert(alert) {
        this.logger.info('Handling critical alert', { alert: alert.type });
        try {
            switch (alert.type) {
                case 'memory':
                    await this.handleCriticalMemory();
                    break;
                case 'cpu':
                    await this.handleCriticalCpu();
                    break;
                case 'temperature':
                    await this.handleCriticalTemperature();
                    break;
                case 'disk':
                    await this.handleCriticalDisk();
                    break;
                default:
                    this.logger.warn('No auto-remediation for alert type', { type: alert.type });
            }
        }
        catch (error) {
            this.logger.error('Failed to handle critical alert', error, { alert: alert.type });
        }
    }
    async handleCriticalMemory() {
        if (global.gc) {
            global.gc();
        }
        try {
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);
            await execAsync('sync && echo 1 > /proc/sys/vm/drop_caches');
            this.logger.info('Cleared system caches due to critical memory usage');
        }
        catch (error) {
            this.logger.warn('Failed to clear system caches', { error });
        }
        this.emit('critical_memory', { action: 'reduce_load' });
    }
    async handleCriticalCpu() {
        try {
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);
            await execAsync('renice 19 -p $(pgrep -f ffmpeg)');
            this.logger.info('Reduced FFmpeg process priorities');
        }
        catch (error) {
            this.logger.debug('No FFmpeg processes to renice', { error });
        }
        this.emit('critical_cpu', { action: 'reduce_quality' });
    }
    async handleCriticalTemperature() {
        try {
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);
            await execAsync('echo powersave > /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor');
            this.logger.info('Switched to powersave CPU governor');
        }
        catch (error) {
            this.logger.warn('Failed to change CPU governor', { error });
        }
        this.emit('critical_temperature', { action: 'emergency_cooling' });
    }
    async handleCriticalDisk() {
        try {
            const { exec } = require('child_process');
            const { promisify } = require('util');
            const execAsync = promisify(exec);
            const logsPath = this.config.logging.directory || '/var/log/stream-manager';
            await execAsync(`find ${logsPath} -name "*.log" -mtime +7 -delete`);
            this.logger.info('Cleaned up old log files');
        }
        catch (error) {
            this.logger.warn('Failed to clean up logs', { error });
        }
        this.emit('critical_disk', { action: 'cleanup_required' });
    }
    getAlertHistory(limit) {
        return limit ? this.alertHistory.slice(0, limit) : [...this.alertHistory];
    }
    getRecentAlerts(minutes = 60) {
        const cutoff = new Date(Date.now() - minutes * 60 * 1000);
        return this.alertHistory.filter(alert => alert.timestamp > cutoff);
    }
    getCriticalAlerts() {
        return this.alertHistory.filter(alert => alert.level === 'critical');
    }
    getSystemHealth() {
        const recentAlerts = this.getRecentAlerts(30);
        const criticalAlerts = recentAlerts.filter(alert => alert.level === 'critical');
        const warningAlerts = recentAlerts.filter(alert => alert.level === 'warning');
        let status = 'healthy';
        if (criticalAlerts.length > 0) {
            status = 'critical';
        }
        else if (warningAlerts.length > 0) {
            status = 'warning';
        }
        const recommendations = Array.from(new Set(recentAlerts
            .filter(alert => alert.recommendations)
            .flatMap(alert => alert.recommendations)));
        return {
            status,
            alerts: recentAlerts,
            recommendations,
        };
    }
    updateThresholds(newThresholds) {
        this.thresholds = { ...this.thresholds, ...newThresholds };
        this.logger.info('Updated resource thresholds', { thresholds: this.thresholds });
        this.emit('thresholds_updated', this.thresholds);
    }
    isMonitoringActive() {
        return this.isMonitoring;
    }
    destroy() {
        this.stopMonitoring();
        this.performanceOptimizer.destroy();
        this.removeAllListeners();
    }
}
exports.ResourceMonitor = ResourceMonitor;
//# sourceMappingURL=ResourceMonitor.js.map