import { useSyncExternalStore } from 'react';

export interface TimelineDiffView {
  docName: string;
  sha: string;
  parentSha: string | null;
  laterEdits: number;
  authorName: string;
  relativeTime: string;
  absoluteTime: string;
}

let current: TimelineDiffView | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function openTimelineDiff(view: TimelineDiffView): void {
  current = view;
  notify();
}

export function closeTimelineDiff(): void {
  if (current !== null) {
    current = null;
    notify();
  }
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

function getSnapshot(): TimelineDiffView | null {
  return current;
}

export function useTimelineDiffView(): TimelineDiffView | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
