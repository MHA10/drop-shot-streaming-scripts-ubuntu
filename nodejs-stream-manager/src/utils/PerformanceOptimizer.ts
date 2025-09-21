import { Logger } from './Logger';
import { ConfigManager } from './ConfigManager';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';

const execAsync = promisify(exec);

interface PerformanceMetrics {
  cpu: {
    usage: number;
    temperature: number;
    frequency: number;
    throttled: boolean;
  };
  memory: {
    total: number;
    used: number;
    free: number;
    usage: number;
    available: number;
  };
  disk: {
    total: number;
    used: number;
    free: number;
    usage: number;
  };
  network: {
    bytesReceived: number;
    bytesSent: number;
    packetsReceived: number;
    packetsSent: number;
  };
  processes: {
    total: number;
    ffmpeg: number;
    node: number;
  };
}

interface OptimizationSettings {
  maxConcurrentStreams: number;
  memoryThreshold: number;
  cpuThreshold: number;
  temperatureThreshold: number;
  enableGpuAcceleration: boolean;
  enableHardwareDecoding: boolean;
  ffmpegNiceLevel: number;
  gcInterval: number;
}

export class PerformanceOptimizer {
  private logger: Logger;
  private config: ReturnType<ConfigManager['getConfig']>;
  private optimizationSettings: OptimizationSettings;
  private lastMetrics: PerformanceMetrics | null = null;
  private gcTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.logger = Logger.getInstance();
    this.config = ConfigManager.getInstance().getConfig();
    this.optimizationSettings = this.loadOptimizationSettings();
    this.setupGarbageCollection();
  }

  private loadOptimizationSettings(): OptimizationSettings {
    return {
      maxConcurrentStreams: this.config.streaming?.maxConcurrentStreams || 2,
      memoryThreshold: this.config.performance?.memoryThreshold || 80,
      cpuThreshold: this.config.performance?.cpuThreshold || 85,
      temperatureThreshold: this.config.performance?.temperatureThreshold || 70,
      enableGpuAcceleration: this.config.performance?.enableGpuAcceleration || false,
      enableHardwareDecoding: this.config.performance?.enableHardwareDecoding || false,
      ffmpegNiceLevel: this.config.performance?.ffmpegNiceLevel || 10,
      gcInterval: this.config.performance?.gcInterval || 300000, // 5 minutes
    };
  }

  private setupGarbageCollection(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
    }

    this.gcTimer = setInterval(() => {
      this.forceGarbageCollection();
    }, this.optimizationSettings.gcInterval);
  }

  private forceGarbageCollection(): void {
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

  async getPerformanceMetrics(): Promise<PerformanceMetrics> {
    try {
      const [cpu, memory, disk, network, processes] = await Promise.all([
        this.getCpuMetrics(),
        this.getMemoryMetrics(),
        this.getDiskMetrics(),
        this.getNetworkMetrics(),
        this.getProcessMetrics(),
      ]);

      const metrics: PerformanceMetrics = {
        cpu,
        memory,
        disk,
        network,
        processes,
      };

      this.lastMetrics = metrics;
      return metrics;
    } catch (error) {
      this.logger.error('Failed to get performance metrics', error as Error);
      throw error;
    }
  }

  private async getCpuMetrics(): Promise<PerformanceMetrics['cpu']> {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type as keyof typeof cpu.times];
      }
      totalIdle += cpu.times.idle;
    });

    const usage = Math.round((1 - totalIdle / totalTick) * 100);

    // Get Raspberry Pi specific metrics
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

  private async getCpuTemperature(): Promise<number> {
    try {
      // Try Raspberry Pi thermal zone
      const tempData = await fs.readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8');
      return parseInt(tempData.trim()) / 1000;
    } catch {
      try {
        // Try vcgencmd (Raspberry Pi specific)
        const { stdout } = await execAsync('vcgencmd measure_temp');
        const match = stdout.match(/temp=(\d+\.\d+)/);
        return match && match[1] ? parseFloat(match[1]) : 0;
      } catch {
        return 0;
      }
    }
  }

  private async getCpuFrequency(): Promise<number> {
    try {
      const freqData = await fs.readFile('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq', 'utf8');
      return parseInt(freqData.trim()) / 1000; // Convert to MHz
    } catch {
      try {
        const { stdout } = await execAsync('vcgencmd measure_clock arm');
        const match = stdout.match(/frequency\(45\)=(\d+)/);
        return match && match[1] ? parseInt(match[1]) / 1000000 : 0; // Convert to MHz
      } catch {
        return 0;
      }
    }
  }

  private async getThrottleStatus(): Promise<boolean> {
    try {
      const { stdout } = await execAsync('vcgencmd get_throttled');
      const match = stdout.match(/throttled=0x(\w+)/);
      if (match && match[1]) {
        const throttleValue = parseInt(match[1], 16);
        // Check if any throttling bits are set
        return throttleValue !== 0;
      }
      return false;
    } catch {
      return false;
    }
  }

  private async getMemoryMetrics(): Promise<PerformanceMetrics['memory']> {
    const memInfo = await fs.readFile('/proc/meminfo', 'utf8');
    const lines = memInfo.split('\n');
    
    const getValue = (key: string): number => {
      const line = lines.find(l => l.startsWith(key));
      if (line) {
        const match = line.match(/(\d+)/);
        return match && match[1] ? parseInt(match[1]) * 1024 : 0; // Convert from kB to bytes
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

  private async getDiskMetrics(): Promise<PerformanceMetrics['disk']> {
    try {
      const { stdout } = await execAsync('df -B1 /');
      const lines = stdout.split('\n');
      const dataLine = lines[1];
      if (!dataLine) {
        throw new Error('No disk data available');
      }
      const parts = dataLine.split(/\s+/);
      
      const total = parts[1] ? parseInt(parts[1]) : 0;
      const used = parts[2] ? parseInt(parts[2]) : 0;
      const free = parts[3] ? parseInt(parts[3]) : 0;
      const usage = Math.round((used / total) * 100);

      return {
        total,
        used,
        free,
        usage,
      };
    } catch (error) {
      this.logger.warn('Failed to get disk metrics', { error });
      return {
        total: 0,
        used: 0,
        free: 0,
        usage: 0,
      };
    }
  }

  private async getNetworkMetrics(): Promise<PerformanceMetrics['network']> {
    try {
      const netDev = await fs.readFile('/proc/net/dev', 'utf8');
      const lines = netDev.split('\n');
      
      let bytesReceived = 0;
      let bytesSent = 0;
      let packetsReceived = 0;
      let packetsSent = 0;

      for (const line of lines) {
        if (line.includes(':') && !line.includes('lo:')) { // Skip loopback
          const parts = line.split(/\s+/);
          if (parts.length >= 10) {
            bytesReceived += (parts[1] ? parseInt(parts[1]) : 0) || 0;
            packetsReceived += (parts[2] ? parseInt(parts[2]) : 0) || 0;
            bytesSent += (parts[9] ? parseInt(parts[9]) : 0) || 0;
            packetsSent += (parts[10] ? parseInt(parts[10]) : 0) || 0;
          }
        }
      }

      return {
        bytesReceived,
        bytesSent,
        packetsReceived,
        packetsSent,
      };
    } catch (error) {
      this.logger.warn('Failed to get network metrics', { error });
      return {
        bytesReceived: 0,
        bytesSent: 0,
        packetsReceived: 0,
        packetsSent: 0,
      };
    }
  }

  private async getProcessMetrics(): Promise<PerformanceMetrics['processes']> {
    try {
      const { stdout: totalProc } = await execAsync('ps aux | wc -l');
      const { stdout: ffmpegProc } = await execAsync('pgrep -f ffmpeg | wc -l');
      const { stdout: nodeProc } = await execAsync('pgrep -f node | wc -l');

      return {
        total: (totalProc.trim() ? parseInt(totalProc.trim()) : 0) - 1, // Subtract header line
        ffmpeg: ffmpegProc.trim() ? parseInt(ffmpegProc.trim()) : 0,
        node: nodeProc.trim() ? parseInt(nodeProc.trim()) : 0,
      };
    } catch (error) {
      this.logger.warn('Failed to get process metrics', { error });
      return {
        total: 0,
        ffmpeg: 0,
        node: 0,
      };
    }
  }

  async optimizeForCurrentLoad(): Promise<void> {
    const metrics = await this.getPerformanceMetrics();
    
    // Check for performance issues and apply optimizations
    await this.checkMemoryPressure(metrics.memory);
    await this.checkCpuLoad(metrics.cpu);
    await this.checkTemperature(metrics.cpu.temperature);
    await this.optimizeProcesses(metrics.processes);
  }

  private async checkMemoryPressure(memory: PerformanceMetrics['memory']): Promise<void> {
    if (memory.usage > this.optimizationSettings.memoryThreshold) {
      this.logger.warn('High memory usage detected', {
        usage: memory.usage,
        threshold: this.optimizationSettings.memoryThreshold,
        usedMB: Math.round(memory.used / 1024 / 1024),
        totalMB: Math.round(memory.total / 1024 / 1024),
      });

      // Force garbage collection
      this.forceGarbageCollection();

      // Clear system caches if memory usage is critical
      if (memory.usage > 90) {
        try {
          await execAsync('sync && echo 1 > /proc/sys/vm/drop_caches');
          this.logger.info('Cleared system caches due to critical memory usage');
        } catch (error) {
          this.logger.warn('Failed to clear system caches', { error });
        }
      }
    }
  }

  private async checkCpuLoad(cpu: PerformanceMetrics['cpu']): Promise<void> {
    if (cpu.usage > this.optimizationSettings.cpuThreshold) {
      this.logger.warn('High CPU usage detected', {
        usage: cpu.usage,
        threshold: this.optimizationSettings.cpuThreshold,
        temperature: cpu.temperature,
        throttled: cpu.throttled,
      });

      // Reduce process priority for FFmpeg processes
      try {
        await execAsync(`renice ${this.optimizationSettings.ffmpegNiceLevel} -p $(pgrep -f ffmpeg)`);
        this.logger.info('Reduced FFmpeg process priority');
      } catch (error) {
        this.logger.debug('No FFmpeg processes to renice or renice failed', { error });
      }
    }
  }

  private async checkTemperature(temperature: number): Promise<void> {
    if (temperature > this.optimizationSettings.temperatureThreshold) {
      this.logger.warn('High temperature detected', {
        temperature,
        threshold: this.optimizationSettings.temperatureThreshold,
      });

      // Implement thermal throttling
      if (temperature > this.optimizationSettings.temperatureThreshold + 10) {
        this.logger.error('Critical temperature reached, implementing emergency throttling');
        
        // Reduce CPU frequency if possible
        try {
          await execAsync('echo powersave > /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor');
          this.logger.info('Switched to powersave CPU governor');
        } catch (error) {
          this.logger.warn('Failed to change CPU governor', { error });
        }
      }
    }
  }

  private async optimizeProcesses(processes: PerformanceMetrics['processes']): Promise<void> {
    // Check if we have too many FFmpeg processes
    if (processes.ffmpeg > this.optimizationSettings.maxConcurrentStreams) {
      this.logger.warn('Too many FFmpeg processes detected', {
        current: processes.ffmpeg,
        max: this.optimizationSettings.maxConcurrentStreams,
      });
    }

    // Log process information for monitoring
    this.logger.debug('Process metrics', {
      total: processes.total,
      ffmpeg: processes.ffmpeg,
      node: processes.node,
    });
  }

  getOptimizedFFmpegOptions(inputUrl: string, outputUrl: string): string[] {
    const options: string[] = [];

    // Hardware acceleration options for Raspberry Pi
    if (this.optimizationSettings.enableHardwareDecoding) {
      // Try to use hardware decoding if available
      options.push('-hwaccel', 'auto');
    }

    // GPU acceleration for Raspberry Pi 4
    if (this.optimizationSettings.enableGpuAcceleration) {
      try {
        // Check if GPU acceleration is available
        options.push('-c:v', 'h264_v4l2m2m');
      } catch {
        // Fallback to software encoding
        options.push('-c:v', 'libx264');
      }
    } else {
      options.push('-c:v', 'libx264');
    }

    // Optimize for low latency and resource usage
    options.push(
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-threads', '2', // Limit threads for Raspberry Pi
      '-bufsize', '1000k',
      '-maxrate', '2500k',
      '-g', '60', // Keyframe interval
      '-sc_threshold', '0',
      '-profile:v', 'baseline',
      '-level', '3.1'
    );

    // Audio optimization
    options.push(
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-ac', '2'
    );

    // Memory and CPU optimization
    options.push(
      '-avoid_negative_ts', 'make_zero',
      '-fflags', '+genpts',
      '-max_muxing_queue_size', '1024'
    );

    return options;
  }

  async getSystemRecommendations(): Promise<string[]> {
    const metrics = await this.getPerformanceMetrics();
    const recommendations: string[] = [];

    // Memory recommendations
    if (metrics.memory.usage > 85) {
      recommendations.push('Consider increasing swap space or reducing concurrent streams');
    }

    // CPU recommendations
    if (metrics.cpu.usage > 90) {
      recommendations.push('CPU usage is high - consider reducing stream quality or enabling hardware acceleration');
    }

    // Temperature recommendations
    if (metrics.cpu.temperature > 70) {
      recommendations.push('CPU temperature is high - improve cooling or reduce workload');
    }

    // Process recommendations
    if (metrics.processes.ffmpeg > this.optimizationSettings.maxConcurrentStreams) {
      recommendations.push(`Too many FFmpeg processes (${metrics.processes.ffmpeg}/${this.optimizationSettings.maxConcurrentStreams})`);
    }

    // Disk recommendations
    if (metrics.disk.usage > 90) {
      recommendations.push('Disk space is low - clean up logs or increase storage');
    }

    return recommendations;
  }

  destroy(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }
}