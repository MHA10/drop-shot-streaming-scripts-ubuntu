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
export declare class ResourceMonitor extends EventEmitter {
    private logger;
    private config;
    private performanceOptimizer;
    private thresholds;
    private monitoringInterval;
    private alertHistory;
    private maxAlertHistory;
    private isMonitoring;
    constructor();
    private loadThresholds;
    startMonitoring(intervalMs?: number): void;
    stopMonitoring(): void;
    private performResourceCheck;
    private checkMemoryUsage;
    private checkCpuUsage;
    private checkTemperature;
    private checkDiskUsage;
    private checkProcessCount;
    private createAlert;
    private handleCriticalAlert;
    private handleCriticalMemory;
    private handleCriticalCpu;
    private handleCriticalTemperature;
    private handleCriticalDisk;
    getAlertHistory(limit?: number): ResourceAlert[];
    getRecentAlerts(minutes?: number): ResourceAlert[];
    getCriticalAlerts(): ResourceAlert[];
    getSystemHealth(): {
        status: 'healthy' | 'warning' | 'critical';
        alerts: ResourceAlert[];
        recommendations: string[];
    };
    updateThresholds(newThresholds: Partial<ResourceThresholds>): void;
    isMonitoringActive(): boolean;
    destroy(): void;
}
export {};
//# sourceMappingURL=ResourceMonitor.d.ts.map