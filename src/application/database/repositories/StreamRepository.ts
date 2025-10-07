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
}
