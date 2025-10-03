export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  metadata?: Record<string, any>;
}

export interface LogBatch {
  source: string;
  logs: LogEntry[];
}

export interface LogShippingResult {
  success: boolean;
  error?: string;
  retryAfter?: number;
}

export interface BufferedLog {
  entry: LogEntry;
  size: number; // Estimated size in bytes
}

export interface LogBufferStats {
  count: number;
  totalSize: number;
  oldestTimestamp?: string;
  newestTimestamp?: string;
}
