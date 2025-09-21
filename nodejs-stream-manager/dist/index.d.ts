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
    constructor();
    private setupEventHandlers;
    start(): Promise<void>;
    shutdown(): Promise<void>;
    getStatus(): any;
}
export { StreamManagerApp };
//# sourceMappingURL=index.d.ts.map