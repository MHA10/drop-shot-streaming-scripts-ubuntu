import { EventEmitter } from "events";
import { SSEService, SSEConnectionConfig } from "../../domain/services/SSEService";
import { SSEStreamEvent } from "../../domain/events/StreamEvent";
import { Logger } from "../../application/interfaces/Logger";
export declare class NodeSSEService extends EventEmitter implements SSEService {
    private readonly logger;
    private isActive;
    private connectionStatus;
    private retryCount;
    private retryTimeout?;
    private config?;
    private abortController?;
    constructor(logger: Logger);
    start(config: SSEConnectionConfig): Promise<void>;
    stop(): Promise<void>;
    isConnected(): boolean;
    onStreamEvent(callback: (event: SSEStreamEvent) => void): void;
    onConnectionChange(callback: (status: "connected" | "disconnected" | "reconnecting") => void): void;
    getConnectionStatus(): "connected" | "disconnected" | "reconnecting";
    getRetryCount(): number;
    reconnect(): Promise<void>;
    private connect;
    private processEventStream;
    private parseSSEEvents;
    private handleSSEEvent;
    private scheduleRetry;
    private emitConnectionEvent;
}
//# sourceMappingURL=NodeSSEService.d.ts.map