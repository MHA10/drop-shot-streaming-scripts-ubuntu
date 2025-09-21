import EventSource from 'eventsource';
import { SSEMessage, StreamConfig } from '../types';
import { Logger } from '../utils/Logger';
import { ConfigManager } from '../utils/ConfigManager';

export class SSEClient {
  private eventSource: EventSource | null = null;
  private logger: Logger;
  private config: ReturnType<ConfigManager['getConfig']>;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000; // Start with 1 second
  private isConnected = false;
  private messageHandlers: Map<string, (data: any) => void> = new Map();

  constructor() {
    this.logger = Logger.getInstance();
    this.config = ConfigManager.getInstance().getConfig();
  }

  public connect(url?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const sseUrl = url || this.config.server.sseUrl;
        
        if (!sseUrl) {
          throw new Error('SSE URL not configured');
        }

        this.logger.info('Connecting to SSE server', { url: sseUrl });

        this.eventSource = new EventSource(sseUrl, {
          headers: {
            'Accept': 'text/event-stream',
            'Cache-Control': 'no-cache'
          }
        });

        this.eventSource.onopen = () => {
          this.logger.info('SSE connection established');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.reconnectDelay = 1000;
          resolve();
        };

        this.eventSource.onmessage = (event) => {
          this.handleMessage(event);
        };

        this.eventSource.onerror = (error) => {
          this.logger.error('SSE connection error', error as Error);
          this.isConnected = false;
          
          if (this.reconnectAttempts === 0) {
            // First error, reject the promise
            reject(new Error('Failed to establish SSE connection'));
          } else {
            // Subsequent errors, attempt reconnection
            this.attemptReconnection();
          }
        };

        // Set up custom event listeners
        this.setupEventListeners();

      } catch (error) {
        this.logger.error('Failed to create SSE connection', error as Error);
        reject(error);
      }
    });
  }

  private setupEventListeners(): void {
    if (!this.eventSource) return;

    // Listen for stream control messages
    this.eventSource.addEventListener('stream-start', (event) => {
      this.handleStreamStart(event);
    });

    this.eventSource.addEventListener('stream-stop', (event) => {
      this.handleStreamStop(event);
    });

    this.eventSource.addEventListener('stream-restart', (event) => {
      this.handleStreamRestart(event);
    });

    this.eventSource.addEventListener('health-check', (event) => {
      this.handleHealthCheck(event);
    });

    this.eventSource.addEventListener('config-update', (event) => {
      this.handleConfigUpdate(event);
    });

    this.eventSource.addEventListener('system-command', (event) => {
      this.handleSystemCommand(event);
    });
  }

  private handleMessage(event: MessageEvent): void {
    try {
      const message: SSEMessage = JSON.parse(event.data);
      
      this.logger.debug('Received SSE message', { 
        type: message.type,
        timestamp: message.timestamp 
      });

      // Call registered handlers
      const handler = this.messageHandlers.get(message.type);
      if (handler) {
        handler(message.data);
      }

    } catch (error) {
      this.logger.error('Failed to parse SSE message', error as Error, {
        data: event.data
      });
    }
  }

  private handleStreamStart(event: MessageEvent): void {
    try {
      const streamConfig: StreamConfig = JSON.parse(event.data);
      this.logger.info('Received stream start command', { streamId: streamConfig.id });
      
      const handler = this.messageHandlers.get('stream-start');
      if (handler) {
        handler(streamConfig);
      }
    } catch (error) {
      this.logger.error('Failed to handle stream start', error as Error);
    }
  }

  private handleStreamStop(event: MessageEvent): void {
    try {
      const { streamId } = JSON.parse(event.data);
      this.logger.info('Received stream stop command', { streamId });
      
      const handler = this.messageHandlers.get('stream-stop');
      if (handler) {
        handler({ streamId });
      }
    } catch (error) {
      this.logger.error('Failed to handle stream stop', error as Error);
    }
  }

  private handleStreamRestart(event: MessageEvent): void {
    try {
      const { streamId } = JSON.parse(event.data);
      this.logger.info('Received stream restart command', { streamId });
      
      const handler = this.messageHandlers.get('stream-restart');
      if (handler) {
        handler({ streamId });
      }
    } catch (error) {
      this.logger.error('Failed to handle stream restart', error as Error);
    }
  }

  private handleHealthCheck(event: MessageEvent): void {
    try {
      this.logger.debug('Received health check request');
      
      const handler = this.messageHandlers.get('health-check');
      if (handler) {
        handler({});
      }
    } catch (error) {
      this.logger.error('Failed to handle health check', error as Error);
    }
  }

  private handleConfigUpdate(event: MessageEvent): void {
    try {
      const configUpdate = JSON.parse(event.data);
      this.logger.info('Received config update', { keys: Object.keys(configUpdate) });
      
      const handler = this.messageHandlers.get('config-update');
      if (handler) {
        handler(configUpdate);
      }
    } catch (error) {
      this.logger.error('Failed to handle config update', error as Error);
    }
  }

  private handleSystemCommand(event: MessageEvent): void {
    try {
      const { command, args } = JSON.parse(event.data);
      this.logger.info('Received system command', { command, args });
      
      const handler = this.messageHandlers.get('system-command');
      if (handler) {
        handler({ command, args });
      }
    } catch (error) {
      this.logger.error('Failed to handle system command', error as Error);
    }
  }

  public onMessage(type: string, handler: (data: any) => void): void {
    this.messageHandlers.set(type, handler);
    this.logger.debug('Registered message handler', { type });
  }

  public removeHandler(type: string): void {
    this.messageHandlers.delete(type);
    this.logger.debug('Removed message handler', { type });
  }

  private attemptReconnection(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error('Max reconnection attempts reached, giving up');
      return;
    }

    this.reconnectAttempts++;
    
    this.logger.info('Attempting SSE reconnection', {
      attempt: this.reconnectAttempts,
      maxAttempts: this.maxReconnectAttempts,
      delay: this.reconnectDelay
    });

    setTimeout(() => {
      this.disconnect();
      this.connect().catch((error) => {
        this.logger.error('Reconnection failed', error as Error);
        
        // Exponential backoff with jitter
        this.reconnectDelay = Math.min(
          this.reconnectDelay * 2 + Math.random() * 1000,
          30000 // Max 30 seconds
        );
        
        this.attemptReconnection();
      });
    }, this.reconnectDelay);
  }

  public sendHeartbeat(): void {
    if (!this.isConnected) {
      this.logger.debug('Cannot send heartbeat - not connected');
      return;
    }

    // SSE is unidirectional, but we can log heartbeat for monitoring
    this.logger.debug('SSE heartbeat check', { 
      connected: this.isConnected,
      reconnectAttempts: this.reconnectAttempts 
    });
  }

  public getConnectionStatus(): {
    connected: boolean;
    reconnectAttempts: number;
    readyState?: number;
  } {
    return {
      connected: this.isConnected,
      reconnectAttempts: this.reconnectAttempts,
      readyState: this.eventSource?.readyState
    };
  }

  public disconnect(): void {
    if (this.eventSource) {
      this.logger.info('Disconnecting from SSE server');
      this.eventSource.close();
      this.eventSource = null;
      this.isConnected = false;
    }
  }

  public cleanup(): void {
    this.logger.info('Cleaning up SSE client');
    this.disconnect();
    this.messageHandlers.clear();
  }
}