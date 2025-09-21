"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.StateManager = void 0;
const fs = __importStar(require("fs"));
const Logger_1 = require("../utils/Logger");
const ConfigManager_1 = require("../utils/ConfigManager");
class StateManager {
    constructor() {
        this.states = new Map();
        this.configs = new Map();
        this.saveTimeout = null;
        this.logger = Logger_1.Logger.getInstance();
        this.stateFile = ConfigManager_1.ConfigManager.getInstance().getConfig().paths.stateFile;
        this.loadState();
    }
    loadState() {
        try {
            if (fs.existsSync(this.stateFile)) {
                const data = fs.readFileSync(this.stateFile, 'utf8');
                const parsed = JSON.parse(data);
                if (parsed.states) {
                    for (const [id, state] of Object.entries(parsed.states)) {
                        this.states.set(id, state);
                    }
                }
                if (parsed.configs) {
                    for (const [id, config] of Object.entries(parsed.configs)) {
                        this.configs.set(id, config);
                    }
                }
                this.logger.info('State loaded successfully', {
                    statesCount: this.states.size,
                    configsCount: this.configs.size
                });
            }
            else {
                this.logger.info('No existing state file found, starting fresh');
            }
        }
        catch (error) {
            this.logger.error('Failed to load state', error);
            this.states.clear();
            this.configs.clear();
        }
    }
    saveState() {
        try {
            const data = {
                states: Object.fromEntries(this.states),
                configs: Object.fromEntries(this.configs),
                lastSaved: new Date().toISOString()
            };
            const dir = require('path').dirname(this.stateFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.stateFile, JSON.stringify(data, null, 2));
            this.logger.debug('State saved successfully');
        }
        catch (error) {
            this.logger.error('Failed to save state', error);
        }
    }
    debouncedSave() {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }
        this.saveTimeout = setTimeout(() => {
            this.saveState();
            this.saveTimeout = null;
        }, 1000);
    }
    setStreamState(streamId, state) {
        const currentState = this.states.get(streamId) || {
            id: streamId,
            status: 'inactive',
            retryCount: 0
        };
        const updatedState = {
            ...currentState,
            ...state,
            id: streamId
        };
        this.states.set(streamId, updatedState);
        this.debouncedSave();
        this.logger.debug('Stream state updated', {
            streamId,
            status: updatedState.status,
            retryCount: updatedState.retryCount
        });
    }
    getStreamState(streamId) {
        return this.states.get(streamId) || null;
    }
    getAllStreamStates() {
        return Array.from(this.states.values());
    }
    setStreamConfig(streamId, config) {
        this.configs.set(streamId, { ...config, id: streamId });
        this.debouncedSave();
        this.logger.debug('Stream config updated', { streamId });
    }
    getStreamConfig(streamId) {
        return this.configs.get(streamId) || null;
    }
    getAllStreamConfigs() {
        return Array.from(this.configs.values());
    }
    removeStream(streamId) {
        const hadState = this.states.delete(streamId);
        const hadConfig = this.configs.delete(streamId);
        if (hadState || hadConfig) {
            this.debouncedSave();
            this.logger.info('Stream removed from state', { streamId });
        }
    }
    getActiveStreams() {
        return Array.from(this.states.values()).filter(state => state.status === 'active' || state.status === 'retrying');
    }
    getFailedStreams() {
        return Array.from(this.states.values()).filter(state => state.status === 'failed');
    }
    incrementRetryCount(streamId) {
        const state = this.getStreamState(streamId);
        if (state) {
            const newRetryCount = (state.retryCount || 0) + 1;
            this.setStreamState(streamId, {
                retryCount: newRetryCount,
                lastHealthCheck: Date.now()
            });
            return newRetryCount;
        }
        return 0;
    }
    resetRetryCount(streamId) {
        this.setStreamState(streamId, { retryCount: 0 });
    }
    updateHealthCheck(streamId) {
        this.setStreamState(streamId, { lastHealthCheck: Date.now() });
    }
    getStreamsNeedingHealthCheck(intervalMs) {
        const now = Date.now();
        return this.getActiveStreams().filter(state => {
            const lastCheck = state.lastHealthCheck || 0;
            return (now - lastCheck) > intervalMs;
        });
    }
    markStreamAsActive(streamId, pid) {
        this.setStreamState(streamId, {
            status: 'active',
            pid,
            startTime: Date.now(),
            lastHealthCheck: Date.now(),
            errorMessage: undefined
        });
    }
    markStreamAsFailed(streamId, errorMessage) {
        this.setStreamState(streamId, {
            status: 'failed',
            pid: undefined,
            errorMessage,
            lastHealthCheck: Date.now()
        });
    }
    markStreamAsRetrying(streamId) {
        this.setStreamState(streamId, {
            status: 'retrying',
            lastHealthCheck: Date.now()
        });
    }
    markStreamAsInactive(streamId) {
        this.setStreamState(streamId, {
            status: 'inactive',
            pid: undefined,
            startTime: undefined,
            lastHealthCheck: Date.now()
        });
    }
    getStreamStats() {
        const states = Array.from(this.states.values());
        return {
            total: states.length,
            active: states.filter(s => s.status === 'active').length,
            failed: states.filter(s => s.status === 'failed').length,
            retrying: states.filter(s => s.status === 'retrying').length
        };
    }
    cleanup() {
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveState();
        }
    }
    exportState() {
        return JSON.stringify({
            states: Object.fromEntries(this.states),
            configs: Object.fromEntries(this.configs),
            exportedAt: new Date().toISOString()
        }, null, 2);
    }
    importState(data) {
        try {
            const parsed = JSON.parse(data);
            if (parsed.states) {
                this.states.clear();
                for (const [id, state] of Object.entries(parsed.states)) {
                    this.states.set(id, state);
                }
            }
            if (parsed.configs) {
                this.configs.clear();
                for (const [id, config] of Object.entries(parsed.configs)) {
                    this.configs.set(id, config);
                }
            }
            this.debouncedSave();
            this.logger.info('State imported successfully');
            return true;
        }
        catch (error) {
            this.logger.error('Failed to import state', error);
            return false;
        }
    }
}
exports.StateManager = StateManager;
//# sourceMappingURL=StateManager.js.map