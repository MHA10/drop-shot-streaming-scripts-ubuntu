"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StreamUrl = void 0;
class StreamUrl {
    constructor(_value) {
        this._value = _value;
        this.validate(_value);
    }
    static create(url) {
        return new StreamUrl(url);
    }
    validate(url) {
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
    get value() {
        return this._value;
    }
    isRtsp() {
        return this._value.toLowerCase().startsWith('rtsp://');
    }
    isHttp() {
        return this._value.toLowerCase().startsWith('http://') ||
            this._value.toLowerCase().startsWith('https://');
    }
    equals(other) {
        return this._value === other._value;
    }
    toString() {
        return this._value;
    }
}
exports.StreamUrl = StreamUrl;
//# sourceMappingURL=StreamUrl.js.map