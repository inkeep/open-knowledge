import { useSyncExternalStore } from 'react';

export const TERMINAL_NEW_TAB_BARE_KEY = 'ok-terminal-new-tab-bare-v1';

export interface NewTabStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function readPreferBareTerminal(storage?: NewTabStorage): boolean {
  try {
    const s = storage ?? localStorage;
    return s.getItem(TERMINAL_NEW_TAB_BARE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writePreferBareTerminal(bare: boolean, storage?: NewTabStorage): void {
  try {
    const s = storage ?? localStorage;
    if (bare) s.setItem(TERMINAL_NEW_TAB_BARE_KEY, '1');
    else s.removeItem(TERMINAL_NEW_TAB_BARE_KEY);
  } catch {}
  for (const listener of listeners) listener();
}

const listeners = new Set<() => void>();

function currentPreferBareTerminal(): boolean {
  return getInitialPreferBareTerminal();
}

function reloadPreferBareTerminalFromStorage(): void {
  for (const listener of listeners) listener();
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event.key === TERMINAL_NEW_TAB_BARE_KEY || event.key === null) {
      reloadPreferBareTerminalFromStorage();
    }
  });
}

export function subscribePreferBareTerminal(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePreferBareTerminal(): boolean {
  return useSyncExternalStore(
    subscribePreferBareTerminal,
    currentPreferBareTerminal,
    currentPreferBareTerminal,
  );
}

function getInitialPreferBareTerminal(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    return readPreferBareTerminal();
  } catch {
    return false;
  }
}
