import { randomBytes } from "crypto";

export abstract class BaseEntity {
  id: string;
  createdAt: Date;
  updatedAt: Date;

  constructor() {
    const timestamp = Date.now().toString(36);
    const random = randomBytes(8).toString("hex");
    this.id = `entity_${timestamp}_${random}`;

    this.createdAt = new Date();
    this.updatedAt = new Date();
  }

  abstract toJson(): Record<string, any>;
}
