import { Config } from '../types';
export declare class ConfigManager {
    private static instance;
    private config;
    private constructor();
    static getInstance(): ConfigManager;
    private loadConfig;
    private mergeWithEnvVars;
    getConfig(): Config;
    get<T extends keyof Config>(section: T): Config[T];
    updateConfig(updates: Partial<Config>): void;
    validateConfig(): boolean;
    ensureDirectories(): void;
}
//# sourceMappingURL=ConfigManager.d.ts.map