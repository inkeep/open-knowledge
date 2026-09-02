import type { CC1ConfigIgnoreNestedErrorPayload } from '@inkeep/open-knowledge-core';

type Listener = (event: CC1ConfigIgnoreNestedErrorPayload) => void;

const listeners = new Set<Listener>();

export function emitConfigIgnoreNestedError(event: CC1ConfigIgnoreNestedErrorPayload): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (e) {
      console.warn('[config-ignore-nested-error-events] listener threw:', e);
    }
  }
}

export function subscribeToConfigIgnoreNestedError(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
