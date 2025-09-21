import { Logger } from './Logger';
import { HealthStatus } from '../types';
export declare class HealthMonitor {
    private logger;
    private isRunning;
    private checkInterval;
    private intervalId?;
    private lastHealthCheck;
    constructor(logger: Logger);
    start(): void;
    stop(): void;
    getHealthStatus(): HealthStatus;
    private performHealthCheck;
    private getSystemMetrics;
    private getCpuUsage;
    private getMemoryInfo;
    private getDiskInfo;
    private getNetworkInfo;
    private getCpuTemperature;
    setCheckInterval(intervalMs: number): void;
}
//# sourceMappingURL=HealthMonitor.d.ts.map