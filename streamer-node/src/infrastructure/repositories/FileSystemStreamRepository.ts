import { promises as fs } from 'fs';
import { join } from 'path';
import { Stream } from '../../domain/entities/Stream';
import { StreamId } from '../../domain/value-objects/StreamId';
import { StreamUrl } from '../../domain/value-objects/StreamUrl';
import { StreamState } from '../../domain/value-objects/StreamState';
import { StreamRepository } from '../../domain/repositories/StreamRepository';
import { Logger } from '../../application/interfaces/Logger';

export class FileSystemStreamRepository implements StreamRepository {
  constructor(
    private readonly persistentStateDir: string,
    private readonly logger: Logger
  ) {}

  private async ensureDirectoryExists(): Promise<void> {
    try {
      await fs.mkdir(this.persistentStateDir, { recursive: true });
    } catch (error) {
      this.logger.error('Failed to create state directory', {
        directory: this.persistentStateDir,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  private getStreamFilePath(id: StreamId): string {
    return join(this.persistentStateDir, `${id.value}.json`);
  }

  public async save(stream: Stream): Promise<void> {
    await this.ensureDirectoryExists();
    
    const filePath = this.getStreamFilePath(stream.id);
    const streamData = stream.toJSON();

    try {
      await fs.writeFile(filePath, JSON.stringify(streamData, null, 2), 'utf8');
      this.logger.debug('Stream saved to file', { 
        streamId: stream.id.value, 
        filePath 
      });
    } catch (error) {
      this.logger.error('Failed to save stream', {
        streamId: stream.id.value,
        filePath,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  public async findById(id: StreamId): Promise<Stream | null> {
    const filePath = this.getStreamFilePath(id);

    try {
      const data = await fs.readFile(filePath, 'utf8');
      const streamData = JSON.parse(data);
      
      return Stream.fromPersistence({
        id: StreamId.fromString(streamData.id),
        cameraUrl: StreamUrl.create(streamData.cameraUrl),
        streamKey: streamData.streamKey,
        state: streamData.state as StreamState,
        hasAudio: streamData.hasAudio,
        processId: streamData.processId,
        createdAt: new Date(streamData.createdAt),
        updatedAt: new Date(streamData.updatedAt)
      });
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        return null; // File doesn't exist
      }
      
      this.logger.error('Failed to read stream', {
        streamId: id.value,
        filePath,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  public async findAll(): Promise<Stream[]> {
    await this.ensureDirectoryExists();

    try {
      const files = await fs.readdir(this.persistentStateDir);
      const jsonFiles = files.filter(file => file.endsWith('.json'));
      
      const streams: Stream[] = [];
      for (const file of jsonFiles) {
        const streamId = StreamId.fromString(file.replace('.json', ''));
        const stream = await this.findById(streamId);
        if (stream) {
          streams.push(stream);
        }
      }
      
      return streams;
    } catch (error) {
      this.logger.error('Failed to read all streams', {
        directory: this.persistentStateDir,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  public async findRunning(): Promise<Stream[]> {
    const allStreams = await this.findAll();
    return allStreams.filter(stream => stream.isRunning());
  }

  public async findByState(state: string): Promise<Stream[]> {
    const allStreams = await this.findAll();
    return allStreams.filter(stream => stream.state === state);
  }

  public async delete(id: StreamId): Promise<void> {
    const filePath = this.getStreamFilePath(id);

    try {
      await fs.unlink(filePath);
      this.logger.debug('Stream file deleted', { 
        streamId: id.value, 
        filePath 
      });
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        return; // File doesn't exist, consider it deleted
      }
      
      this.logger.error('Failed to delete stream', {
        streamId: id.value,
        filePath,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  public async exists(id: StreamId): Promise<boolean> {
    const filePath = this.getStreamFilePath(id);

    try {
      await fs.access(filePath);
      return true;
    } catch (error) {
      return false;
    }
  }

  public async getAllIds(): Promise<StreamId[]> {
    await this.ensureDirectoryExists();

    try {
      const files = await fs.readdir(this.persistentStateDir);
      const jsonFiles = files.filter(file => file.endsWith('.json'));
      
      return jsonFiles.map(file => 
        StreamId.fromString(file.replace('.json', ''))
      );
    } catch (error) {
      this.logger.error('Failed to get all stream IDs', {
        directory: this.persistentStateDir,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  public async clear(): Promise<void> {
    await this.ensureDirectoryExists();

    try {
      const files = await fs.readdir(this.persistentStateDir);
      const jsonFiles = files.filter(file => file.endsWith('.json'));
      
      for (const file of jsonFiles) {
        await fs.unlink(join(this.persistentStateDir, file));
      }
      
      this.logger.info('All stream files cleared', { 
        directory: this.persistentStateDir,
        filesDeleted: jsonFiles.length 
      });
    } catch (error) {
      this.logger.error('Failed to clear streams', {
        directory: this.persistentStateDir,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
}