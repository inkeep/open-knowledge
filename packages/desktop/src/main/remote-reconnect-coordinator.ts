/** Result shape shared by local/remote Desktop restart IPC. */
export type RemoteReconnectOutcome = { ok: true } | { ok: false; reason: 'other' };

/**
 * Coalesce reconnect requests per project before either caller starts SSH.
 * This prevents redundant sessions from competing for the exclusive remote
 * project lock or main-process fingerprint ownership.
 */
export class RemoteReconnectCoordinator {
  private readonly pending = new Map<string, Promise<RemoteReconnectOutcome>>();

  run(
    projectKey: string,
    reconnect: () => Promise<RemoteReconnectOutcome>,
  ): Promise<RemoteReconnectOutcome> {
    const existing = this.pending.get(projectKey);
    if (existing) return existing;

    const work = Promise.resolve().then(reconnect);
    this.pending.set(projectKey, work);
    const clear = (): void => {
      if (this.pending.get(projectKey) === work) this.pending.delete(projectKey);
    };
    void work.then(clear, clear);
    return work;
  }
}
