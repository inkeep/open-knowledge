import { useSyncExternalStore } from 'react';

let onScreen = false;
const listeners = new Set<() => void>();

export function setCommentsPanelOnScreen(next: boolean): void {
  if (next === onScreen) return;
  onScreen = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): boolean {
  return onScreen;
}

export function useCommentsPanelOnScreen(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
