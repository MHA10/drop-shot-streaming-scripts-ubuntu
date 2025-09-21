import winston from 'winston';
export declare class Logger {
    private static instance;
    private logger;
    private constructor();
    static getInstance(): Logger;
    info(message: string, meta?: {
        streamId?: string;
        pid?: number;
        [key: string]: any;
    }): void;
    warn(message: string, meta?: {
        streamId?: string;
        pid?: number;
        [key: string]: any;
    }): void;
    error(message: string, error?: Error, meta?: {
        streamId?: string;
        pid?: number;
        [key: string]: any;
    }): void;
    debug(message: string, meta?: {
        streamId?: string;
        pid?: number;
        [key: string]: any;
    }): void;
    stream(streamId: string, message: string, meta?: {
        pid?: number;
        [key: string]: any;
    }): void;
    process(pid: number, message: string, meta?: {
        streamId?: string;
        [key: string]: any;
    }): void;
    performance(message: string, duration: number, meta?: {
        streamId?: string;
        pid?: number;
        [key: string]: any;
    }): void;
    setLevel(level: string): void;
    getLogger(): winston.Logger;
}
//# sourceMappingURL=Logger.d.ts.map