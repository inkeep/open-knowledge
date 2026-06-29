
import { useSyncExternalStore } from 'react';

let currentServerInstanceId: string | null = null;
const listeners = new Set<() => void>();

export function getServerInstanceId(): string | null {
  return currentServerInstanceId;
}

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

export function subscribeServerInstanceId(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useServerInstanceId(): string | null {
  return useSyncExternalStore(subscribeServerInstanceId, getServerInstanceId, getServerInstanceId);
}

export function __resetServerInstanceStoreForTests(): void {
  currentServerInstanceId = null;
  listeners.clear();
}
