import { Logger } from './Logger';
import { ConfigManager } from './ConfigManager';
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
export declare class SystemOptimizer {
    private logger;
    private config;
    private optimizationConfig;
    private isRaspberryPi;
    private piModel;
    private originalConfigs;
    constructor(logger: Logger, config: ConfigManager);
    initialize(): Promise<void>;
    private detectRaspberryPi;
    private loadOptimizationConfig;
    applyOptimizations(): Promise<void>;
    private backupCurrentConfigs;
    private optimizeGpuMemory;
    private optimizeSwap;
    private setupZram;
    private optimizeNetwork;
    private enableLowLatencyOptimizations;
    private disableUnusedServices;
    private optimizeFilesystem;
    private optimizeKernelParameters;
    private optimizeSystemLimits;
    revertOptimizations(): Promise<void>;
    getOptimizationStatus(): Promise<any>;
    private getGpuMemoryStatus;
    private getSwapStatus;
    private getZramStatus;
    private getNetworkStatus;
    private getServicesStatus;
    destroy(): void;
}
//# sourceMappingURL=SystemOptimizer.d.ts.map