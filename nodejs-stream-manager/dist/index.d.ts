#!/usr/bin/env node
declare class StreamManagerApp {
    private logger;
    private config;
    private streamManager;
    private healthMonitor;
    private performanceOptimizer;
    private resourceMonitor;
    private sseClient;
    private systemOptimizer;
    private isShuttingDown;
    private processedEvents;
    private eventCacheCleanupInterval;
    constructor();
    private setupEventHandlers;
    start(): Promise<void>;
    shutdown(): Promise<void>;
    private generateEventHash;
    private startEventCacheCleanup;
    private stopEventCacheCleanup;
    getStatus(): any;
}
export { StreamManagerApp };
//# sourceMappingURL=index.d.ts.map