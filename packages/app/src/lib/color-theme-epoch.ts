import { useSyncExternalStore } from 'react';
import { COLOR_THEME_ATTRIBUTE } from './use-apply-config-color-theme';

let epoch = 0;
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function notify(): void {
  epoch += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!observer && typeof document !== 'undefined') {
    observer = new MutationObserver(notify);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [COLOR_THEME_ATTRIBUTE, 'class'],
    });
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = null;
    }
  };
}

function getSnapshot(): number {
  return epoch;
}

function getServerSnapshot(): number {
  return 0;
}

export function useColorThemeEpoch(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
