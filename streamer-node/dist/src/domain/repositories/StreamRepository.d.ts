import { Stream } from '../entities/Stream';
import { StreamId } from '../value-objects/StreamId';
export interface StreamRepository {
    /**
     * Save a stream to persistent storage
     */
    save(stream: Stream): Promise<void>;
    /**
     * Find a stream by its ID
     */
    findById(id: StreamId): Promise<Stream | null>;
    /**
     * Find all streams
     */
    findAll(): Promise<Stream[]>;
    /**
     * Find all running streams
     */
    findRunning(): Promise<Stream[]>;
    /**
     * Find streams by state
     */
    findByState(state: string): Promise<Stream[]>;
    /**
     * Delete a stream
     */
    delete(id: StreamId): Promise<void>;
    /**
     * Check if a stream exists
     */
    exists(id: StreamId): Promise<boolean>;
    /**
     * Get all stream IDs
     */
    getAllIds(): Promise<StreamId[]>;
    /**
     * Clear all streams (for testing/cleanup)
     */
    clear(): Promise<void>;
}
//# sourceMappingURL=StreamRepository.d.ts.map