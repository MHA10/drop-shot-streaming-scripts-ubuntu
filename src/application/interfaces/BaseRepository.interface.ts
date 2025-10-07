import { BaseEntity } from "../database/entities/Base";

export interface BaseRepositoryInterface<T extends BaseEntity> {
  /**
   * Upsert an entity to persistent storage
   */
  save(entity: T): Promise<void>;

  /**
   * Find an entity by its ID
   */
  findById(id: string): Promise<T | null>;

  /**
   * Find all entities
   */
  findAll(): Promise<T[]>;

  /**
   * Delete an entity
   */
  delete(id: string): Promise<void>;

  /**
   * Clear all entities (for testing/cleanup)
   */
  clear(): Promise<void>;
}
