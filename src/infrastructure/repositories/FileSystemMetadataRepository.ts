import { promises as fs } from "fs";
import { join } from "path";
import { MetadataRepository } from "../../domain/repositories/MetadataRepository";
import { Metadata } from "../../domain/entities/Metadata";

export class FileSystemMetadataRepository implements MetadataRepository {
  constructor(private readonly persistentStateDir: string) {}

  private async ensureDirectoryExists(): Promise<void> {
    await fs.mkdir(this.persistentStateDir, { recursive: true });
  }

  private getFilePath(): string {
    return join(this.persistentStateDir, `streamer.metadata`);
  }

  public async save(metadata: Metadata): Promise<void> {
    await this.ensureDirectoryExists();
    const filePath = this.getFilePath();
    await fs.writeFile(filePath, JSON.stringify(metadata, null, 2), "utf8");
  }

  public async find(): Promise<Metadata> {
    await this.ensureDirectoryExists();
    const filePath = this.getFilePath();
    const data = await fs.readFile(filePath, "utf8");
    return JSON.parse(data);
  }
}
