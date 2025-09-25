export class StreamUrl {
  private constructor(private readonly _value: string) {
    this.validate(_value);
  }

  public static create(url: string): StreamUrl {
    return new StreamUrl(url);
  }

  private validate(url: string): void {
    if (!url || url.trim().length === 0) {
      throw new Error('Stream URL cannot be empty');
    }

    // Basic URL validation - should start with rtsp:// or http://
    const urlPattern = /^(rtsp|http|https):\/\/.+/i;
    if (!urlPattern.test(url)) {
      throw new Error('Invalid stream URL format. Must start with rtsp://, http://, or https://');
    }

    // Additional RTSP validation
    if (url.toLowerCase().startsWith('rtsp://')) {
      // Basic RTSP URL structure validation
      const rtspPattern = /^rtsp:\/\/[^\/\s]+/i;
      if (!rtspPattern.test(url)) {
        throw new Error('Invalid RTSP URL format');
      }
    }
  }

  public get value(): string {
    return this._value;
  }

  public isRtsp(): boolean {
    return this._value.toLowerCase().startsWith('rtsp://');
  }

  public isHttp(): boolean {
    return this._value.toLowerCase().startsWith('http://') || 
           this._value.toLowerCase().startsWith('https://');
  }

  public equals(other: StreamUrl): boolean {
    return this._value === other._value;
  }

  public toString(): string {
    return this._value;
  }
}