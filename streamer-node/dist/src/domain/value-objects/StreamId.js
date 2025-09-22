"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StreamId = void 0;
const crypto_1 = require("crypto");
class StreamId {
    constructor(_value) {
        this._value = _value;
        if (!_value || _value.trim().length === 0) {
            throw new Error('StreamId cannot be empty');
        }
    }
    static create() {
        const timestamp = Date.now().toString(36);
        const random = (0, crypto_1.randomBytes)(8).toString('hex');
        return new StreamId(`stream_${timestamp}_${random}`);
    }
    static fromString(value) {
        return new StreamId(value);
    }
    get value() {
        return this._value;
    }
    equals(other) {
        return this._value === other._value;
    }
    toString() {
        return this._value;
    }
}
exports.StreamId = StreamId;
//# sourceMappingURL=StreamId.js.map