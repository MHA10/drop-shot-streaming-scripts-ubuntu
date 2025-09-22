import { Stream } from '../../domain/entities/Stream';
import { StreamId } from '../../domain/value-objects/StreamId';
import { StreamRepository } from '../../domain/repositories/StreamRepository';
import { Logger } from '../../application/interfaces/Logger';
export declare class FileSystemStreamRepository implements StreamRepository {
    private readonly persistentStateDir;
    private readonly logger;
    constructor(persistentStateDir: string, logger: Logger);
    private ensureDirectoryExists;
    private getStreamFilePath;
    save(stream: Stream): Promise<void>;
    findById(id: StreamId): Promise<Stream | null>;
    findAll(): Promise<Stream[]>;
    findRunning(): Promise<Stream[]>;
    findByState(state: string): Promise<Stream[]>;
    delete(id: StreamId): Promise<void>;
    exists(id: StreamId): Promise<boolean>;
    getAllIds(): Promise<StreamId[]>;
    clear(): Promise<void>;
}
//# sourceMappingURL=FileSystemStreamRepository.d.ts.map