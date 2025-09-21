import { Logger } from './Logger';
import { ConfigManager } from './ConfigManager';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';

const execAsync = promisify(exec);

export interface SystemOptimizationConfig {
  enableGpuMemorySplit: boolean;
  gpuMemoryMB: number;
  enableOverclock: boolean;
  cpuFrequencyMHz: number;
  enableSwap: boolean;
  swapSizeMB: number;
  enableZram: boolean;
  zramSizeMB: number;
  optimizeNetwork: boolean;
  enableLowLatency: boolean;
  disableUnusedServices: boolean;
  optimizeFilesystem: boolean;
}

export class SystemOptimizer {
  private logger: Logger;
  private config: ConfigManager;
  private optimizationConfig: SystemOptimizationConfig;
  private isRaspberryPi: boolean = false;
  private piModel: string = '';
  private originalConfigs: Map<string, string> = new Map();

  constructor(logger: Logger, config: ConfigManager) {
    this.logger = logger;
    this.config = config;
    
    this.optimizationConfig = {
      enableGpuMemorySplit: true,
      gpuMemoryMB: 64,
      enableOverclock: false,
      cpuFrequencyMHz: 1500,
      enableSwap: true,
      swapSizeMB: 1024,
      enableZram: true,
      zramSizeMB: 512,
      optimizeNetwork: true,
      enableLowLatency: true,
      disableUnusedServices: true,
      optimizeFilesystem: true
    };
  }

  async initialize(): Promise<void> {
    try {
      await this.detectRaspberryPi();
      if (this.isRaspberryPi) {
        this.logger.info(`Detected Raspberry Pi: ${this.piModel}`);
        await this.loadOptimizationConfig();
      } else {
        this.logger.info('Not running on Raspberry Pi - skipping Pi-specific optimizations');
      }
    } catch (error) {
      this.logger.error('Failed to initialize SystemOptimizer', error as Error);
    }
  }

  private async detectRaspberryPi(): Promise<void> {
    try {
      // Check for Raspberry Pi hardware
      const cpuInfo = await fs.readFile('/proc/cpuinfo', 'utf8');
      
      if (cpuInfo.includes('Raspberry Pi')) {
        this.isRaspberryPi = true;
        
        // Extract model information
        const modelMatch = cpuInfo.match(/Model\s*:\s*(.+)/);
        if (modelMatch && modelMatch[1]) {
          this.piModel = modelMatch[1].trim();
        }
        
        // Check revision for more specific model info
        const revisionMatch = cpuInfo.match(/Revision\s*:\s*([a-fA-F0-9]+)/);
        if (revisionMatch && !this.piModel) {
          this.piModel = `Revision ${revisionMatch[1]}`;
        }
      }
    } catch (error) {
      // Not a Raspberry Pi or can't detect
      this.isRaspberryPi = false;
    }
  }

  private async loadOptimizationConfig(): Promise<void> {
    try {
      const performanceConfig = this.config.get('performance');
      // Use performance config values to adjust optimization settings
      if (performanceConfig) {
        this.optimizationConfig = {
          ...this.optimizationConfig,
          enableGpuMemorySplit: true,
          enableSwap: performanceConfig.memoryThreshold > 80,
          enableZram: performanceConfig.memoryThreshold > 70,
          optimizeNetwork: true,
          enableLowLatency: performanceConfig.cpuThreshold < 80,
          disableUnusedServices: true,
          optimizeFilesystem: true
        };
      }
    } catch (error) {
      this.logger.warn('Failed to load optimization config, using defaults', error as Error);
    }
  }

  async applyOptimizations(): Promise<void> {
    if (!this.isRaspberryPi) {
      this.logger.info('Skipping Raspberry Pi optimizations - not running on Pi');
      return;
    }

    this.logger.info('Applying Raspberry Pi system optimizations');

    try {
      await this.backupCurrentConfigs();
      
      if (this.optimizationConfig.enableGpuMemorySplit) {
        await this.optimizeGpuMemory();
      }
      
      if (this.optimizationConfig.enableSwap) {
        await this.optimizeSwap();
      }
      
      if (this.optimizationConfig.enableZram) {
        await this.setupZram();
      }
      
      if (this.optimizationConfig.optimizeNetwork) {
        await this.optimizeNetwork();
      }
      
      if (this.optimizationConfig.enableLowLatency) {
        await this.enableLowLatencyOptimizations();
      }
      
      if (this.optimizationConfig.disableUnusedServices) {
        await this.disableUnusedServices();
      }
      
      if (this.optimizationConfig.optimizeFilesystem) {
        await this.optimizeFilesystem();
      }
      
      await this.optimizeKernelParameters();
      await this.optimizeSystemLimits();
      
      this.logger.info('System optimizations applied successfully');
      
    } catch (error) {
      this.logger.error('Failed to apply system optimizations', error as Error);
      await this.revertOptimizations();
    }
  }

  private async backupCurrentConfigs(): Promise<void> {
    const configFiles = [
      '/boot/config.txt',
      '/etc/sysctl.conf',
      '/etc/security/limits.conf'
    ];

    for (const configFile of configFiles) {
      try {
        const content = await fs.readFile(configFile, 'utf8');
        this.originalConfigs.set(configFile, content);
      } catch (error) {
        this.logger.warn(`Could not backup ${configFile}`, error as Error);
      }
    }
  }

  private async optimizeGpuMemory(): Promise<void> {
    try {
      const configPath = '/boot/config.txt';
      let config = await fs.readFile(configPath, 'utf8');
      
      // Remove existing gpu_mem settings
      config = config.replace(/^gpu_mem=.*$/gm, '');
      
      // Add optimized GPU memory setting
      config += `\n# Stream Manager GPU Memory Optimization\ngpu_mem=${this.optimizationConfig.gpuMemoryMB}\n`;
      
      await fs.writeFile(configPath, config);
      this.logger.info(`Set GPU memory to ${this.optimizationConfig.gpuMemoryMB}MB`);
      
    } catch (error) {
      this.logger.error('Failed to optimize GPU memory', error as Error);
    }
  }

  private async optimizeSwap(): Promise<void> {
    try {
      // Check if swap is already configured
      const { stdout: swapInfo } = await execAsync('swapon --show');
      
      if (swapInfo.includes('/swapfile')) {
        this.logger.info('Swap already configured');
        return;
      }
      
      const swapSizeMB = this.optimizationConfig.swapSizeMB;
      
      // Create swap file
      await execAsync(`sudo fallocate -l ${swapSizeMB}M /swapfile`);
      await execAsync('sudo chmod 600 /swapfile');
      await execAsync('sudo mkswap /swapfile');
      await execAsync('sudo swapon /swapfile');
      
      // Add to fstab for persistence
      const fstabEntry = '/swapfile none swap sw 0 0\n';
      await execAsync(`echo "${fstabEntry}" | sudo tee -a /etc/fstab`);
      
      this.logger.info(`Created ${swapSizeMB}MB swap file`);
      
    } catch (error) {
      this.logger.error('Failed to optimize swap', error as Error);
    }
  }

  private async setupZram(): Promise<void> {
    try {
      // Install zram-tools if not present
      await execAsync('sudo apt-get update && sudo apt-get install -y zram-tools').catch(() => {
        this.logger.warn('Could not install zram-tools');
      });
      
      // Configure zram
      const zramConfig = `
# Stream Manager ZRAM Configuration
ALGO=lz4
PERCENT=${Math.round((this.optimizationConfig.zramSizeMB / 1024) * 100)}
SIZE=${this.optimizationConfig.zramSizeMB}M
PRIORITY=100
`;
      
      await fs.writeFile('/etc/default/zramswap', zramConfig);
      
      // Enable and start zram
      await execAsync('sudo systemctl enable zramswap');
      await execAsync('sudo systemctl start zramswap');
      
      this.logger.info(`Configured ZRAM with ${this.optimizationConfig.zramSizeMB}MB`);
      
    } catch (error) {
      this.logger.error('Failed to setup ZRAM', error as Error);
    }
  }

  private async optimizeNetwork(): Promise<void> {
    try {
      const networkOptimizations = `
# Stream Manager Network Optimizations
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.core.rmem_default = 262144
net.core.wmem_default = 262144
net.core.netdev_max_backlog = 5000
net.ipv4.tcp_rmem = 4096 65536 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216
net.ipv4.tcp_congestion_control = bbr
net.ipv4.tcp_fastopen = 3
net.ipv4.tcp_mtu_probing = 1
`;
      
      await fs.appendFile('/etc/sysctl.conf', networkOptimizations);
      await execAsync('sudo sysctl -p');
      
      this.logger.info('Applied network optimizations');
      
    } catch (error) {
      this.logger.error('Failed to optimize network', error as Error);
    }
  }

  private async enableLowLatencyOptimizations(): Promise<void> {
    try {
      const latencyOptimizations = `
# Stream Manager Low Latency Optimizations
kernel.sched_migration_cost_ns = 5000000
kernel.sched_autogroup_enabled = 0
vm.swappiness = 10
vm.vfs_cache_pressure = 50
vm.dirty_background_ratio = 5
vm.dirty_ratio = 10
`;
      
      await fs.appendFile('/etc/sysctl.conf', latencyOptimizations);
      await execAsync('sudo sysctl -p');
      
      this.logger.info('Applied low latency optimizations');
      
    } catch (error) {
      this.logger.error('Failed to apply low latency optimizations', error as Error);
    }
  }

  private async disableUnusedServices(): Promise<void> {
    const servicesToDisable = [
      'bluetooth',
      'hciuart',
      'avahi-daemon',
      'triggerhappy',
      'dphys-swapfile' // We manage swap ourselves
    ];
    
    for (const service of servicesToDisable) {
      try {
        await execAsync(`sudo systemctl disable ${service}`);
        await execAsync(`sudo systemctl stop ${service}`);
        this.logger.info(`Disabled service: ${service}`);
      } catch (error) {
        // Service might not exist, continue
        this.logger.debug(`Could not disable service ${service}`, error as Error);
      }
    }
  }

  private async optimizeFilesystem(): Promise<void> {
    try {
      // Optimize filesystem mount options
      const fstabOptimizations = `
# Stream Manager Filesystem Optimizations
tmpfs /tmp tmpfs defaults,noatime,nosuid,size=100m 0 0
tmpfs /var/log tmpfs defaults,noatime,nosuid,nodev,noexec,size=100m 0 0
`;
      
      await fs.appendFile('/etc/fstab', fstabOptimizations);
      
      this.logger.info('Applied filesystem optimizations');
      
    } catch (error) {
      this.logger.error('Failed to optimize filesystem', error as Error);
    }
  }

  private async optimizeKernelParameters(): Promise<void> {
    try {
      const kernelOptimizations = `
# Stream Manager Kernel Optimizations
vm.max_map_count = 262144
fs.file-max = 65536
kernel.pid_max = 65536
net.core.somaxconn = 65535
`;
      
      await fs.appendFile('/etc/sysctl.conf', kernelOptimizations);
      await execAsync('sudo sysctl -p');
      
      this.logger.info('Applied kernel parameter optimizations');
      
    } catch (error) {
      this.logger.error('Failed to optimize kernel parameters', error as Error);
    }
  }

  private async optimizeSystemLimits(): Promise<void> {
    try {
      const limitsOptimizations = `
# Stream Manager System Limits
* soft nofile 65536
* hard nofile 65536
* soft nproc 32768
* hard nproc 32768
root soft nofile 65536
root hard nofile 65536
`;
      
      await fs.appendFile('/etc/security/limits.conf', limitsOptimizations);
      
      this.logger.info('Applied system limits optimizations');
      
    } catch (error) {
      this.logger.error('Failed to optimize system limits', error as Error);
    }
  }

  async revertOptimizations(): Promise<void> {
    this.logger.info('Reverting system optimizations');
    
    for (const [configFile, originalContent] of Array.from(this.originalConfigs.entries())) {
      try {
        await fs.writeFile(configFile, originalContent);
        this.logger.info(`Reverted ${configFile}`);
      } catch (error) {
        this.logger.error(`Failed to revert ${configFile}`, error as Error);
      }
    }
  }

  async getOptimizationStatus(): Promise<any> {
    const status = {
      isRaspberryPi: this.isRaspberryPi,
      piModel: this.piModel,
      optimizations: {
        gpuMemory: await this.getGpuMemoryStatus(),
        swap: await this.getSwapStatus(),
        zram: await this.getZramStatus(),
        network: await this.getNetworkStatus(),
        services: await this.getServicesStatus()
      }
    };
    
    return status;
  }

  private async getGpuMemoryStatus(): Promise<any> {
    try {
      const { stdout } = await execAsync('vcgencmd get_mem gpu');
      return { configured: stdout.trim() };
    } catch (error) {
      return { error: 'Could not get GPU memory status' };
    }
  }

  private async getSwapStatus(): Promise<any> {
    try {
      const { stdout } = await execAsync('swapon --show');
      return { active: stdout.trim() };
    } catch (error) {
      return { active: 'No swap configured' };
    }
  }

  private async getZramStatus(): Promise<any> {
    try {
      const { stdout } = await execAsync('zramctl');
      return { active: stdout.trim() };
    } catch (error) {
      return { active: 'ZRAM not configured' };
    }
  }

  private async getNetworkStatus(): Promise<any> {
    try {
      const { stdout } = await execAsync('sysctl net.ipv4.tcp_congestion_control');
      return { congestionControl: stdout.trim() };
    } catch (error) {
      return { error: 'Could not get network status' };
    }
  }

  private async getServicesStatus(): Promise<any> {
    const services = ['bluetooth', 'avahi-daemon', 'triggerhappy'];
    const status: any = {};
    
    for (const service of services) {
      try {
        const { stdout } = await execAsync(`systemctl is-active ${service}`);
        status[service] = stdout.trim();
      } catch (error) {
        status[service] = 'inactive';
      }
    }
    
    return status;
  }

  destroy(): void {
    this.originalConfigs.clear();
    this.logger.info('SystemOptimizer destroyed');
  }
}