import { StreamManager } from '../core/StreamManager';
import { Logger } from '../utils/Logger';
import { ConfigManager } from '../utils/ConfigManager';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as fs from 'fs/promises';

const execAsync = promisify(exec);

export interface SystemHealth {
  cpu: {
    usage: number;
    temperature?: number;
    loadAverage: number[];
  };
  memory: {
    total: number;
    used: number;
    free: number;
    percentage: number;
  };
  disk: {
    total: number;
    used: number;
    free: number;
    percentage: number;
  };
  network: {
    interfaces: NetworkInterface[];
  };
  processes: {
    total: number;
    ffmpeg: number;
  };
  uptime: number;
  timestamp: number;
}

export interface NetworkInterface {
  name: string;
  address?: string;
  netmask?: string;
  family: string;
  internal: boolean;
}

export class HealthMonitor {
  private streamManager: StreamManager;
  private logger: Logger;
  private config: ReturnType<ConfigManager['getConfig']>;
  private monitoringInterval: NodeJS.Timeout | null = null;
  private isMonitoring = false;

  constructor(streamManager: StreamManager) {
    this.streamManager = streamManager;
    this.logger = Logger.getInstance();
    this.config = ConfigManager.getInstance().getConfig();
  }

  public startMonitoring(): void {
    if (this.isMonitoring) {
      this.logger.warn('Health monitoring already started');
      return;
    }

    this.logger.info('Starting health monitoring', {
      interval: this.config.server.healthCheckInterval
    });

    this.isMonitoring = true;
    this.monitoringInterval = setInterval(
      () => this.performHealthCheck(),
      this.config.server.healthCheckInterval
    );

    // Perform initial health check
    this.performHealthCheck();
  }

  public stopMonitoring(): void {
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

  private async performHealthCheck(): Promise<void> {
    try {
      this.logger.debug('Performing system health check');

      // Check stream health
      await this.streamManager.performHealthCheck();
      await this.streamManager.validateAndRecoverStreams();

      // Get system health metrics
      const systemHealth = await this.getSystemHealth();
      
      // Check for critical conditions
      this.checkCriticalConditions(systemHealth);

      // Log health summary
      this.logHealthSummary(systemHealth);

    } catch (error) {
      this.logger.error('Health check failed', error as Error);
    }
  }

  public async getSystemHealth(): Promise<SystemHealth> {
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

  private async getCpuInfo(): Promise<SystemHealth['cpu']> {
    const loadAverage = os.loadavg();
    const cpuCount = os.cpus().length;
    
    // Calculate CPU usage as percentage of load average
    const usage = Math.min(((loadAverage[0] ?? 0) / cpuCount) * 100, 100);

    let temperature: number | undefined;
    
    // Try to get CPU temperature on Raspberry Pi
    try {
      const tempData = await fs.readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8');
      temperature = parseInt(tempData.trim()) / 1000; // Convert from millidegrees
    } catch (error) {
      // Temperature not available or not on Raspberry Pi
    }

    const result: SystemHealth['cpu'] = {
      usage: Math.round(usage * 100) / 100,
      loadAverage
    };

    if (temperature !== undefined) {
      result.temperature = temperature;
    }

    return result;
  }

  private getMemoryInfo(): SystemHealth['memory'] {
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

  private async getDiskInfo(): Promise<SystemHealth['disk']> {
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
    } catch (error) {
      this.logger.debug('Failed to get disk info', { error });
    }

    // Fallback values
    return { total: 0, used: 0, free: 0, percentage: 0 };
  }

  private parseSize(sizeStr: string): number {
    const units: { [key: string]: number } = {
      'K': 1024,
      'M': 1024 * 1024,
      'G': 1024 * 1024 * 1024,
      'T': 1024 * 1024 * 1024 * 1024
    };

    const match = sizeStr.match(/^(\d+(?:\.\d+)?)([KMGT]?)$/);
    if (!match || !match[1]) return 0;

    const value = parseFloat(match[1]);
    const unit = match[2] || '';
    
    return Math.round(value * (units[unit] || 1));
  }

  private getNetworkInfo(): SystemHealth['network'] {
    const interfaces = os.networkInterfaces();
    const networkInterfaces: NetworkInterface[] = [];

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

  private async getProcessInfo(): Promise<SystemHealth['processes']> {
    try {
      // Count total processes
      const { stdout: totalProc } = await execAsync('ps aux | wc -l');
      const total = parseInt(totalProc.trim()) - 1; // Subtract header line

      // Count FFmpeg processes
      const { stdout: ffmpegProc } = await execAsync('pgrep -c ffmpeg || echo 0');
      const ffmpeg = parseInt(ffmpegProc.trim());

      return { total, ffmpeg };
    } catch (error) {
      this.logger.debug('Failed to get process info', { error });
      return { total: 0, ffmpeg: 0 };
    }
  }

  private checkCriticalConditions(health: SystemHealth): void {
    const thresholds = this.config.performance;

    // Check memory usage
    if (health.memory.percentage > thresholds.memoryThreshold) {
      this.logger.warn('High memory usage detected', {
        usage: health.memory.percentage,
        threshold: thresholds.memoryThreshold
      });
    }

    // Check CPU temperature (Raspberry Pi)
    if (health.cpu.temperature && health.cpu.temperature > thresholds.temperatureThreshold) {
      this.logger.warn('High CPU temperature detected', {
        temperature: health.cpu.temperature,
        threshold: thresholds.temperatureThreshold
      });
    }

    // Check disk usage
    if (health.disk.percentage > thresholds.diskThreshold) {
      this.logger.warn('High disk usage detected', {
        usage: health.disk.percentage,
        threshold: thresholds.diskThreshold
      });
    }

    // Check CPU load
    const cpuLoadThreshold = 80; // 80% CPU usage
    if (health.cpu.usage > cpuLoadThreshold) {
      this.logger.warn('High CPU load detected', {
        usage: health.cpu.usage,
        threshold: cpuLoadThreshold
      });
    }
  }

  private logHealthSummary(health: SystemHealth): void {
    const streamStats = this.streamManager.getSystemStats();
    
    this.logger.debug('System health summary', {
      cpu: {
        usage: health.cpu.usage,
        temperature: health.cpu.temperature,
        load: health.cpu.loadAverage[0]
      },
      memory: {
        percentage: health.memory.percentage,
        used: Math.round(health.memory.used / 1024 / 1024), // MB
        free: Math.round(health.memory.free / 1024 / 1024)  // MB
      },
      disk: {
        percentage: health.disk.percentage,
        free: Math.round(health.disk.free / 1024 / 1024 / 1024) // GB
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
      uptime: Math.round(health.uptime / 3600) // hours
    });
  }

  public async getDetailedReport(): Promise<{
    system: SystemHealth;
    streams: ReturnType<StreamManager['getSystemStats']>;
    timestamp: number;
  }> {
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

  public isHealthy(): boolean {
    // Basic health check - can be expanded
    return this.isMonitoring;
  }

  public cleanup(): void {
    this.logger.info('Cleaning up health monitor');
    this.stopMonitoring();
  }
}