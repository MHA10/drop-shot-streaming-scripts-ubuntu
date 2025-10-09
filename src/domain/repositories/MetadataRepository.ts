import { Metadata } from "../entities/Metadata";

export interface MetadataRepository {
  /**
   * Save a stream to persistent storage
   */
  save(metadata: Metadata): Promise<void>;

  /**
   * Find all running streams
   */
  find(): Promise<Metadata>;
}
