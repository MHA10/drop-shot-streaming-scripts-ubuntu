"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Logger = void 0;
const winston_1 = __importDefault(require("winston"));
const winston_daily_rotate_file_1 = __importDefault(require("winston-daily-rotate-file"));
const ConfigManager_1 = require("./ConfigManager");
class Logger {
    constructor() {
        const config = ConfigManager_1.ConfigManager.getInstance().getConfig();
        this.logger = winston_1.default.createLogger({
            level: config.logging?.level || 'info',
            format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.errors({ stack: true }), winston_1.default.format.json()),
            transports: [
                new winston_1.default.transports.Console({
                    format: winston_1.default.format.combine(winston_1.default.format.colorize(), winston_1.default.format.simple(), winston_1.default.format.printf(({ timestamp, level, message, streamId, pid, ...meta }) => {
                        let logMessage = `${timestamp} [${level}]`;
                        if (streamId)
                            logMessage += ` [Stream:${streamId}]`;
                        if (pid)
                            logMessage += ` [PID:${pid}]`;
                        logMessage += `: ${message}`;
                        if (Object.keys(meta).length > 0) {
                            logMessage += ` ${JSON.stringify(meta)}`;
                        }
                        return logMessage;
                    }))
                }),
                new winston_daily_rotate_file_1.default({
                    filename: config.paths.logFile.replace('.log', '-%DATE%.log'),
                    datePattern: config.logging?.datePattern || 'YYYY-MM-DD',
                    maxSize: config.logging?.maxSize || '20m',
                    maxFiles: config.logging?.maxFiles || '7d',
                    format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.json())
                })
            ]
        });
    }
    static getInstance() {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }
    info(message, meta) {
        this.logger.info(message, meta);
    }
    warn(message, meta) {
        this.logger.warn(message, meta);
    }
    error(message, error, meta) {
        this.logger.error(message, {
            ...meta,
            error: error ? {
                message: error.message,
                stack: error.stack,
                name: error.name
            } : undefined
        });
    }
    debug(message, meta) {
        this.logger.debug(message, meta);
    }
    stream(streamId, message, meta) {
        this.logger.info(message, { ...meta, streamId });
    }
    process(pid, message, meta) {
        this.logger.info(message, { ...meta, pid });
    }
    performance(message, duration, meta) {
        this.logger.info(message, { ...meta, duration, type: 'performance' });
    }
    setLevel(level) {
        this.logger.level = level;
    }
    getLogger() {
        return this.logger;
    }
}
exports.Logger = Logger;
//# sourceMappingURL=Logger.js.map