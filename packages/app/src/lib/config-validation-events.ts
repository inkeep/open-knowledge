/**
 * Module-scoped pub/sub for L3 (`onStoreDocument`) config-validation
 * rejections, dispatched by `SystemDocSubscriber` upon CC1
 * `'config-validation-rejected'` broadcasts and consumed by the Settings
 * pane.
 *
 * Mirrors the `documents-events.ts` shape (subscribe/emit pair, no React
 * dependency). Settings pane subscribes for the lifetime of its mount;
 * SystemDocSubscriber emits for every CC1 frame on this channel.
 */

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
