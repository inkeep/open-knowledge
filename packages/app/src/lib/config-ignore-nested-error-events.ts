/**
 * Module-scoped pub/sub for nested-`.okignore` parse-error notifications,
 * dispatched by `SystemDocSubscriber` upon CC1 `'config-ignore-nested-error'`
 * broadcasts and consumed by the Settings pane (Sonner toast).
 *
 * Mirrors the `config-validation-events.ts` shape (subscribe/emit pair, no
 * React dependency). Settings pane subscribes for the lifetime of its mount;
 * SystemDocSubscriber emits for every CC1 frame on this channel.
 */

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
