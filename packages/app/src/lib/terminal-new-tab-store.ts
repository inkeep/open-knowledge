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
}

export function getInitialPreferBareTerminal(): boolean {
  // Guard the whole dispatch (not just `typeof`) so a getter that throws on
  // access still yields the default — matches getInitialTerminalDock.
  try {
    if (typeof localStorage === 'undefined') return false;
    return readPreferBareTerminal();
  } catch {
    return false;
  }
}
