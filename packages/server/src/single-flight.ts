/**
 * Request-scoped single-flight (coalescing) for idempotent reads.
 *
 * Concurrent calls with an identical key share ONE in-flight promise instead of
 * each starting independent work; the entry evicts on settle (success AND
 * error). Built for `GET /api/history`: a poll storm or fan-out
 * of identical history queries collapses to a single git walk.
 *
 * Lighter than the refcounted abort-on-disconnect `InflightShowAllWalk` in
 * `api-extension.ts` — the wrapped reads take no AbortSignal, so there is no
 * walk to cancel; the only machinery needed is share + evict.
 *
 * Per-instance (NOT module-global): tests boot several servers in one process,
 * and each server must key its own in-flight set.
 */
interface SingleFlightRun<T> {
  /** The shared promise — identical for every caller coalesced onto one key. */
  promise: Promise<T>;
  /** True when this call attached to an already-in-flight promise (no new work). */
  coalesced: boolean;
}

export interface SingleFlight<T> {
  /**
   * Run `fn` under `key`, or attach to an in-flight run of the same key. `fn`
   * is invoked at most once per concurrent key generation. The map miss and the
   * `set` happen on the same tick (no await between), so a burst arriving on one
   * tick all attach to the first caller's promise.
   */
  run(key: string, fn: () => Promise<T>): SingleFlightRun<T>;
  /** Count of currently in-flight keys (diagnostics/tests). */
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
      // Evict on settle (success AND error). Guard the delete so a newer entry
      // created under the same key after this one settled is never clobbered.
      // `then(evict, evict)` handles BOTH settle paths on this internal chain,
      // so a rejected walk never surfaces as an unhandled rejection here — the
      // ORIGINAL `promise` is returned to the caller, who handles it separately.
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
