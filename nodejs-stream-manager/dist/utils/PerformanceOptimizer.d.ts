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
export declare class PerformanceOptimizer {
    private logger;
    private config;
    private optimizationSettings;
    private lastMetrics;
    private gcTimer;
    constructor();
    private loadOptimizationSettings;
    private setupGarbageCollection;
    private forceGarbageCollection;
    getPerformanceMetrics(): Promise<PerformanceMetrics>;
    private getCpuMetrics;
    private getCpuTemperature;
    private getCpuFrequency;
    private getThrottleStatus;
    private getMemoryMetrics;
    private getDiskMetrics;
    private getNetworkMetrics;
    private getProcessMetrics;
    optimizeForCurrentLoad(): Promise<void>;
    private checkMemoryPressure;
    private checkCpuLoad;
    private checkTemperature;
    private optimizeProcesses;
    getOptimizedFFmpegOptions(inputUrl: string, outputUrl: string): string[];
    getSystemRecommendations(): Promise<string[]>;
    destroy(): void;
}
export {};
//# sourceMappingURL=PerformanceOptimizer.d.ts.map