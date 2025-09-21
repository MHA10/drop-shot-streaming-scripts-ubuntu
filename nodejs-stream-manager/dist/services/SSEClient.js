"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SSEClient = void 0;
const eventsource_1 = __importDefault(require("eventsource"));
const Logger_1 = require("../utils/Logger");
const ConfigManager_1 = require("../utils/ConfigManager");
class SSEClient {
    constructor() {
        this.eventSource = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
        this.reconnectDelay = 1000;
        this.isConnected = false;
        this.messageHandlers = new Map();
        this.logger = Logger_1.Logger.getInstance();
        this.config = ConfigManager_1.ConfigManager.getInstance().getConfig();
    }
    connect(url) {
        return new Promise((resolve, reject) => {
            try {
                const sseUrl = url || this.config.server.sseUrl;
                if (!sseUrl) {
                    throw new Error('SSE URL not configured');
                }
                this.logger.info('Connecting to SSE server', { url: sseUrl });
                this.eventSource = new eventsource_1.default(sseUrl, {
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
                    this.logger.error('SSE connection error', error);
                    this.isConnected = false;
                    if (this.reconnectAttempts === 0) {
                        reject(new Error('Failed to establish SSE connection'));
                    }
                    else {
                        this.attemptReconnection();
                    }
                };
                this.setupEventListeners();
            }
            catch (error) {
                this.logger.error('Failed to create SSE connection', error);
                reject(error);
            }
        });
    }
    setupEventListeners() {
        if (!this.eventSource)
            return;
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
    handleMessage(event) {
        try {
            const message = JSON.parse(event.data);
            this.logger.debug('Received SSE message', {
                type: message.type,
                timestamp: message.timestamp
            });
            const handler = this.messageHandlers.get(message.type);
            if (handler) {
                handler(message.data);
            }
        }
        catch (error) {
            this.logger.error('Failed to parse SSE message', error, {
                data: event.data
            });
        }
    }
    handleStreamStart(event) {
        try {
            const streamConfig = JSON.parse(event.data);
            this.logger.info('Received stream start command', { streamId: streamConfig.id });
            const handler = this.messageHandlers.get('stream-start');
            if (handler) {
                handler(streamConfig);
            }
        }
        catch (error) {
            this.logger.error('Failed to handle stream start', error);
        }
    }
    handleStreamStop(event) {
        try {
            const { streamId } = JSON.parse(event.data);
            this.logger.info('Received stream stop command', { streamId });
            const handler = this.messageHandlers.get('stream-stop');
            if (handler) {
                handler({ streamId });
            }
        }
        catch (error) {
            this.logger.error('Failed to handle stream stop', error);
        }
    }
    handleStreamRestart(event) {
        try {
            const { streamId } = JSON.parse(event.data);
            this.logger.info('Received stream restart command', { streamId });
            const handler = this.messageHandlers.get('stream-restart');
            if (handler) {
                handler({ streamId });
            }
        }
        catch (error) {
            this.logger.error('Failed to handle stream restart', error);
        }
    }
    handleHealthCheck(event) {
        try {
            this.logger.debug('Received health check request');
            const handler = this.messageHandlers.get('health-check');
            if (handler) {
                handler({});
            }
        }
        catch (error) {
            this.logger.error('Failed to handle health check', error);
        }
    }
    handleConfigUpdate(event) {
        try {
            const configUpdate = JSON.parse(event.data);
            this.logger.info('Received config update', { keys: Object.keys(configUpdate) });
            const handler = this.messageHandlers.get('config-update');
            if (handler) {
                handler(configUpdate);
            }
        }
        catch (error) {
            this.logger.error('Failed to handle config update', error);
        }
    }
    handleSystemCommand(event) {
        try {
            const { command, args } = JSON.parse(event.data);
            this.logger.info('Received system command', { command, args });
            const handler = this.messageHandlers.get('system-command');
            if (handler) {
                handler({ command, args });
            }
        }
        catch (error) {
            this.logger.error('Failed to handle system command', error);
        }
    }
    onMessage(type, handler) {
        this.messageHandlers.set(type, handler);
        this.logger.debug('Registered message handler', { type });
    }
    removeHandler(type) {
        this.messageHandlers.delete(type);
        this.logger.debug('Removed message handler', { type });
    }
    attemptReconnection() {
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
                this.logger.error('Reconnection failed', error);
                this.reconnectDelay = Math.min(this.reconnectDelay * 2 + Math.random() * 1000, 30000);
                this.attemptReconnection();
            });
        }, this.reconnectDelay);
    }
    sendHeartbeat() {
        if (!this.isConnected) {
            this.logger.debug('Cannot send heartbeat - not connected');
            return;
        }
        this.logger.debug('SSE heartbeat check', {
            connected: this.isConnected,
            reconnectAttempts: this.reconnectAttempts
        });
    }
    getConnectionStatus() {
        return {
            connected: this.isConnected,
            reconnectAttempts: this.reconnectAttempts,
            readyState: this.eventSource?.readyState
        };
    }
    disconnect() {
        if (this.eventSource) {
            this.logger.info('Disconnecting from SSE server');
            this.eventSource.close();
            this.eventSource = null;
            this.isConnected = false;
        }
    }
    cleanup() {
        this.logger.info('Cleaning up SSE client');
        this.disconnect();
        this.messageHandlers.clear();
    }
}
exports.SSEClient = SSEClient;
//# sourceMappingURL=SSEClient.js.map