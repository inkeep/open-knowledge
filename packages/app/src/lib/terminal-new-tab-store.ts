import { useSyncExternalStore } from 'react';

// Persisted "the New-chat split button's last pick was a bare Terminal" flag,
// per machine. Terminal-only: the shared Ask-AI sticky store (unified-agent-store)
// only understands CLI / app-target picks, so a "Terminal" (bare shell) choice
// can't live there. When set, the split button defaults to opening a bare shell;
// when absent, it falls back to the shared CLI default (so a CLI pick — here or in
// any Ask-AI surface — still drives the default, unchanged). Picking a CLI clears
// this flag. Mirrors terminal-dock-store's storage-restricted-host contract; a UI
// preference, so localStorage, not a `.ok/` sidecar (no-sidecars STOP rule).

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
  } catch {
    // quota / restricted host — the in-memory selection holds for the session.
  }
  // Publish so the sibling host re-reads; without this the two diverge and both
  // claim the same Ask-AI passage.
  for (const listener of listeners) listener();
}

// Module-scope state + listeners so every mounted surface observes the SAME
// value. Both session hosts partition Ask-AI / preferred-session work by
// comparing the kind each one resolves; a per-instance `useState` snapshot let
// one host's pick diverge from the other's, so both claimed and the passage
// landed twice. Mirrors `lib/acp/enabled-agents.ts`, which this file's consumers
// already read that way.
const listeners = new Set<() => void>();

// Reads storage on every call rather than memoizing. The value is a primitive, so
// React's Object.is comparison makes an unchanged read a no-op re-render — and a
// module-scope cache would survive `localStorage.clear()`, leaking one test's pick
// into the next (and any external clear into the live session).
function currentPreferBareTerminal(): boolean {
  return getInitialPreferBareTerminal();
}

/** Notify subscribers to re-read (cross-tab `storage` events). */
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

/** Subscribe to pick changes. Exported so a test can stand in for a second host. */
export function subscribePreferBareTerminal(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive read — every subscriber re-renders when any surface writes. */
export function usePreferBareTerminal(): boolean {
  return useSyncExternalStore(
    subscribePreferBareTerminal,
    currentPreferBareTerminal,
    currentPreferBareTerminal,
  );
}

function getInitialPreferBareTerminal(): boolean {
  // Guard the whole dispatch (not just `typeof`) so a getter that throws on
  // access still yields the default — matches getInitialTerminalDock.
  try {
    if (typeof localStorage === 'undefined') return false;
    return readPreferBareTerminal();
  } catch {
    return false;
  }
}
