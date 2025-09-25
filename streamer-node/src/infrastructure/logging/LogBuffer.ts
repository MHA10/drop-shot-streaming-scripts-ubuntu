import { LogEntry, BufferedLog, LogBufferStats } from "./types/LogTypes";

export class LogBuffer {
  private buffer: BufferedLog[] = [];
  private totalSize: number = 0;
  private readonly maxSize: number;
  private readonly maxCount: number;
  private flushTimer?: NodeJS.Timeout;
  private readonly flushInterval: number;
  private readonly onFlush: (logs: LogEntry[]) => Promise<void>;

  constructor(
    maxSize: number,
    maxCount: number,
    flushInterval: number,
    onFlush: (logs: LogEntry[]) => Promise<void>
  ) {
    this.maxSize = maxSize;
    this.maxCount = maxCount;
    this.flushInterval = flushInterval;
    this.onFlush = onFlush;
    this.startFlushTimer();
  }

  public add(entry: LogEntry): void {
    const estimatedSize = this.estimateLogSize(entry);
    const bufferedLog: BufferedLog = {
      entry,
      size: estimatedSize,
    };

    this.buffer.push(bufferedLog);
    this.totalSize += estimatedSize;

    // Check if we need to flush early due to size or count limits
    if (this.shouldFlushEarly()) {
      this.flush();
    }
  }

  public async flush(): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }

    const logsToFlush = this.buffer.map((bufferedLog) => bufferedLog.entry);
    this.buffer = [];
    this.totalSize = 0;

    try {
      await this.onFlush(logsToFlush);
    } catch (error) {
      // If flush fails, we don't re-add logs to avoid infinite loops
      // The shipping service should handle retries
      console.error("Failed to flush log buffer:", error);
    }

    // Restart the timer after flush
    this.restartFlushTimer();
  }

  public getStats(): LogBufferStats {
    const timestamps = this.buffer.map((log) => log.entry.timestamp);
    return {
      count: this.buffer.length,
      totalSize: this.totalSize,
      oldestTimestamp: timestamps.length > 0 ? timestamps[0] : undefined,
      newestTimestamp:
        timestamps.length > 0 ? timestamps[timestamps.length - 1] : undefined,
    };
  }

  public destroy(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    // Flush any remaining logs before destroying
    if (this.buffer.length > 0) {
      this.flush().catch((error) => {
        console.error("Failed to flush logs during buffer destruction:", error);
      });
    }
  }

  private shouldFlushEarly(): boolean {
    return (
      this.totalSize >= this.maxSize || this.buffer.length >= this.maxCount
    );
  }

  private estimateLogSize(entry: LogEntry): number {
    // Rough estimation of JSON size in bytes
    const baseSize = JSON.stringify({
      level: entry.level,
      message: entry.message,
      timestamp: entry.timestamp,
    }).length;

    const metadataSize = entry.metadata
      ? JSON.stringify(entry.metadata).length
      : 0;

    // Add some overhead for JSON formatting
    return baseSize + metadataSize + 50;
  }

  private startFlushTimer(): void {
    this.flushTimer = setTimeout(() => {
      this.flush();
    }, this.flushInterval);
  }

  private restartFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    this.startFlushTimer();
  }
}
