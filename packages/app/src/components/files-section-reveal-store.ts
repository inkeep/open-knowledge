const listeners = new Set<() => void>();

export function requestFilesSectionReveal(): void {
  for (const listener of listeners) listener();
}

export function subscribeToFilesSectionReveal(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
