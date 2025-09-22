export declare class StreamId {
    private readonly _value;
    private constructor();
    static create(): StreamId;
    static fromString(value: string): StreamId;
    get value(): string;
    equals(other: StreamId): boolean;
    toString(): string;
}
//# sourceMappingURL=StreamId.d.ts.map