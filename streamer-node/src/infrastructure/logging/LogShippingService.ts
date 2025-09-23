import { LogEntry, LogBatch, LogShippingResult, LogLevel } from './types/LogTypes';

export class LogShippingService {
  private readonly url: string;
  private readonly sourceId: string;
  private readonly retryAttempts: number;
  private readonly retryDelay: number;
  private readonly errorRetryQueue: LogEntry[] = [];
  private isProcessingErrorQueue = false;

  constructor(
    url: string,
    sourceId: string,
    retryAttempts: number,
    retryDelay: number
  ) {
    this.url = url;
    this.sourceId = sourceId;
    this.retryAttempts = retryAttempts;
    this.retryDelay = retryDelay;
  }

  public async shipLogs(logs: LogEntry[]): Promise<LogShippingResult> {
    if (!this.url) {
      return { success: false, error: 'Remote logging URL not configured' };
    }

    const batch: LogBatch = {
      source: this.sourceId,
      logs
    };

    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(batch)
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage };
    }
  }

  public async shipImmediateLog(log: LogEntry): Promise<void> {
    const isErrorLevel = log.level === 'error' || log.level === 'fatal';
    
    if (isErrorLevel) {
      // For error logs, retry indefinitely
      await this.shipWithInfiniteRetry(log);
    } else {
      // For non-error logs, try once and give up if it fails
      const result = await this.shipLogs([log]);
      if (!result.success) {
        console.warn(`Failed to ship ${log.level} log immediately:`, result.error);
      }
    }
  }

  public async shipBatch(logs: LogEntry[]): Promise<void> {
    const result = await this.shipLogs(logs);
    
    if (!result.success) {
      // Separate error logs for infinite retry
      const errorLogs = logs.filter(log => log.level === 'error' || log.level === 'fatal');
      const nonErrorLogs = logs.filter(log => log.level !== 'error' && log.level !== 'fatal');

      // Add error logs to retry queue
      if (errorLogs.length > 0) {
        this.errorRetryQueue.push(...errorLogs);
        this.processErrorQueue();
      }

      // For non-error logs, try a few times then give up
      if (nonErrorLogs.length > 0) {
        await this.retryBatch(nonErrorLogs, this.retryAttempts);
      }
    }
  }

  private async shipWithInfiniteRetry(log: LogEntry): Promise<void> {
    let attempt = 0;
    
    while (true) {
      attempt++;
      const result = await this.shipLogs([log]);
      
      if (result.success) {
        if (attempt > 1) {
          console.log(`Successfully shipped error log after ${attempt} attempts`);
        }
        return;
      }

      console.error(`Failed to ship error log (attempt ${attempt}):`, result.error);
      
      // Wait before retrying, with exponential backoff (max 60 seconds)
      const delay = Math.min(this.retryDelay * Math.pow(2, Math.min(attempt - 1, 6)), 60000);
      await this.sleep(delay);
    }
  }

  private async retryBatch(logs: LogEntry[], maxAttempts: number): Promise<void> {
    let attempt = 0;
    
    while (attempt < maxAttempts) {
      attempt++;
      await this.sleep(this.retryDelay);
      
      const result = await this.shipLogs(logs);
      if (result.success) {
        console.log(`Successfully shipped batch after ${attempt} attempts`);
        return;
      }
      
      console.warn(`Batch shipping attempt ${attempt}/${maxAttempts} failed:`, result.error);
    }
    
    console.error(`Failed to ship batch after ${maxAttempts} attempts, giving up`);
  }

  private async processErrorQueue(): Promise<void> {
    if (this.isProcessingErrorQueue || this.errorRetryQueue.length === 0) {
      return;
    }

    this.isProcessingErrorQueue = true;

    while (this.errorRetryQueue.length > 0) {
      const log = this.errorRetryQueue.shift()!;
      await this.shipWithInfiniteRetry(log);
    }

    this.isProcessingErrorQueue = false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  public getQueueStats(): { errorQueueSize: number; isProcessingErrors: boolean } {
    return {
      errorQueueSize: this.errorRetryQueue.length,
      isProcessingErrors: this.isProcessingErrorQueue
    };
  }

  public async flushErrorQueue(): Promise<void> {
    if (this.errorRetryQueue.length > 0) {
      await this.processErrorQueue();
    }
  }
}