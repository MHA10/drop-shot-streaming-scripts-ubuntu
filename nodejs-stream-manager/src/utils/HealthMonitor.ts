import { Logger } from './Logger';
import { SystemMetrics, HealthStatus } from '../types';
import * as os from 'os';
import * as fs from 'fs';

export class HealthMonitor {
  private logger: Logger;
  private isRunning: boolean = false;
  private checkInterval: number = 30000; // 30 seconds
  private intervalId?: NodeJS.Timeout;
  private lastHealthCheck: Date = new Date();

  constructor(logger: Logger) {
    this.logger = logger;
  }

  public start(): void {
    if (this.isRunning) {
      this.logger.warn('HealthMonitor is already running');
      return;
    }

    this.isRunning = true;
    this.logger.info('Starting HealthMonitor');
    
    // Perform initial health check
    this.performHealthCheck();
    
    // Schedule periodic health checks
    this.intervalId = setInterval(() => {
      this.performHealthCheck();
    }, this.checkInterval);
  }

  public stop(): void {
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

  public getHealthStatus(): HealthStatus {
    const systemMetrics = this.getSystemMetrics();
    const uptime = process.uptime();
    
    // Determine overall health status
    let status: 'healthy' | 'warning' | 'critical' = 'healthy';
    
    if (systemMetrics.cpu.usage > 90 || systemMetrics.memory.percentage > 90) {
      status = 'critical';
    } else if (systemMetrics.cpu.usage > 70 || systemMetrics.memory.percentage > 80) {
      status = 'warning';
    }

    return {
      status,
      uptime,
      activeStreams: 0, // This would be populated by the stream manager
      systemMetrics,
      lastCheck: this.lastHealthCheck
    };
  }

  private performHealthCheck(): void {
    this.lastHealthCheck = new Date();
    const healthStatus = this.getHealthStatus();
    
    this.logger.info('Health check completed', {
      status: healthStatus.status,
      cpuUsage: healthStatus.systemMetrics.cpu.usage,
      memoryUsage: healthStatus.systemMetrics.memory.percentage,
      uptime: healthStatus.uptime
    });

    // Log warnings or critical status
    if (healthStatus.status === 'warning') {
      this.logger.warn('System health warning detected', {
        systemMetrics: healthStatus.systemMetrics
      });
    } else if (healthStatus.status === 'critical') {
      this.logger.error('Critical system health detected', undefined, {
        systemMetrics: healthStatus.systemMetrics
      });
    }
  }

  private getSystemMetrics(): SystemMetrics {
    const cpuUsage = this.getCpuUsage();
    const memoryInfo = this.getMemoryInfo();
    const diskInfo = this.getDiskInfo();
    const networkInfo = this.getNetworkInfo();

    return {
      cpu: {
        usage: cpuUsage,
        temperature: this.getCpuTemperature()
      },
      memory: memoryInfo,
      disk: diskInfo,
      network: networkInfo
    };
  }

  private getCpuUsage(): number {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type as keyof typeof cpu.times];
      }
      totalIdle += cpu.times.idle;
    });

    const idle = totalIdle / cpus.length;
    const total = totalTick / cpus.length;
    const usage = 100 - ~~(100 * idle / total);

    return Math.max(0, Math.min(100, usage));
  }

  private getMemoryInfo(): { used: number; total: number; percentage: number } {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    const percentage = (used / total) * 100;

    return {
      used: Math.round(used / 1024 / 1024), // MB
      total: Math.round(total / 1024 / 1024), // MB
      percentage: Math.round(percentage * 100) / 100
    };
  }

  private getDiskInfo(): { used: number; total: number; percentage: number } {
    try {
      const stats = fs.statSync(process.cwd());
      // This is a simplified implementation
      // In a real scenario, you'd use a library like 'diskusage' or system calls
      return {
        used: 0,
        total: 0,
        percentage: 0
      };
    } catch (error) {
      this.logger.error('Failed to get disk info', error as Error);
      return {
        used: 0,
        total: 0,
        percentage: 0
      };
    }
  }

  private getNetworkInfo(): { bytesIn: number; bytesOut: number } {
    // This is a simplified implementation
    // In a real scenario, you'd track network interface statistics
    return {
      bytesIn: 0,
      bytesOut: 0
    };
  }

  private getCpuTemperature(): number | undefined {
    try {
      // This is platform-specific and simplified
      // On Raspberry Pi, you might read from /sys/class/thermal/thermal_zone0/temp
      if (fs.existsSync('/sys/class/thermal/thermal_zone0/temp')) {
        const tempStr = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8');
        return parseInt(tempStr.trim()) / 1000; // Convert from millidegrees
      }
    } catch (error) {
      // Temperature reading is optional
    }
    return undefined;
  }

  public setCheckInterval(intervalMs: number): void {
    this.checkInterval = intervalMs;
    
    if (this.isRunning && this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = setInterval(() => {
        this.performHealthCheck();
      }, this.checkInterval);
    }
  }
}