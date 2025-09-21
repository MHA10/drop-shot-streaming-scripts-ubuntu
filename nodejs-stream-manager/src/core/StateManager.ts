import * as fs from 'fs';
import { StreamState, StreamConfig } from '../types';
import { Logger } from '../utils/Logger';
import { ConfigManager } from '../utils/ConfigManager';

export class StateManager {
  private states: Map<string, StreamState> = new Map();
  private configs: Map<string, StreamConfig> = new Map();
  private logger: Logger;
  private stateFile: string;
  private saveTimeout: NodeJS.Timeout | null = null;

  constructor() {
    this.logger = Logger.getInstance();
    this.stateFile = ConfigManager.getInstance().getConfig().paths.stateFile;
    this.loadState();
  }

  private loadState(): void {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = fs.readFileSync(this.stateFile, 'utf8');
        const parsed = JSON.parse(data);
        
        if (parsed.states) {
          for (const [id, state] of Object.entries(parsed.states)) {
            this.states.set(id, state as StreamState);
          }
        }
        
        if (parsed.configs) {
          for (const [id, config] of Object.entries(parsed.configs)) {
            this.configs.set(id, config as StreamConfig);
          }
        }

        this.logger.info('State loaded successfully', { 
          statesCount: this.states.size,
          configsCount: this.configs.size 
        });
      } else {
        this.logger.info('No existing state file found, starting fresh');
      }
    } catch (error) {
      this.logger.error('Failed to load state', error as Error);
      // Continue with empty state
      this.states.clear();
      this.configs.clear();
    }
  }

  private saveState(): void {
    try {
      const data = {
        states: Object.fromEntries(this.states),
        configs: Object.fromEntries(this.configs),
        lastSaved: new Date().toISOString()
      };

      // Ensure directory exists
      const dir = require('path').dirname(this.stateFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(this.stateFile, JSON.stringify(data, null, 2));
      this.logger.debug('State saved successfully');
    } catch (error) {
      this.logger.error('Failed to save state', error as Error);
    }
  }

  private debouncedSave(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    
    this.saveTimeout = setTimeout(() => {
      this.saveState();
      this.saveTimeout = null;
    }, 1000); // Save after 1 second of inactivity
  }

  public setStreamState(streamId: string, state: Partial<StreamState>): void {
    const currentState = this.states.get(streamId) || {
      id: streamId,
      status: 'inactive',
      retryCount: 0
    };

    const updatedState: StreamState = {
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

  public getStreamState(streamId: string): StreamState | null {
    return this.states.get(streamId) || null;
  }

  public getAllStreamStates(): StreamState[] {
    return Array.from(this.states.values());
  }

  public setStreamConfig(streamId: string, config: StreamConfig): void {
    this.configs.set(streamId, { ...config, id: streamId });
    this.debouncedSave();

    this.logger.debug('Stream config updated', { streamId });
  }

  public getStreamConfig(streamId: string): StreamConfig | null {
    return this.configs.get(streamId) || null;
  }

  public getAllStreamConfigs(): StreamConfig[] {
    return Array.from(this.configs.values());
  }

  public removeStream(streamId: string): void {
    const hadState = this.states.delete(streamId);
    const hadConfig = this.configs.delete(streamId);
    
    if (hadState || hadConfig) {
      this.debouncedSave();
      this.logger.info('Stream removed from state', { streamId });
    }
  }

  public getActiveStreams(): StreamState[] {
    return Array.from(this.states.values()).filter(
      state => state.status === 'active' || state.status === 'retrying'
    );
  }

  public getFailedStreams(): StreamState[] {
    return Array.from(this.states.values()).filter(
      state => state.status === 'failed'
    );
  }

  public incrementRetryCount(streamId: string): number {
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

  public resetRetryCount(streamId: string): void {
    this.setStreamState(streamId, { retryCount: 0 });
  }

  public updateHealthCheck(streamId: string): void {
    this.setStreamState(streamId, { lastHealthCheck: Date.now() });
  }

  public getStreamsNeedingHealthCheck(intervalMs: number): StreamState[] {
    const now = Date.now();
    return this.getActiveStreams().filter(state => {
      const lastCheck = state.lastHealthCheck || 0;
      return (now - lastCheck) > intervalMs;
    });
  }

  public markStreamAsActive(streamId: string, pid: number): void {
    this.setStreamState(streamId, {
      status: 'active',
      pid,
      startTime: Date.now(),
      lastHealthCheck: Date.now(),
      errorMessage: undefined
    });
  }

  public markStreamAsFailed(streamId: string, errorMessage: string): void {
    this.setStreamState(streamId, {
      status: 'failed',
      pid: undefined,
      errorMessage,
      lastHealthCheck: Date.now()
    });
  }

  public markStreamAsRetrying(streamId: string): void {
    this.setStreamState(streamId, {
      status: 'retrying',
      lastHealthCheck: Date.now()
    });
  }

  public markStreamAsInactive(streamId: string): void {
    this.setStreamState(streamId, {
      status: 'inactive',
      pid: undefined,
      startTime: undefined,
      lastHealthCheck: Date.now()
    });
  }

  public getStreamStats(): { total: number; active: number; failed: number; retrying: number } {
    const states = Array.from(this.states.values());
    return {
      total: states.length,
      active: states.filter(s => s.status === 'active').length,
      failed: states.filter(s => s.status === 'failed').length,
      retrying: states.filter(s => s.status === 'retrying').length
    };
  }

  public cleanup(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveState(); // Final save
    }
  }

  public exportState(): string {
    return JSON.stringify({
      states: Object.fromEntries(this.states),
      configs: Object.fromEntries(this.configs),
      exportedAt: new Date().toISOString()
    }, null, 2);
  }

  public importState(data: string): boolean {
    try {
      const parsed = JSON.parse(data);
      
      if (parsed.states) {
        this.states.clear();
        for (const [id, state] of Object.entries(parsed.states)) {
          this.states.set(id, state as StreamState);
        }
      }
      
      if (parsed.configs) {
        this.configs.clear();
        for (const [id, config] of Object.entries(parsed.configs)) {
          this.configs.set(id, config as StreamConfig);
        }
      }

      this.debouncedSave();
      this.logger.info('State imported successfully');
      return true;
    } catch (error) {
      this.logger.error('Failed to import state', error as Error);
      return false;
    }
  }
}