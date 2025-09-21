import { Logger } from './Logger';
import { ConfigManager } from './ConfigManager';
import { PerformanceOptimizer } from './PerformanceOptimizer';
import { EventEmitter } from 'events';

interface ResourceThresholds {
  memory: {
    warning: number;
    critical: number;
  };
  cpu: {
    warning: number;
    critical: number;
  };
  temperature: {
    warning: number;
    critical: number;
  };
  disk: {
    warning: number;
    critical: number;
  };
}

interface ResourceAlert {
  type: 'memory' | 'cpu' | 'temperature' | 'disk' | 'process';
  level: 'warning' | 'critical';
  message: string;
  value: number;
  threshold: number;
  timestamp: Date;
  recommendations?: string[];
}

export class ResourceMonitor extends EventEmitter {
  private logger: Logger;
  private config: ReturnType<ConfigManager['getConfig']>;
  private performanceOptimizer: PerformanceOptimizer;
  private thresholds: ResourceThresholds;
  private monitoringInterval: NodeJS.Timeout | null = null;
  private alertHistory: ResourceAlert[] = [];
  private maxAlertHistory = 100;
  private isMonitoring = false;

  constructor() {
    super();
    this.logger = Logger.getInstance();
    this.config = ConfigManager.getInstance().getConfig();
    this.performanceOptimizer = new PerformanceOptimizer();
    this.thresholds = this.loadThresholds();
  }

  private loadThresholds(): ResourceThresholds {
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

  startMonitoring(intervalMs: number = 30000): void {
    if (this.isMonitoring) {
      this.logger.warn('Resource monitoring is already running');
      return;
    }

    this.logger.info('Starting resource monitoring', { intervalMs });
    this.isMonitoring = true;

    // Initial check
    this.performResourceCheck();

    // Set up periodic monitoring
    this.monitoringInterval = setInterval(() => {
      this.performResourceCheck();
    }, intervalMs);

    this.emit('monitoring_started', { intervalMs });
  }

  stopMonitoring(): void {
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

  private async performResourceCheck(): Promise<void> {
    try {
      const metrics = await this.performanceOptimizer.getPerformanceMetrics();
      
      // Check each resource type
      this.checkMemoryUsage(metrics.memory.usage);
      this.checkCpuUsage(metrics.cpu.usage);
      this.checkTemperature(metrics.cpu.temperature);
      this.checkDiskUsage(metrics.disk.usage);
      this.checkProcessCount(metrics.processes);

      // Emit metrics for external monitoring
      this.emit('metrics_updated', metrics);

      // Auto-optimize if needed
      await this.performanceOptimizer.optimizeForCurrentLoad();

    } catch (error) {
      this.logger.error('Failed to perform resource check', error as Error);
      this.emit('monitoring_error', error);
    }
  }

  private checkMemoryUsage(usage: number): void {
    if (usage >= this.thresholds.memory.critical) {
      this.createAlert('memory', 'critical', 
        `Critical memory usage: ${usage}%`, 
        usage, this.thresholds.memory.critical,
        ['Restart services', 'Clear caches', 'Reduce concurrent streams']
      );
    } else if (usage >= this.thresholds.memory.warning) {
      this.createAlert('memory', 'warning', 
        `High memory usage: ${usage}%`, 
        usage, this.thresholds.memory.warning,
        ['Monitor closely', 'Consider reducing load']
      );
    }
  }

  private checkCpuUsage(usage: number): void {
    if (usage >= this.thresholds.cpu.critical) {
      this.createAlert('cpu', 'critical', 
        `Critical CPU usage: ${usage}%`, 
        usage, this.thresholds.cpu.critical,
        ['Reduce stream quality', 'Enable hardware acceleration', 'Limit concurrent streams']
      );
    } else if (usage >= this.thresholds.cpu.warning) {
      this.createAlert('cpu', 'warning', 
        `High CPU usage: ${usage}%`, 
        usage, this.thresholds.cpu.warning,
        ['Monitor performance', 'Consider optimization']
      );
    }
  }

  private checkTemperature(temperature: number): void {
    if (temperature >= this.thresholds.temperature.critical) {
      this.createAlert('temperature', 'critical', 
        `Critical temperature: ${temperature}°C`, 
        temperature, this.thresholds.temperature.critical,
        ['Improve cooling', 'Reduce workload immediately', 'Check thermal throttling']
      );
    } else if (temperature >= this.thresholds.temperature.warning) {
      this.createAlert('temperature', 'warning', 
        `High temperature: ${temperature}°C`, 
        temperature, this.thresholds.temperature.warning,
        ['Monitor cooling', 'Consider workload reduction']
      );
    }
  }

  private checkDiskUsage(usage: number): void {
    if (usage >= this.thresholds.disk.critical) {
      this.createAlert('disk', 'critical', 
        `Critical disk usage: ${usage}%`, 
        usage, this.thresholds.disk.critical,
        ['Clean up logs', 'Remove old files', 'Expand storage']
      );
    } else if (usage >= this.thresholds.disk.warning) {
      this.createAlert('disk', 'warning', 
        `High disk usage: ${usage}%`, 
        usage, this.thresholds.disk.warning,
        ['Plan cleanup', 'Monitor growth']
      );
    }
  }

  private checkProcessCount(processes: any): void {
    const maxFFmpeg = this.config.streaming?.maxConcurrentStreams || 2;
    
    if (processes.ffmpeg > maxFFmpeg) {
      this.createAlert('process', 'warning', 
        `Too many FFmpeg processes: ${processes.ffmpeg}/${maxFFmpeg}`, 
        processes.ffmpeg, maxFFmpeg,
        ['Stop unnecessary streams', 'Check for stuck processes']
      );
    }

    // Check for excessive total processes
    if (processes.total > 200) {
      this.createAlert('process', 'warning', 
        `High process count: ${processes.total}`, 
        processes.total, 200,
        ['Check for process leaks', 'Restart services if needed']
      );
    }
  }

  private createAlert(
    type: ResourceAlert['type'], 
    level: ResourceAlert['level'], 
    message: string, 
    value: number, 
    threshold: number,
    recommendations?: string[]
  ): void {
    const alert: ResourceAlert = {
      type,
      level,
      message,
      value,
      threshold,
      timestamp: new Date(),
      ...(recommendations && { recommendations }),
    };

    // Add to history
    this.alertHistory.unshift(alert);
    if (this.alertHistory.length > this.maxAlertHistory) {
      this.alertHistory = this.alertHistory.slice(0, this.maxAlertHistory);
    }

    // Log the alert
    if (level === 'critical') {
      this.logger.error(message, undefined, { 
        type, 
        value, 
        threshold, 
        recommendations 
      });
    } else {
      this.logger.warn(message, { 
        type, 
        value, 
        threshold, 
        recommendations 
      });
    }

    // Emit alert event
    this.emit('resource_alert', alert);

    // Auto-remediation for critical alerts
    if (level === 'critical') {
      this.handleCriticalAlert(alert);
    }
  }

  private async handleCriticalAlert(alert: ResourceAlert): Promise<void> {
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
    } catch (error) {
      this.logger.error('Failed to handle critical alert', error as Error, { alert: alert.type });
    }
  }

  private async handleCriticalMemory(): Promise<void> {
    // Force garbage collection
    if (global.gc) {
      global.gc();
    }

    // Clear system caches
    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      
      await execAsync('sync && echo 1 > /proc/sys/vm/drop_caches');
      this.logger.info('Cleared system caches due to critical memory usage');
    } catch (error) {
      this.logger.warn('Failed to clear system caches', { error });
    }

    // Emit event for external handling (e.g., stopping streams)
    this.emit('critical_memory', { action: 'reduce_load' });
  }

  private async handleCriticalCpu(): Promise<void> {
    // Reduce process priorities
    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      
      await execAsync('renice 19 -p $(pgrep -f ffmpeg)');
      this.logger.info('Reduced FFmpeg process priorities');
    } catch (error) {
      this.logger.debug('No FFmpeg processes to renice', { error });
    }

    // Emit event for external handling
    this.emit('critical_cpu', { action: 'reduce_quality' });
  }

  private async handleCriticalTemperature(): Promise<void> {
    // Switch to power-saving mode
    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      
      await execAsync('echo powersave > /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor');
      this.logger.info('Switched to powersave CPU governor');
    } catch (error) {
      this.logger.warn('Failed to change CPU governor', { error });
    }

    // Emit event for emergency cooling
    this.emit('critical_temperature', { action: 'emergency_cooling' });
  }

  private async handleCriticalDisk(): Promise<void> {
    // Clean up old logs
    try {
      const { exec } = require('child_process');
      const { promisify } = require('util');
      const execAsync = promisify(exec);
      
      const logsPath = this.config.logging.directory || '/var/log/stream-manager';
      await execAsync(`find ${logsPath} -name "*.log" -mtime +7 -delete`);
      this.logger.info('Cleaned up old log files');
    } catch (error) {
      this.logger.warn('Failed to clean up logs', { error });
    }

    // Emit event for external cleanup
    this.emit('critical_disk', { action: 'cleanup_required' });
  }

  getAlertHistory(limit?: number): ResourceAlert[] {
    return limit ? this.alertHistory.slice(0, limit) : [...this.alertHistory];
  }

  getRecentAlerts(minutes: number = 60): ResourceAlert[] {
    const cutoff = new Date(Date.now() - minutes * 60 * 1000);
    return this.alertHistory.filter(alert => alert.timestamp > cutoff);
  }

  getCriticalAlerts(): ResourceAlert[] {
    return this.alertHistory.filter(alert => alert.level === 'critical');
  }

  getSystemHealth(): {
    status: 'healthy' | 'warning' | 'critical';
    alerts: ResourceAlert[];
    recommendations: string[];
  } {
    const recentAlerts = this.getRecentAlerts(30); // Last 30 minutes
    const criticalAlerts = recentAlerts.filter(alert => alert.level === 'critical');
    const warningAlerts = recentAlerts.filter(alert => alert.level === 'warning');

    let status: 'healthy' | 'warning' | 'critical' = 'healthy';
    if (criticalAlerts.length > 0) {
      status = 'critical';
    } else if (warningAlerts.length > 0) {
      status = 'warning';
    }

    // Collect unique recommendations
    const recommendations = Array.from(new Set(
      recentAlerts
        .filter(alert => alert.recommendations)
        .flatMap(alert => alert.recommendations!)
    ));

    return {
      status,
      alerts: recentAlerts,
      recommendations,
    };
  }

  updateThresholds(newThresholds: Partial<ResourceThresholds>): void {
    this.thresholds = { ...this.thresholds, ...newThresholds };
    this.logger.info('Updated resource thresholds', { thresholds: this.thresholds });
    this.emit('thresholds_updated', this.thresholds);
  }

  isMonitoringActive(): boolean {
    return this.isMonitoring;
  }

  destroy(): void {
    this.stopMonitoring();
    this.performanceOptimizer.destroy();
    this.removeAllListeners();
  }
}