import { StreamEntity, StreamState } from "../entities/Stream";
import { BaseRepository } from "./BaseRepository";

export class StreamRepository extends BaseRepository<StreamEntity> {
  constructor(persistentStateDir: string) {
    super(persistentStateDir + "/streams");
  }

  async findRunning(): Promise<StreamEntity[]> {
    const streams = await this.findAll();
    return streams.filter((stream) => stream.state === StreamState.RUNNING);
  }

  async findById(id: string): Promise<StreamEntity | null> {
    const obj = await super.findById(id);
    if (!obj) return null;

    return StreamEntity.fromPersistence(obj);
  }

  async findAll(): Promise<StreamEntity[]> {
    const list = await super.findAll();
    return list.map((obj) => StreamEntity.fromPersistence(obj));
  }
}
