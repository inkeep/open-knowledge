const MUTATION_BLOCKED_MESSAGE = 'Wait for this SSH machine to finish opening before changing it.';

/** Prevent saved-machine mutation while an open still owns a captured snapshot. */
export class RemoteMachineOpenGuard {
  private readonly inFlight = new Map<string, number>();

  async run<T>(machineId: string, open: () => Promise<T>): Promise<T> {
    this.inFlight.set(machineId, (this.inFlight.get(machineId) ?? 0) + 1);
    try {
      return await open();
    } finally {
      const remaining = (this.inFlight.get(machineId) ?? 1) - 1;
      if (remaining === 0) this.inFlight.delete(machineId);
      else this.inFlight.set(machineId, remaining);
    }
  }

  assertMutable(machineId: string): void {
    if ((this.inFlight.get(machineId) ?? 0) > 0) {
      throw new Error(MUTATION_BLOCKED_MESSAGE);
    }
  }
}
