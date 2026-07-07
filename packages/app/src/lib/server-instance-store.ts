/**
 * Shared server-epoch (`serverInstanceId`) store for the config-doc providers.
 *
 * The editor `ProviderPool` already learns the current server epoch (via
 * `refreshServerInfo` → `pool.setExpectedServerInstanceId`) and uses it to
 * claim the epoch in its auth token, so a stale-epoch reconnect after a server
 * respawn is rejected at `onAuthenticate` BEFORE any Yjs sync — preventing the
 * ghost-item union-merge. The config-doc providers (`config-provider.tsx`) are
 * not pool members, so they need the same epoch from a shared source.
 *
 * This module is that source. `refreshServerInfo` writes it (alongside the
 * pool sink); config providers read it to build their token claim and to
 * re-key their creation effect (epoch change → dispose + recreate the Y.Doc,
 * which re-syncs clean). The pool keeps its own `cachedServerInstanceId` — this
 * store is an additive second consumer, not a replacement.
 *
 * HTTP-only sink rationale: a new epoch implies a new server process, hence a
 * dropped socket and a forced reconnect, which fires `refreshServerInfo` (the
 * HTTP `GET /api/server-info` path) via `__system__`. The CC1-push epoch path
 * cannot deliver a fresh epoch on a live socket, so it need not feed this store.
 */

import { useSyncExternalStore } from 'react';

let currentServerInstanceId: string | null = null;
const listeners = new Set<() => void>();

/** Current server epoch, or `null` before the first `/api/server-info`. */
export function getServerInstanceId(): string | null {
  return currentServerInstanceId;
}

/**
 * Publish the server epoch. Idempotent — a no-op when unchanged, so calling on
 * every `refreshServerInfo` (which fires on every `__system__` reconnect) does
 * not churn subscribers. Empty string normalizes to `null` (matches
 * `buildAuthToken`'s "absent claim" treatment).
 */
export function setServerInstanceId(id: string | null): void {
  const next = id !== null && id.length > 0 ? id : null;
  if (next === currentServerInstanceId) return;
  currentServerInstanceId = next;
  for (const listener of listeners) {
    try {
      listener();
    } catch (e) {
      console.warn('[server-instance-store] subscriber threw:', e);
    }
  }
}

/** Subscribe to epoch changes. Returns an unsubscribe function. */
export function subscribeServerInstanceId(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * React binding. Re-renders the consumer when the epoch changes — config
 * providers add the returned value to their creation effect's deps so an epoch
 * change rebuilds them.
 */
export function useServerInstanceId(): string | null {
  return useSyncExternalStore(subscribeServerInstanceId, getServerInstanceId, getServerInstanceId);
}

/** Test-only: reset module state between tests. */
export function __resetServerInstanceStoreForTests(): void {
  currentServerInstanceId = null;
  listeners.clear();
}
