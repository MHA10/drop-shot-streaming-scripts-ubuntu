import { StreamManager } from '../core/StreamManager';
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
export declare class HealthMonitor {
    private streamManager;
    private logger;
    private config;
    private monitoringInterval;
    private isMonitoring;
    constructor(streamManager: StreamManager);
    startMonitoring(): void;
    stopMonitoring(): void;
    private performHealthCheck;
    getSystemHealth(): Promise<SystemHealth>;
    private getCpuInfo;
    private getMemoryInfo;
    private getDiskInfo;
    private parseSize;
    private getNetworkInfo;
    private getProcessInfo;
    private checkCriticalConditions;
    private logHealthSummary;
    getDetailedReport(): Promise<{
        system: SystemHealth;
        streams: ReturnType<StreamManager['getSystemStats']>;
        timestamp: number;
    }>;
    isHealthy(): boolean;
    cleanup(): void;
}
//# sourceMappingURL=HealthMonitor.d.ts.map