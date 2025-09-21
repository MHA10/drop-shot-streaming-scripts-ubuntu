import { SSEEvent } from '../types';
import { EventEmitter } from 'events';
export declare class SSEClient extends EventEmitter {
    private logger;
    private config;
    private _isConnected;
    private request?;
    private reconnectAttempts;
    private maxReconnectAttempts;
    private reconnectDelay;
    private url;
    private headers;
    private reconnectTimer?;
    constructor(url?: string, headers?: Record<string, string>);
    get isConnected(): boolean;
    connect(): void;
    disconnect(): void;
    send(event: SSEEvent): boolean;
    private processSSELine;
    private handleConnectionError;
    private handleDisconnection;
    private scheduleReconnect;
    getConnectionInfo(): {
        isConnected: boolean;
        url: string;
        reconnectAttempts: number;
        maxReconnectAttempts: number;
    };
    setMaxReconnectAttempts(attempts: number): void;
    setReconnectDelay(delay: number): void;
    resetReconnectAttempts(): void;
}
//# sourceMappingURL=SSEClient.d.ts.map