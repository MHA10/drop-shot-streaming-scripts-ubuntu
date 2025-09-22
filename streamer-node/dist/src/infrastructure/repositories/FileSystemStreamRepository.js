"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileSystemStreamRepository = void 0;
const fs_1 = require("fs");
const path_1 = require("path");
const Stream_1 = require("../../domain/entities/Stream");
const StreamId_1 = require("../../domain/value-objects/StreamId");
const StreamUrl_1 = require("../../domain/value-objects/StreamUrl");
class FileSystemStreamRepository {
    constructor(persistentStateDir, logger) {
        this.persistentStateDir = persistentStateDir;
        this.logger = logger;
    }
    async ensureDirectoryExists() {
        try {
            await fs_1.promises.mkdir(this.persistentStateDir, { recursive: true });
        }
        catch (error) {
            this.logger.error('Failed to create state directory', {
                directory: this.persistentStateDir,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }
    getStreamFilePath(id) {
        return (0, path_1.join)(this.persistentStateDir, `${id.value}.json`);
    }
    async save(stream) {
        await this.ensureDirectoryExists();
        const filePath = this.getStreamFilePath(stream.id);
        const streamData = stream.toJSON();
        try {
            await fs_1.promises.writeFile(filePath, JSON.stringify(streamData, null, 2), 'utf8');
            this.logger.debug('Stream saved to file', {
                streamId: stream.id.value,
                filePath
            });
        }
        catch (error) {
            this.logger.error('Failed to save stream', {
                streamId: stream.id.value,
                filePath,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }
    async findById(id) {
        const filePath = this.getStreamFilePath(id);
        try {
            const data = await fs_1.promises.readFile(filePath, 'utf8');
            const streamData = JSON.parse(data);
            return Stream_1.Stream.fromPersistence({
                id: StreamId_1.StreamId.fromString(streamData.id),
                cameraUrl: StreamUrl_1.StreamUrl.create(streamData.cameraUrl),
                streamKey: streamData.streamKey,
                state: streamData.state,
                hasAudio: streamData.hasAudio,
                processId: streamData.processId,
                createdAt: new Date(streamData.createdAt),
                updatedAt: new Date(streamData.updatedAt)
            });
        }
        catch (error) {
            if (error.code === 'ENOENT') {
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
    async findAll() {
        await this.ensureDirectoryExists();
        try {
            const files = await fs_1.promises.readdir(this.persistentStateDir);
            const jsonFiles = files.filter(file => file.endsWith('.json'));
            const streams = [];
            for (const file of jsonFiles) {
                const streamId = StreamId_1.StreamId.fromString(file.replace('.json', ''));
                const stream = await this.findById(streamId);
                if (stream) {
                    streams.push(stream);
                }
            }
            return streams;
        }
        catch (error) {
            this.logger.error('Failed to read all streams', {
                directory: this.persistentStateDir,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }
    async findRunning() {
        const allStreams = await this.findAll();
        return allStreams.filter(stream => stream.isRunning());
    }
    async findByState(state) {
        const allStreams = await this.findAll();
        return allStreams.filter(stream => stream.state === state);
    }
    async delete(id) {
        const filePath = this.getStreamFilePath(id);
        try {
            await fs_1.promises.unlink(filePath);
            this.logger.debug('Stream file deleted', {
                streamId: id.value,
                filePath
            });
        }
        catch (error) {
            if (error.code === 'ENOENT') {
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
    async exists(id) {
        const filePath = this.getStreamFilePath(id);
        try {
            await fs_1.promises.access(filePath);
            return true;
        }
        catch (error) {
            return false;
        }
    }
    async getAllIds() {
        await this.ensureDirectoryExists();
        try {
            const files = await fs_1.promises.readdir(this.persistentStateDir);
            const jsonFiles = files.filter(file => file.endsWith('.json'));
            return jsonFiles.map(file => StreamId_1.StreamId.fromString(file.replace('.json', '')));
        }
        catch (error) {
            this.logger.error('Failed to get all stream IDs', {
                directory: this.persistentStateDir,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }
    async clear() {
        await this.ensureDirectoryExists();
        try {
            const files = await fs_1.promises.readdir(this.persistentStateDir);
            const jsonFiles = files.filter(file => file.endsWith('.json'));
            for (const file of jsonFiles) {
                await fs_1.promises.unlink((0, path_1.join)(this.persistentStateDir, file));
            }
            this.logger.info('All stream files cleared', {
                directory: this.persistentStateDir,
                filesDeleted: jsonFiles.length
            });
        }
        catch (error) {
            this.logger.error('Failed to clear streams', {
                directory: this.persistentStateDir,
                error: error instanceof Error ? error.message : String(error)
            });
            throw error;
        }
    }
}
exports.FileSystemStreamRepository = FileSystemStreamRepository;
//# sourceMappingURL=FileSystemStreamRepository.js.map