// Server Configuration
export interface ServerConfig {
  sseUrl: string;
  reconnectInterval: number;
  healthCheckInterval: number;
  port?: number;
}

// Streaming Configuration
export interface StreamingConfig {
  maxRetries: number;
  retryBackoffMs: number;
  processTimeoutMs: number;
  rtspTransport?: string;
  videoParams: {
    codec: string;
    preset: string;
    bitrate: string;
    maxrate: string;
    bufsize: string;
    scale: string;
  };
  audioParams: {
    codec: string;
    bitrate: string;
    sampleRate: number;
    channels: number;
  };
}

// Paths Configuration
export interface PathsConfig {
  stateFile: string;
  logFile: string;
  pidDir: string;
  configDir: string;
}

// Logging Configuration
export interface LoggingConfig {
  level: string;
  datePattern: string;
  maxSize: string;
  maxFiles: string;
}

// Performance Configuration
export interface PerformanceConfig {
  cpuThreshold: number;
  memoryThreshold: number;
  diskThreshold: number;
  temperatureThreshold: number;
  monitoringInterval: number;
  maxConcurrentStreams?: number;
  memoryLimitMB?: number;
  cpuThresholdPercent?: number;
}

// Main Configuration Interface
export interface Config {
  server: ServerConfig;
  streaming: StreamingConfig;
  paths: PathsConfig;
  logging: LoggingConfig;
  performance: PerformanceConfig;
}

// Stream Configuration
export interface StreamConfig {
  id: string;
  rtspUrl: string;
  rtmpUrl: string;
  videoParams: VideoParams;
  audioParams: AudioParams;
  retryCount?: number;
  maxRetries?: number;
  lastRetryTime?: number;
}

export interface VideoParams {
  codec: string;
  bitrate: string;
  resolution: string;
  framerate: string;
  keyframeInterval: string;
  preset: string;
}

export interface AudioParams {
  codec: string;
  bitrate: string;
  sampleRate: string;
  channels: string;
  hasAudio: boolean;
}

// Process and Stream State
export interface ProcessInfo {
  pid: number;
  streamId: string;
  startTime: number;
  command: string;
  status: 'running' | 'stopped' | 'failed';
}

export interface StreamState {
  id: string;
  rtspUrl: string;
  rtmpUrl: string;
  status: 'pending' | 'running' | 'active' | 'stopped' | 'failed' | 'expected' | 'inactive' | 'retrying';
  pid?: number;
  startTime: Date;
  lastHealthCheck?: Date;
  retryCount: number;
  error?: string;
  errorMessage?: string;
  lastError?: string;
}

// System Metrics
export interface SystemMetrics {
  cpu: {
    usage: number;
    temperature?: number;
  };
  memory: {
    used: number;
    total: number;
    percentage: number;
  };
  disk: {
    used: number;
    total: number;
    percentage: number;
  };
  network: {
    bytesIn: number;
    bytesOut: number;
  };
}

// Health Status
export interface HealthStatus {
  status: 'healthy' | 'warning' | 'critical';
  uptime: number;
  activeStreams: number;
  systemMetrics: SystemMetrics;
  lastCheck: Date;
}

// SSE Events and Messages
export interface SSEEvent {
  eventType: 'start' | 'stop' | 'health' | 'config' | 'system';
  cameraUrl?: string;
  streamKey?: string;
  data?: any;
  timestamp: Date;
}

export interface SSEMessage {
  type: 'start' | 'stop' | 'restart' | 'status';
  streamId: string;
  data?: any;
}

// Logging
export interface LogLevel {
  level: 'error' | 'warn' | 'info' | 'debug';
  message: string;
  timestamp: string;
  streamId?: string;
  pid?: number;
}

// Optimization Settings
export interface OptimizationSettings {
  gpuMemorySplit: number;
  swapSize: number;
  zramEnabled: boolean;
  networkOptimization: boolean;
  lowLatencyMode: boolean;
  disableUnusedServices: boolean;
  filesystemOptimization: boolean;
  kernelParameters: Record<string, string>;
}

// Audio Detection
export interface AudioDetectionResult {
  hasAudio: boolean;
  audioStreams: number;
  error?: string;
}

// Performance Metrics
export interface PerformanceMetrics {
  cpu: {
    usage: number;
    temperature?: number;
    cores: number;
  };
  memory: {
    used: number;
    total: number;
    percentage: number;
    available: number;
  };
  disk: {
    used: number;
    total: number;
    percentage: number;
    readSpeed: number;
    writeSpeed: number;
  };
  network: {
    bytesIn: number;
    bytesOut: number;
    packetsIn: number;
    packetsOut: number;
  };
  gpu?: {
    usage: number;
    memory: number;
    temperature: number;
  };
}