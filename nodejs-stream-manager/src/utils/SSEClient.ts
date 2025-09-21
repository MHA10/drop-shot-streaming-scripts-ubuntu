import { Logger } from './Logger';
import { ConfigManager } from './ConfigManager';
import { SSEEvent } from '../types';
import { EventEmitter } from 'events';
import * as http from 'http';
import * as https from 'https';

export class SSEClient extends EventEmitter {
  private logger: Logger;
  private config: any;
  private _isConnected: boolean = false;
  private request: http.ClientRequest | undefined;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectDelay: number = 1000;
  private url: string;
  private headers: Record<string, string>;
  private reconnectTimer: NodeJS.Timeout | undefined;

  constructor(url?: string, headers?: Record<string, string>) {
    super();
    this.logger = Logger.getInstance();
    this.config = ConfigManager.getInstance().get('sse') || {};
    
    this.url = url || this.config.endpoint || 'https://249a01d95654.ngrok-free.app/events';
    this.headers = {
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...headers
    };
    
    this.maxReconnectAttempts = this.config.maxReconnectAttempts || 10;
    this.reconnectDelay = this.config.reconnectDelay || 1000;
  }

  public get isConnected(): boolean {
    return this._isConnected;
  }

  public connect(): void {
    if (this._isConnected) {
      this.logger.warn('SSE client is already connected');
      return;
    }

    this.logger.info(`Connecting to SSE endpoint: ${this.url}`);
    
    try {
      const urlObj = new URL(this.url);
      const isHttps = urlObj.protocol === 'https:';
      const httpModule = isHttps ? https : http;
      
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: this.headers,
        timeout: this.config.timeout || 30000
      };

      this.request = httpModule.request(options, (response) => {
        if (response.statusCode !== 200) {
          this.logger.error(`SSE connection failed with status: ${response.statusCode}`);
          this.handleConnectionError(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        this._isConnected = true;
        this.reconnectAttempts = 0;
        this.logger.info('SSE connection established');
        this.emit('connected');

        response.setEncoding('utf8');
        
        let buffer = '';
        response.on('data', (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          
          for (const line of lines) {
            this.processSSELine(line);
          }
        });

        response.on('end', () => {
          this.logger.info('SSE connection ended by server');
          this.handleDisconnection();
        });

        response.on('error', (error) => {
          this.logger.error('SSE response error', error);
          this.handleConnectionError(error);
        });
      });

      this.request.on('error', (error) => {
        this.logger.error('SSE request error', error);
        this.handleConnectionError(error);
      });

      this.request.on('timeout', () => {
        this.logger.error('SSE connection timeout');
        this.handleConnectionError(new Error('Connection timeout'));
      });

      this.request.end();
      
    } catch (error) {
      this.logger.error('Failed to create SSE connection', error as Error);
      this.handleConnectionError(error as Error);
    }
  }

  public disconnect(): void {
    this.logger.info('Disconnecting SSE client');
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    
    if (this.request) {
      this.request.destroy();
      this.request = undefined;
    }
    
    this._isConnected = false;
    this.reconnectAttempts = 0;
    this.emit('disconnected');
  }

  public send(event: SSEEvent): boolean {
    // Note: SSE is typically unidirectional (server to client)
    // This method is included for interface compatibility but logs a warning
    this.logger.warn('SSE is typically unidirectional. Consider using a different protocol for client-to-server communication.');
    
    // If you need bidirectional communication, you might want to use WebSockets instead
    // For now, we'll emit the event locally for testing purposes
    this.emit('message', event);
    return this._isConnected;
  }

  private processSSELine(line: string): void {
    if (line.startsWith('data: ')) {
      const data = line.substring(6);
      
      if (data.trim() === '') {
        return; // Empty data line
      }
      
      try {
        const rawEventData = JSON.parse(data);
        this.logger.debug('SSE raw event received', rawEventData);
        
        // Transform incoming event format to expected application format
        const transformedEvent = this.transformSSEEvent(rawEventData);
        
        if (transformedEvent) {
          this.logger.debug('SSE event transformed', transformedEvent);
          this.emit('message', transformedEvent);
          this.emit('event', transformedEvent);
        } else {
          this.logger.warn('Failed to transform SSE event', { rawEventData });
        }
      } catch (error) {
        this.logger.warn('Failed to parse SSE event data', { data, error });
        // Emit raw data if JSON parsing fails
        this.emit('message', { type: 'raw', data });
      }
    } else if (line.startsWith('event: ')) {
      const eventType = line.substring(7);
      this.emit('eventType', eventType);
    } else if (line.startsWith('id: ')) {
      const eventId = line.substring(4);
      this.emit('eventId', eventId);
    } else if (line.startsWith('retry: ')) {
      const retryTime = parseInt(line.substring(7), 10);
      if (!isNaN(retryTime)) {
        this.reconnectDelay = retryTime;
        this.logger.debug(`SSE retry time updated to ${retryTime}ms`);
      }
    } else if (line === '') {
      // Empty line indicates end of event
      this.emit('eventEnd');
    }
  }

  private transformSSEEvent(rawEvent: any): any {
    // Handle the incoming format: {eventType, cameraUrl, streamKey}
    // Transform to expected format: {eventType, data: {streamId, rtspUrl, rtmpUrl}}
    
    try {
      if (!rawEvent || typeof rawEvent !== 'object') {
        this.logger.warn('Invalid SSE event: not an object', { rawEvent });
        return null;
      }

      const { eventType, cameraUrl, streamKey } = rawEvent;

      // Validate required fields
      if (!eventType || typeof eventType !== 'string') {
        this.logger.warn('Invalid or missing eventType in SSE event', { rawEvent });
        return null;
      }

      // Validate eventType is one of the expected values
      const validEventTypes = ['start', 'stop', 'restart', 'health', 'config', 'system', 'status'];
      if (!validEventTypes.includes(eventType)) {
        this.logger.warn(`Unknown eventType: ${eventType}`, { rawEvent });
        // Still process it but log the warning
      }

      // For events that require stream data
      if (['start', 'stop', 'restart'].includes(eventType)) {
        if (!cameraUrl || typeof cameraUrl !== 'string' || cameraUrl.trim() === '') {
          this.logger.warn('Invalid or missing cameraUrl for stream event', { rawEvent });
          return null;
        }

        if (!streamKey || typeof streamKey !== 'string' || streamKey.trim() === '') {
          this.logger.warn('Invalid or missing streamKey for stream event', { rawEvent });
          return null;
        }

        // Validate URL format
        try {
          new URL(cameraUrl);
        } catch (urlError) {
          this.logger.warn('Invalid cameraUrl format', { cameraUrl, error: urlError });
          return null;
        }
      }

      // Generate stream ID and construct URLs
      const streamId = this.generateStreamId(cameraUrl || '', streamKey || '');
      const rtmpUrl = `rtmp://localhost:1935/live/${streamKey}`;

      return {
        eventType,
        data: {
          streamId,
          rtspUrl: cameraUrl,
          rtmpUrl,
          timestamp: new Date().toISOString()
        }
      };
    } catch (error) {
      this.logger.error(`Error transforming SSE event: ${JSON.stringify(rawEvent)}`, error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }

  private generateStreamId(rtspUrl: string, streamKey: string): string {
    // Create a unique stream ID from RTSP URL and stream key
    const urlPart = rtspUrl.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 20);
    const keyPart = streamKey.substring(0, 10);
    return `${urlPart}_${keyPart}`;
  }

  private handleConnectionError(error: Error): void {
    this._isConnected = false;
    this.emit('error', error);
    
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.scheduleReconnect();
    } else {
      this.logger.error(`Max reconnection attempts (${this.maxReconnectAttempts}) reached`);
      this.emit('maxReconnectAttemptsReached');
    }
  }

  private handleDisconnection(): void {
    this._isConnected = false;
    this.emit('disconnected');
    
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, Math.min(this.reconnectAttempts - 1, 5)); // Exponential backoff with cap
    
    this.logger.info(`Scheduling reconnection attempt ${this.reconnectAttempts} in ${delay}ms`);
    
    this.reconnectTimer = setTimeout(() => {
      this.logger.info(`Reconnection attempt ${this.reconnectAttempts}`);
      this.connect();
    }, delay);
  }

  public getConnectionInfo(): {
    isConnected: boolean;
    url: string;
    reconnectAttempts: number;
    maxReconnectAttempts: number;
  } {
    return {
      isConnected: this._isConnected,
      url: this.url,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts
    };
  }

  public setMaxReconnectAttempts(attempts: number): void {
    this.maxReconnectAttempts = Math.max(0, attempts);
    this.logger.debug(`Max reconnect attempts set to ${this.maxReconnectAttempts}`);
  }

  public setReconnectDelay(delay: number): void {
    this.reconnectDelay = Math.max(100, delay);
    this.logger.debug(`Reconnect delay set to ${this.reconnectDelay}ms`);
  }

  public resetReconnectAttempts(): void {
    this.reconnectAttempts = 0;
    this.logger.debug('Reconnect attempts reset');
  }
}