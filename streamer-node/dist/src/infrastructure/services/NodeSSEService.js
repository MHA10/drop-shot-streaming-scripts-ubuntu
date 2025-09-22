"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NodeSSEService = void 0;
const events_1 = require("events");
class NodeSSEService extends events_1.EventEmitter {
    constructor(logger) {
        super();
        this.logger = logger;
        this.isActive = false;
        this.connectionStatus = "disconnected";
        this.retryCount = 0;
    }
    async start(config) {
        this.config = config;
        this.isActive = true;
        this.retryCount = 0;
        this.logger.info("Starting SSE client", { endpoint: config.endpoint });
        await this.connect();
    }
    async stop() {
        this.logger.info("Stopping SSE client");
        this.isActive = false;
        if (this.retryTimeout) {
            clearTimeout(this.retryTimeout);
            this.retryTimeout = undefined;
        }
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = undefined;
        }
        this.connectionStatus = "disconnected";
        this.emitConnectionEvent("disconnected");
    }
    isConnected() {
        return this.connectionStatus === "connected";
    }
    onStreamEvent(callback) {
        this.on("streamEvent", callback);
    }
    onConnectionChange(callback) {
        this.on("connectionChange", callback);
    }
    getConnectionStatus() {
        return this.connectionStatus;
    }
    getRetryCount() {
        return this.retryCount;
    }
    async reconnect() {
        if (!this.config) {
            throw new Error("SSE service not configured");
        }
        this.logger.info("Manual reconnection requested");
        if (this.abortController) {
            this.abortController.abort();
        }
        await this.connect();
    }
    async connect() {
        if (!this.config || !this.isActive) {
            return;
        }
        this.abortController = new AbortController();
        this.connectionStatus = "reconnecting";
        this.emitConnectionEvent("reconnecting");
        try {
            this.logger.info("Connecting to SSE endpoint", {
                endpoint: this.config.endpoint,
                retryCount: this.retryCount,
            });
            const response = await fetch(this.config.endpoint, {
                headers: {
                    Accept: "text/event-stream",
                    "Cache-Control": "no-cache",
                },
                signal: this.abortController.signal,
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            if (!response.body) {
                throw new Error("No response body received");
            }
            this.connectionStatus = "connected";
            this.retryCount = 0;
            this.emitConnectionEvent("connected");
            this.logger.info("SSE connection established");
            // Process the stream
            await this.processEventStream(response.body);
        }
        catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
                this.logger.info("SSE connection aborted");
                return;
            }
            this.logger.error("SSE connection failed", {
                error: error instanceof Error ? error.message : String(error),
                retryCount: this.retryCount,
            });
            this.connectionStatus = "disconnected";
            this.emitConnectionEvent("disconnected");
            // Schedule retry if still active and under retry limit
            if (this.isActive && this.retryCount < this.config.maxRetries) {
                this.scheduleRetry();
            }
            else if (this.retryCount >= this.config.maxRetries) {
                this.logger.error("Max retry attempts reached, stopping SSE client");
                this.isActive = false;
            }
        }
    }
    async processEventStream(body) {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
            while (this.isActive) {
                const { done, value } = await reader.read();
                if (done) {
                    this.logger.info("SSE stream ended");
                    break;
                }
                buffer += decoder.decode(value, { stream: true });
                // Process complete events
                const events = this.parseSSEEvents(buffer);
                for (const event of events.complete) {
                    this.handleSSEEvent(event);
                }
                buffer = events.remaining;
            }
        }
        catch (error) {
            this.logger.error("Error processing SSE stream", {
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
        finally {
            reader.releaseLock();
        }
    }
    parseSSEEvents(buffer) {
        const events = [];
        const lines = buffer.split("\n");
        let currentEvent = "";
        let i = 0;
        while (i < lines.length) {
            const line = lines[i];
            if (line === "") {
                // Empty line indicates end of event
                if (currentEvent.trim()) {
                    events.push(currentEvent.trim());
                    currentEvent = "";
                }
            }
            else {
                currentEvent += line + "\n";
            }
            i++;
        }
        // Return complete events and remaining buffer
        return {
            complete: events,
            remaining: currentEvent,
        };
    }
    handleSSEEvent(eventData) {
        try {
            const lines = eventData.split("\n");
            let data = "";
            let eventType = "";
            for (const line of lines) {
                if (line.startsWith("data: ")) {
                    data = line.substring(6);
                }
                else if (line.startsWith("event: ")) {
                    eventType = line.substring(7);
                }
            }
            if (!data) {
                return;
            }
            this.logger.debug("Received SSE event", { eventType, data });
            // Parse the JSON data
            const parsedData = JSON.parse(data);
            // Validate required fields
            if (!parsedData.cameraUrl ||
                !parsedData.streamKey ||
                !parsedData.eventType) {
                this.logger.warn("Invalid SSE event data", { data: parsedData });
                return;
            }
            // Create stream event
            const streamEvent = {
                eventId: `sse_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                occurredOn: new Date(),
                eventType: "SSEStreamEvent",
                action: parsedData.eventType,
                cameraUrl: parsedData.cameraUrl,
                streamKey: parsedData.streamKey,
                reconciliationMode: parsedData.reconciliation_mode || false,
            };
            this.logger.info("Processing SSE stream event", {
                action: streamEvent.action,
                cameraUrl: streamEvent.cameraUrl,
                streamKey: streamEvent.streamKey,
                reconciliationMode: streamEvent.reconciliationMode,
            });
            this.emit("streamEvent", streamEvent);
        }
        catch (error) {
            this.logger.error("Failed to parse SSE event", {
                error: error instanceof Error ? error.message : String(error),
                eventData,
            });
        }
    }
    scheduleRetry() {
        if (!this.config) {
            return;
        }
        this.retryCount++;
        const delay = Math.min(this.config.retryInterval * Math.pow(2, this.retryCount - 1), 30000 // Max 30 seconds
        );
        this.logger.info("Scheduling SSE reconnection", {
            retryCount: this.retryCount,
            delayMs: delay,
        });
        this.retryTimeout = setTimeout(() => {
            this.connect();
        }, delay);
    }
    emitConnectionEvent(status) {
        const event = {
            eventId: `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            occurredOn: new Date(),
            eventType: "SSEConnectionEvent",
            status,
            retryCount: this.retryCount,
        };
        this.emit("connectionChange", status);
        this.logger.debug("SSE connection status changed", {
            status,
            retryCount: this.retryCount,
        });
    }
}
exports.NodeSSEService = NodeSSEService;
//# sourceMappingURL=NodeSSEService.js.map