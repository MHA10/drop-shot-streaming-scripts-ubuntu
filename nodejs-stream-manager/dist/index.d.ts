#!/usr/bin/env node
declare class StreamManagerApp {
    private logger;
    private config;
    private streamManager;
    private sseClient;
    private healthMonitor;
    private performanceOptimizer;
    private resourceMonitor;
    private systemOptimizer;
    private isShuttingDown;
    constructor();
    start(): Promise<void>;
    private setupSSEClient;
    private setupResourceMonitoring;
    private handleCriticalMemory;
    private handleCriticalCpu;
    private handleCriticalTemperature;
    private handleCriticalDisk;
    private recoverStreams;
    private detectBootRecovery;
    private restartAllStreams;
    private stopAllStreams;
    private setupSignalHandlers;
    private shutdown;
    private sleep;
}
export { StreamManagerApp };
//# sourceMappingURL=index.d.ts.map