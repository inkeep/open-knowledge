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
