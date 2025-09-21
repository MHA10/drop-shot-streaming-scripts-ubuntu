import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { ConfigManager } from './ConfigManager';

export class Logger {
  private static instance: Logger;
  private logger: winston.Logger;

  private constructor() {
    const config = ConfigManager.getInstance().getConfig();
    
    this.logger = winston.createLogger({
      level: config.logging?.level || 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
      transports: [
        // Console transport for development
        new winston.transports.Console({
          format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple(),
            winston.format.printf(({ timestamp, level, message, streamId, pid, ...meta }) => {
              let logMessage = `${timestamp} [${level}]`;
              if (streamId) logMessage += ` [Stream:${streamId}]`;
              if (pid) logMessage += ` [PID:${pid}]`;
              logMessage += `: ${message}`;
              
              if (Object.keys(meta).length > 0) {
                logMessage += ` ${JSON.stringify(meta)}`;
              }
              
              return logMessage;
            })
          )
        }),
        
        // File transport with rotation
        new DailyRotateFile({
          filename: config.paths.logFile.replace('.log', '-%DATE%.log'),
          datePattern: config.logging?.datePattern || 'YYYY-MM-DD',
          maxSize: config.logging?.maxSize || '20m',
          maxFiles: config.logging?.maxFiles || '7d',
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.json()
          )
        })
      ]
    });
  }

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  public info(message: string, meta?: { streamId?: string; pid?: number; [key: string]: any }): void {
    this.logger.info(message, meta);
  }

  public warn(message: string, meta?: { streamId?: string; pid?: number; [key: string]: any }): void {
    this.logger.warn(message, meta);
  }

  public error(message: string, error?: Error, meta?: { streamId?: string; pid?: number; [key: string]: any }): void {
    this.logger.error(message, { 
      ...meta, 
      error: error ? {
        message: error.message,
        stack: error.stack,
        name: error.name
      } : undefined 
    });
  }

  public debug(message: string, meta?: { streamId?: string; pid?: number; [key: string]: any }): void {
    this.logger.debug(message, meta);
  }

  public stream(streamId: string, message: string, meta?: { pid?: number; [key: string]: any }): void {
    this.logger.info(message, { ...meta, streamId });
  }

  public process(pid: number, message: string, meta?: { streamId?: string; [key: string]: any }): void {
    this.logger.info(message, { ...meta, pid });
  }

  public performance(message: string, duration: number, meta?: { streamId?: string; pid?: number; [key: string]: any }): void {
    this.logger.info(message, { ...meta, duration, type: 'performance' });
  }

  public setLevel(level: string): void {
    this.logger.level = level;
  }

  public getLogger(): winston.Logger {
    return this.logger;
  }
}