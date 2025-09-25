import { SSEStreamEvent } from "../events/StreamEvent";

export interface SSEConnectionConfig {
  readonly groundId: string;
  readonly baseUrl: string;
  readonly retryInterval: number;
  readonly maxRetries: number;
}

export interface SSEService {
  /**
   * Start listening to SSE events
   */
  start(config: SSEConnectionConfig): Promise<void>;

  /**
   * Stop listening to SSE events
   */
  stop(): Promise<void>;

  /**
   * Check if the SSE connection is active
   */
  isConnected(): boolean;

  /**
   * Subscribe to SSE stream events
   */
  onStreamEvent(callback: (event: SSEStreamEvent) => void): void;

  /**
   * Subscribe to connection status changes
   */
  onConnectionChange(
    callback: (status: "connected" | "disconnected" | "reconnecting") => void
  ): void;

  /**
   * Get current connection status
   */
  getConnectionStatus(): "connected" | "disconnected" | "reconnecting";

  /**
   * Get retry count for current connection attempt
   */
  getRetryCount(): number;

  /**
   * Force reconnection
   */
  reconnect(): Promise<void>;
}
