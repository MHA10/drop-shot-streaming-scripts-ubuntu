import { AudioDetectionResult } from '../types';
export declare class AudioDetector {
    private logger;
    constructor();
    detectAudio(rtspUrl: string, timeoutMs?: number): Promise<AudioDetectionResult>;
    detectAudioWithRetry(rtspUrl: string, maxRetries?: number, timeoutMs?: number): Promise<AudioDetectionResult>;
    private sleep;
    validateRtspUrl(url: string): boolean;
}
//# sourceMappingURL=AudioDetector.d.ts.map