interface SingleFlightRun<T> {
  promise: Promise<T>;
  coalesced: boolean;
}

export interface SingleFlight<T> {
  run(key: string, fn: () => Promise<T>): SingleFlightRun<T>;
  readonly size: number;
}

export function createSingleFlight<T>(): SingleFlight<T> {
  const inflight = new Map<string, Promise<T>>();
  return {
    run(key, fn) {
      const existing = inflight.get(key);
      if (existing) return { promise: existing, coalesced: true };
      const promise = fn();
      inflight.set(key, promise);
      const evict = (): void => {
        if (inflight.get(key) === promise) inflight.delete(key);
      };
      promise.then(evict, evict);
      return { promise, coalesced: false };
    },
    get size() {
      return inflight.size;
    },
  };
}
