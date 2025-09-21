export declare class SSEClient {
    private eventSource;
    private logger;
    private config;
    private reconnectAttempts;
    private maxReconnectAttempts;
    private reconnectDelay;
    private isConnected;
    private messageHandlers;
    constructor();
    connect(url?: string): Promise<void>;
    private setupEventListeners;
    private handleMessage;
    private handleStreamStart;
    private handleStreamStop;
    private handleStreamRestart;
    private handleHealthCheck;
    private handleConfigUpdate;
    private handleSystemCommand;
    onMessage(type: string, handler: (data: any) => void): void;
    removeHandler(type: string): void;
    private attemptReconnection;
    sendHeartbeat(): void;
    getConnectionStatus(): {
        connected: boolean;
        reconnectAttempts: number;
        readyState?: number;
    };
    disconnect(): void;
    cleanup(): void;
}
//# sourceMappingURL=SSEClient.d.ts.map