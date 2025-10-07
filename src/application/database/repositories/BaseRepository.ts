import { promises as fs } from "fs";
import { join } from "path";
import { BaseRepositoryInterface } from "../../interfaces/BaseRepository.interface";
import { BaseEntity } from "../entities/Base";

export class BaseRepository<T extends BaseEntity>
  implements BaseRepositoryInterface<T>
{
  constructor(private readonly persistentStateDir: string) {}

  private async ensureDirectoryExists(): Promise<void> {
    await fs.mkdir(this.persistentStateDir, { recursive: true });
  }

  private getFilePath(id: string): string {
    return join(this.persistentStateDir, `${id}.json`);
  }

  public async save(entity: T): Promise<void> {
    await this.ensureDirectoryExists();

    const filePath = this.getFilePath(entity.id);
    const entityData = entity;

    await fs.writeFile(filePath, JSON.stringify(entityData, null, 2), "utf8");
  }

  public async findById(id: string): Promise<T | null> {
    const filePath = this.getFilePath(id);

    try {
      const data = await fs.readFile(filePath, "utf8");

      // Check if file is empty or contains only whitespace
      if (!data.trim()) {
        await this.deleteCorruptedFile(filePath);
        return null;
      }

      const streamData = JSON.parse(data);

      return streamData as T;
    } catch (error) {
      // Check if it's a JSON parsing error (corrupted file)
      if (
        error instanceof SyntaxError ||
        (error as any).message?.includes("JSON")
      ) {
        await this.deleteCorruptedFile(filePath);
        return null;
      }

      // assuming the file doesn't exist. Simply return null.
      return null;
    }
  }

  private async deleteCorruptedFile(filePath: string): Promise<void> {
    await fs.unlink(filePath);
  }

  public async findAll(): Promise<T[]> {
    await this.ensureDirectoryExists();

    const files = await fs.readdir(this.persistentStateDir);
    const jsonFiles = files.filter((file) => file.endsWith(".json"));

    const entities: T[] = [];
    for (const file of jsonFiles) {
      const id = file.replace(".json", "");
      const entity = await this.findById(id);
      if (entity) {
        entities.push(entity);
      }
    }

    return entities;
  }

  public async delete(id: string): Promise<void> {
    const filePath = this.getFilePath(id);

    try {
      await fs.unlink(filePath);
    } catch (error) {
      if ((error as any).code === "ENOENT") {
        return; // File doesn't exist, consider it deleted
      }
      throw error;
    }
  }

  public async clear(): Promise<void> {
    await this.ensureDirectoryExists();
    const files = await fs.readdir(this.persistentStateDir);
    const jsonFiles = files.filter((file) => file.endsWith(".json"));

    for (const file of jsonFiles) {
      await fs.unlink(join(this.persistentStateDir, file));
    }
  }
}
