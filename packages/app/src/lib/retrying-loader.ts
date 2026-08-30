/**
 * Wrap a dynamic-import thunk in a module-level promise cache that clears
 * itself on rejection, so a transient chunk-load failure (one wifi blip on
 * first paint) retries on the next call instead of caching the rejection
 * for the whole session. Concurrent callers share the in-flight promise.
 */
export function createRetryingLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return () => {
    cached ||= load().catch((err: unknown) => {
      cached = null;
      throw err;
    });
    return cached;
  };
}
