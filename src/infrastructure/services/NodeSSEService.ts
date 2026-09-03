import { EventEmitter } from "events";
import {
  SSEService,
  SSEConnectionConfig,
} from "../../domain/services/SSEService";
import { SSEStreamEvent } from "../../domain/events/StreamEvent";
import { AdSpec } from "../../domain/events/StreamEvent";
import { Logger } from "../../application/interfaces/Logger";

export class NodeSSEService extends EventEmitter implements SSEService {
  private isActive = false;
  private isConnecting = false;
  private connectionStatus: "connected" | "disconnected" | "reconnecting" =
    "disconnected";
  private retryCount = 0;
  private retryTimeout?: NodeJS.Timeout;
  private config?: SSEConnectionConfig;
  private abortController?: AbortController;

  constructor(private readonly logger: Logger) {
    super();
  }

  public async start(config: SSEConnectionConfig): Promise<void> {
    this.config = config;
    this.isActive = true;
    this.retryCount = 0;

    this.logger.info("Starting SSE client", { groundId: config.groundId });
    await this.connect();
  }

  public async stop(): Promise<void> {
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

  public isConnected(): boolean {
    return this.connectionStatus === "connected";
  }

  public onStreamEvent(callback: (event: SSEStreamEvent) => void): void {
    this.on("streamEvent", callback);
  }

  public onConnectionChange(
    callback: (status: "connected" | "disconnected" | "reconnecting") => void
  ): void {
    this.on("connectionChange", callback);
  }

  public getConnectionStatus(): "connected" | "disconnected" | "reconnecting" {
    return this.connectionStatus;
  }

  public getRetryCount(): number {
    return this.retryCount;
  }

  public async reconnect(): Promise<void> {
    if (!this.config) {
      throw new Error("SSE service not configured");
    }

    this.logger.info("Manual reconnection requested");

    if (this.abortController) {
      this.abortController.abort();
    }

    await this.connect();
  }

  private async connect(): Promise<void> {
    if (!this.config || !this.isActive) {
      return;
    }

    // Prevent concurrent connection attempts
    if (this.isConnecting) {
      this.logger.debug("Connection attempt already in progress, skipping");
      return;
    }

    this.isConnecting = true;

    // Abort any existing connection attempt
    if (this.abortController) {
      this.abortController.abort();
    }

    this.abortController = new AbortController();
    this.connectionStatus = "reconnecting";
    this.emitConnectionEvent("reconnecting");

    try {
      this.logger.info("Connecting to SSE endpoint", {
        groundId: this.config.groundId,
        retryCount: this.retryCount,
      });

      // Create timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Connection timeout")), 30000);
      });

      // Race between fetch and timeout
      const response = await Promise.race([
        fetch(
          `${this.config.baseUrl}/api/v1/padel-grounds/${this.config.groundId}/events`,
          {
            headers: {
              Accept: "text/event-stream",
              "Cache-Control": "no-cache",
              // Server-to-server auth; only sent when configured.
              ...(this.config.streamingApiKey
                ? { "x-streaming-api-key": this.config.streamingApiKey }
                : {}),
            },
            signal: this.abortController.signal,
          }
        ),
        timeoutPromise,
      ]);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error("No response body received");
      }

      this.connectionStatus = "connected";
      this.retryCount = 0;
      this.isConnecting = false;
      this.emitConnectionEvent("connected");

      this.logger.info("SSE connection established");

      // Process the stream
      await this.processEventStream(response.body);
    } catch (error) {
      this.isConnecting = false;

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

      // Schedule retry if still active (infinite retries)
      if (this.isActive) {
        this.scheduleRetry();
      }
    }
  }

  private async processEventStream(
    body: ReadableStream<Uint8Array>
  ): Promise<void> {
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
    } catch (error) {
      this.logger.error("Error processing SSE stream", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  private parseSSEEvents(buffer: string): {
    complete: string[];
    remaining: string;
  } {
    // SSE events are separated by a blank line. Split on the event boundary and
    // keep the trailing partial event (everything after the last separator) in
    // `remaining`, so an event whose `data:` line is split across network chunks
    // is reassembled on the next read rather than corrupted by a stray newline.
    const normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const segments = normalized.split("\n\n");
    const remaining = segments.pop() ?? "";
    const complete = segments
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);

    return { complete, remaining };
  }

  private handleSSEEvent(eventData: string): void {
    try {
      const lines = eventData.split("\n");
      let data = "";
      let eventType = "";

      // Per the SSE spec a field may omit the space after the colon, and an event
      // may carry multiple `data:` lines that are joined with newlines.
      for (const line of lines) {
        if (line.startsWith("data:")) {
          const chunk = line.startsWith("data: ")
            ? line.substring(6)
            : line.substring(5);
          data = data ? `${data}\n${chunk}` : chunk;
        } else if (line.startsWith("event:")) {
          eventType = (line.startsWith("event: ")
            ? line.substring(7)
            : line.substring(6)
          ).trim();
        }
      }

      if (!data) {
        return;
      }

      this.logger.debug("Received SSE event", { eventType, data });

      // Parse the JSON data
      const parsedData = JSON.parse(data);

      // Validate required fields
      if (
        !parsedData.cameraUrl ||
        !parsedData.streamKey ||
        !parsedData.eventType ||
        !parsedData.courtId
      ) {
        this.logger.warn("Invalid SSE event data", { data: parsedData });
        return;
      }

      // Create stream event
      const streamEvent: SSEStreamEvent = {
        eventId: `sse_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        occurredOn: new Date(),
        eventType: "SSEStreamEvent",
        action: parsedData.eventType,
        cameraUrl: parsedData.cameraUrl,
        streamKey: parsedData.streamKey,
        courtId: parsedData.courtId,
        reconciliationMode: parsedData.reconciliation_mode || false,
        isScorecardActivated: parsedData.isScorecardActivated,
        ads: this.parseAds(parsedData.ads),
      };

      this.logger.info("Processing SSE stream event", {
        action: streamEvent.action,
        cameraUrl: streamEvent.cameraUrl,
        streamKey: streamEvent.streamKey,
        reconciliationMode: streamEvent.reconciliationMode,
        isScorecardActivated: streamEvent.isScorecardActivated,
        ads: streamEvent.ads,
      });

      this.emit("streamEvent", streamEvent);
    } catch (error) {
      this.logger.error("Failed to parse SSE event", {
        error: error instanceof Error ? error.message : String(error),
        eventData,
      });
    }
  }

  /**
   * Normalize the `ads` field from an SSE payload into an AdSpec[].
   *
   * Accepts the new rolling-pool shape (array of { url, duration } or bare URL
   * strings) and the legacy static shape ({ left, right }) for backward
   * compatibility during rollout. Returns undefined when no ads are present.
   */
  private parseAds(raw: unknown): AdSpec[] | undefined {
    if (!raw) return undefined;

    const toSpec = (entry: unknown): AdSpec | null => {
      if (typeof entry === "string") {
        return entry.trim() ? { url: entry } : null;
      }
      if (entry && typeof entry === "object") {
        // The backend sends each ad as { link, duration }; accept `url` too for
        // our own docs/tests. duration may be null → falls back to the default.
        const obj = entry as { url?: unknown; link?: unknown; duration?: unknown };
        const rawUrl =
          typeof obj.url === "string" && obj.url.trim()
            ? obj.url
            : typeof obj.link === "string" && obj.link.trim()
              ? obj.link
              : null;
        if (rawUrl) {
          const duration =
            typeof obj.duration === "number" && isFinite(obj.duration)
              ? obj.duration
              : undefined;
          return { url: rawUrl, durationSec: duration };
        }
      }
      return null;
    };

    // Normalize both shapes to an entries array, then run the shared pipeline once.
    // New shape: array of { url, duration } objects or bare URL strings.
    // Legacy shape: { left, right } static slot object (backward compat during rollout).
    const entries: unknown[] = Array.isArray(raw)
      ? raw
      : typeof raw === "object" && raw !== null
        ? [(raw as { left?: unknown }).left, (raw as { right?: unknown }).right]
        : [];

    const specs = entries.map(toSpec).filter((s): s is AdSpec => s !== null);
    return specs.length > 0 ? specs : undefined;
  }

  private scheduleRetry(): void {
    if (!this.config) {
      return;
    }

    // Don't schedule retry if already connecting
    if (this.isConnecting) {
      this.logger.debug(
        "Connection attempt in progress, skipping retry schedule"
      );
      return;
    }

    this.retryCount++;
    // Cap retry count at 10 for exponential backoff calculation to prevent overflow
    const effectiveRetryCount = Math.min(this.retryCount, 10);
    const delay = Math.min(
      this.config.retryInterval * Math.pow(2, effectiveRetryCount - 1),
      30000 // Max 30 seconds
    );

    this.logger.info("Scheduling SSE reconnection", {
      retryCount: this.retryCount,
      delayMs: delay,
    });

    this.retryTimeout = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private emitConnectionEvent(
    status: "connected" | "disconnected" | "reconnecting"
  ): void {
    this.emit("connectionChange", status);
    this.logger.debug("SSE connection status changed", {
      status,
      retryCount: this.retryCount,
    });
  }
}
