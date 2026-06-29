
import type { CC1ConfigValidationRejectedPayload } from '@inkeep/open-knowledge-core';

type Listener = (event: CC1ConfigValidationRejectedPayload) => void;

const listeners = new Set<Listener>();

export function emitConfigValidationRejected(event: CC1ConfigValidationRejectedPayload): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (e) {
      console.warn('[config-validation-events] listener threw:', e);
    }
  }
}

export function subscribeToConfigValidationRejected(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
