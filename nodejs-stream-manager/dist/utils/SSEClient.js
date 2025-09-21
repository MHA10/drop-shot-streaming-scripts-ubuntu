"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SSEClient = void 0;
const Logger_1 = require("./Logger");
const ConfigManager_1 = require("./ConfigManager");
const events_1 = require("events");
const http = __importStar(require("http"));
const https = __importStar(require("https"));
class SSEClient extends events_1.EventEmitter {
    constructor(url, headers) {
        super();
        this._isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 1000;
        this.logger = Logger_1.Logger.getInstance();
        this.config = ConfigManager_1.ConfigManager.getInstance().get('sse') || {};
        this.url = url || this.config.endpoint || 'https://e50c3c52ed0a.ngrok-free.app/events';
        this.headers = {
            'Accept': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            ...headers
        };
        this.maxReconnectAttempts = this.config.maxReconnectAttempts || 10;
        this.reconnectDelay = this.config.reconnectDelay || 1000;
    }
    get isConnected() {
        return this._isConnected;
    }
    connect() {
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
                response.on('data', (chunk) => {
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
        }
        catch (error) {
            this.logger.error('Failed to create SSE connection', error);
            this.handleConnectionError(error);
        }
    }
    disconnect() {
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
    send(event) {
        this.logger.warn('SSE is typically unidirectional. Consider using a different protocol for client-to-server communication.');
        this.emit('message', event);
        return this._isConnected;
    }
    processSSELine(line) {
        if (line.startsWith('data: ')) {
            const data = line.substring(6);
            if (data.trim() === '') {
                return;
            }
            try {
                const rawEventData = JSON.parse(data);
                this.logger.debug('SSE raw event received', rawEventData);
                const transformedEvent = this.transformSSEEvent(rawEventData);
                if (transformedEvent) {
                    this.logger.debug('SSE event transformed', transformedEvent);
                    this.emit('message', transformedEvent);
                    this.emit('event', transformedEvent);
                }
                else {
                    this.logger.warn('Failed to transform SSE event', { rawEventData });
                }
            }
            catch (error) {
                this.logger.warn('Failed to parse SSE event data', { data, error });
                this.emit('message', { type: 'raw', data });
            }
        }
        else if (line.startsWith('event: ')) {
            const eventType = line.substring(7);
            this.emit('eventType', eventType);
        }
        else if (line.startsWith('id: ')) {
            const eventId = line.substring(4);
            this.emit('eventId', eventId);
        }
        else if (line.startsWith('retry: ')) {
            const retryTime = parseInt(line.substring(7), 10);
            if (!isNaN(retryTime)) {
                this.reconnectDelay = retryTime;
                this.logger.debug(`SSE retry time updated to ${retryTime}ms`);
            }
        }
        else if (line === '') {
            this.emit('eventEnd');
        }
    }
    transformSSEEvent(rawEvent) {
        try {
            if (!rawEvent || typeof rawEvent !== 'object') {
                this.logger.warn('Invalid SSE event: not an object', { rawEvent });
                return null;
            }
            const { eventType, cameraUrl, streamKey } = rawEvent;
            if (!eventType || typeof eventType !== 'string') {
                this.logger.warn('Invalid or missing eventType in SSE event', { rawEvent });
                return null;
            }
            const validEventTypes = ['start', 'stop', 'restart', 'health', 'config', 'system', 'status'];
            if (!validEventTypes.includes(eventType)) {
                this.logger.warn(`Unknown eventType: ${eventType}`, { rawEvent });
            }
            if (['start', 'stop', 'restart'].includes(eventType)) {
                if (!cameraUrl || typeof cameraUrl !== 'string' || cameraUrl.trim() === '') {
                    this.logger.warn('Invalid or missing cameraUrl for stream event', { rawEvent });
                    return null;
                }
                if (!streamKey || typeof streamKey !== 'string' || streamKey.trim() === '') {
                    this.logger.warn('Invalid or missing streamKey for stream event', { rawEvent });
                    return null;
                }
                try {
                    new URL(cameraUrl);
                }
                catch (urlError) {
                    this.logger.warn('Invalid cameraUrl format', { cameraUrl, error: urlError });
                    return null;
                }
            }
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
        }
        catch (error) {
            this.logger.error(`Error transforming SSE event: ${JSON.stringify(rawEvent)}`, error instanceof Error ? error : new Error(String(error)));
            return null;
        }
    }
    generateStreamId(rtspUrl, streamKey) {
        const urlPart = rtspUrl.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 20);
        const keyPart = streamKey.substring(0, 10);
        return `${urlPart}_${keyPart}`;
    }
    handleConnectionError(error) {
        this._isConnected = false;
        this.emit('error', error);
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.scheduleReconnect();
        }
        else {
            this.logger.error(`Max reconnection attempts (${this.maxReconnectAttempts}) reached`);
            this.emit('maxReconnectAttemptsReached');
        }
    }
    handleDisconnection() {
        this._isConnected = false;
        this.emit('disconnected');
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.scheduleReconnect();
        }
    }
    scheduleReconnect() {
        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, Math.min(this.reconnectAttempts - 1, 5));
        this.logger.info(`Scheduling reconnection attempt ${this.reconnectAttempts} in ${delay}ms`);
        this.reconnectTimer = setTimeout(() => {
            this.logger.info(`Reconnection attempt ${this.reconnectAttempts}`);
            this.connect();
        }, delay);
    }
    getConnectionInfo() {
        return {
            isConnected: this._isConnected,
            url: this.url,
            reconnectAttempts: this.reconnectAttempts,
            maxReconnectAttempts: this.maxReconnectAttempts
        };
    }
    setMaxReconnectAttempts(attempts) {
        this.maxReconnectAttempts = Math.max(0, attempts);
        this.logger.debug(`Max reconnect attempts set to ${this.maxReconnectAttempts}`);
    }
    setReconnectDelay(delay) {
        this.reconnectDelay = Math.max(100, delay);
        this.logger.debug(`Reconnect delay set to ${this.reconnectDelay}ms`);
    }
    resetReconnectAttempts() {
        this.reconnectAttempts = 0;
        this.logger.debug('Reconnect attempts reset');
    }
}
exports.SSEClient = SSEClient;
//# sourceMappingURL=SSEClient.js.map