import { Logger } from '../../application/interfaces/Logger';
export declare class ConsoleLogger implements Logger {
    private readonly logLevel;
    constructor(logLevel?: string);
    private shouldLog;
    private formatMessage;
    info(message: string, meta?: any): void;
    warn(message: string, meta?: any): void;
    error(message: string, meta?: any): void;
    debug(message: string, meta?: any): void;
}
//# sourceMappingURL=ConsoleLogger.d.ts.map