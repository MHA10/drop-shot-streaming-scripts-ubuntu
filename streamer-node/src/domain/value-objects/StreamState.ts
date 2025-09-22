export enum StreamState {
  PENDING = 'pending',
  RUNNING = 'running',
  STOPPED = 'stopped',
  FAILED = 'failed',
  RECONCILING = 'reconciling'
}

export class StreamStateValidator {
  public static isValidTransition(from: StreamState, to: StreamState): boolean {
    const validTransitions: Record<StreamState, StreamState[]> = {
      [StreamState.PENDING]: [StreamState.RUNNING, StreamState.FAILED],
      [StreamState.RUNNING]: [StreamState.STOPPED, StreamState.FAILED, StreamState.RECONCILING],
      [StreamState.STOPPED]: [StreamState.RUNNING, StreamState.PENDING],
      [StreamState.FAILED]: [StreamState.PENDING, StreamState.RUNNING],
      [StreamState.RECONCILING]: [StreamState.RUNNING, StreamState.FAILED, StreamState.STOPPED]
    };

    return validTransitions[from]?.includes(to) ?? false;
  }

  public static getAllowedTransitions(from: StreamState): StreamState[] {
    const validTransitions: Record<StreamState, StreamState[]> = {
      [StreamState.PENDING]: [StreamState.RUNNING, StreamState.FAILED],
      [StreamState.RUNNING]: [StreamState.STOPPED, StreamState.FAILED, StreamState.RECONCILING],
      [StreamState.STOPPED]: [StreamState.RUNNING, StreamState.PENDING],
      [StreamState.FAILED]: [StreamState.PENDING, StreamState.RUNNING],
      [StreamState.RECONCILING]: [StreamState.RUNNING, StreamState.FAILED, StreamState.STOPPED]
    };

    return validTransitions[from] ?? [];
  }
}