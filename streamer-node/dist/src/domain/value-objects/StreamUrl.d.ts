export declare class StreamUrl {
    private readonly _value;
    private constructor();
    static create(url: string): StreamUrl;
    private validate;
    get value(): string;
    isRtsp(): boolean;
    isHttp(): boolean;
    equals(other: StreamUrl): boolean;
    toString(): string;
}
//# sourceMappingURL=StreamUrl.d.ts.map