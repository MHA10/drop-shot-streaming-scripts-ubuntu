export interface AppConfig {
    sse: {
        endpoint: string;
        retryInterval: number;
        maxRetries: number;
    };
    stream: {
        persistentStateDir: string;
        tempStateDir: string;
        healthCheckInterval: number;
    };
    ffmpeg: {
        rtspInputParams: string;
        outputParamsVideo: string;
        outputParamsAudio: string;
    };
    logging: {
        level: string;
        file?: string;
    };
    environment: string;
}
export declare class Config {
    private static instance;
    private config;
    private constructor();
    static getInstance(): Config;
    get(): AppConfig;
    private loadConfig;
    private getEnvVar;
    validate(): void;
}
//# sourceMappingURL=Config.d.ts.map