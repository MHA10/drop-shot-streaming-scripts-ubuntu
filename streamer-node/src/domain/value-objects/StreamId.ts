import { randomBytes } from 'crypto';

export class StreamId {
  private constructor(private readonly _value: string) {
    if (!_value || _value.trim().length === 0) {
      throw new Error('StreamId cannot be empty');
    }
  }

  public static create(): StreamId {
    const timestamp = Date.now().toString(36);
    const random = randomBytes(8).toString('hex');
    return new StreamId(`stream_${timestamp}_${random}`);
  }

  public static fromString(value: string): StreamId {
    return new StreamId(value);
  }

  public get value(): string {
    return this._value;
  }

  public equals(other: StreamId): boolean {
    return this._value === other._value;
  }

  public toString(): string {
    return this._value;
  }
}