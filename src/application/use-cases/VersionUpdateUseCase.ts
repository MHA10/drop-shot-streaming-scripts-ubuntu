import * as packageJson from "../../../package.json";
import { FileSystemMetadataRepository } from "../../infrastructure/repositories/FileSystemMetadataRepository";

export class VersionUpdateUseCase {
  constructor(
    private readonly metadataRepository: FileSystemMetadataRepository
  ) {}

  async updateVersion(version?: string) {
    if (!version) return;

    const metadata = await this.metadataRepository.find();
    metadata.version.latest = version;
    metadata.updatedAt = new Date();
    await this.metadataRepository.save(metadata);
  }

  async execute() {
    const metadata = await this.metadataRepository.find();
    // fetch from packagejson
    const currentVersion = packageJson.version;
    if (metadata.version.latest === currentVersion) {
      return;
    }
    // exiting the process since pm2 will auto restart the process.
    // next time the process starts, the version will be updated
    process.exit(0);
  }
}
