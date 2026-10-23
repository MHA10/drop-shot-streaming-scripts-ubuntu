import { Logger } from "../../application/interfaces/Logger";
import { ConsoleLogger } from "./ConsoleLogger";
import { LogBuffer } from "./LogBuffer";
import { LogShippingService } from "./LogShippingService";
import { LogEntry, LogLevel } from "./types/LogTypes";
import { redactLog } from "../utils/redact";

export class RemoteLogger implements Logger {
  private readonly consoleLogger: ConsoleLogger;
  private readonly logBuffer?: LogBuffer;
  private readonly shippingService?: LogShippingService;
  private readonly enabled: boolean;

  constructor(
    remoteConfig: {
      enabled: boolean;
      baseUrl: string;
      sourceId: string;
      batchSize: number;
      batchInterval: number;
      maxMemoryUsage: number;
      retryAttempts: number;
      retryDelay: number;
      streamingApiKey?: string;
    },
    logLevel: string = "debug"
  ) {
    // Always create console logger for local logging
    this.consoleLogger = new ConsoleLogger(logLevel);
    this.enabled = remoteConfig.enabled;

    if (this.enabled && remoteConfig.baseUrl) {
      // Initialize shipping service
      this.shippingService = new LogShippingService(
        remoteConfig.baseUrl,
        remoteConfig.sourceId,
        remoteConfig.retryAttempts,
        remoteConfig.retryDelay,
        remoteConfig.streamingApiKey ?? ""
      );

      // Initialize log buffer for non-error logs
      this.logBuffer = new LogBuffer(
        remoteConfig.maxMemoryUsage,
        remoteConfig.batchSize,
        remoteConfig.batchInterval,
        this.handleBatchFlush.bind(this)
      );
    }
  }

  public info(rawMessage: string, rawMeta?: any): void {
    // Camera passwords and stream keys never reach the console or the log server.
    const { message, meta } = redactLog(rawMessage, rawMeta);
    // Always log to console
    this.consoleLogger.info(message, meta);

    // Ship to remote if enabled
    if (this.enabled && this.logBuffer) {
      const logEntry = this.createLogEntry("info", message, meta);
      this.logBuffer.add(logEntry);
    }
  }

  public warn(rawMessage: string, rawMeta?: any): void {
    const { message, meta } = redactLog(rawMessage, rawMeta);
    // Always log to console
    this.consoleLogger.warn(message, meta);

    // Ship to remote if enabled
    if (this.enabled && this.logBuffer) {
      const logEntry = this.createLogEntry("warn", message, meta);
      this.logBuffer.add(logEntry);
    }
  }

  public error(rawMessage: string, rawMeta?: any): void {
    const { message, meta } = redactLog(rawMessage, rawMeta);
    // Always log to console
    this.consoleLogger.error(message, meta);

    // Ship error logs immediately if enabled
    if (this.enabled && this.shippingService) {
      const logEntry = this.createLogEntry("error", message, meta);
      this.shippingService.shipImmediateLog(logEntry).catch((error: any) => {
        // Fallback to console if remote shipping fails
        console.error("Failed to ship error log remotely:", error);
      });
    }
  }

  public debug(rawMessage: string, rawMeta?: any): void {
    // Debug isn't shipped; skip the cleaning work when it won't be printed either.
    if (!this.consoleLogger.shouldLog("debug")) return;
    const { message, meta } = redactLog(rawMessage, rawMeta);
    // Always log to console
    this.consoleLogger.debug(message, meta);

    // Ship to remote if enabled
    // if (this.enabled && this.logBuffer) {
    //   const logEntry = this.createLogEntry("debug", message, meta);
    //   this.logBuffer.add(logEntry);
    // }
  }

  private createLogEntry(
    level: LogLevel,
    message: string,
    meta?: any
  ): LogEntry {
    return {
      level,
      message,
      timestamp: new Date().toISOString(),
      metadata: meta,
    };
  }

  private async handleBatchFlush(logs: LogEntry[]): Promise<void> {
    if (!this.shippingService) {
      return;
    }

    try {
      const result = await this.shippingService.shipLogs(logs);
      if (!result.success) {
        console.error("Failed to ship log batch:", result.error);
      }
    } catch (error) {
      console.error("Error during batch log shipping:", error);
    }
  }

  /**
   * Gracefully shutdown the remote logger
   * Flushes any pending logs and cleans up resources
   */
  public async shutdown(): Promise<void> {
    if (!this.enabled) {
      return;
    }

    try {
      // Flush any remaining buffered logs
      if (this.logBuffer) {
        await this.logBuffer.flush();
        this.logBuffer.destroy();
      }

      // Flush any remaining error logs
      if (this.shippingService) {
        await this.shippingService.flushErrorQueue();
      }
    } catch (error) {
      console.error("Error during RemoteLogger shutdown:", error);
    }
  }

  /**
   * Get statistics about the remote logging system
   */
  public getStats(): {
    enabled: boolean;
    bufferStats?: any;
    shippingStats?: any;
  } {
    const stats: any = { enabled: this.enabled };

    if (this.enabled) {
      if (this.logBuffer) {
        stats.bufferStats = this.logBuffer.getStats();
      }
      if (this.shippingService) {
        stats.shippingStats = this.shippingService.getQueueStats();
      }
    }

    return stats;
  }
}
