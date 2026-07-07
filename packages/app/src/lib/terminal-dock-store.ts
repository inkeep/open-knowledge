// Persisted terminal dock position (bottom vs right), per machine. Mirrors the
// shape of `terminal-height-store` / `doc-panel-width-store`: a tiny localStorage
// store with a synchronous-init contract that survives storage-restricted hosts
// (file://, Safari private mode, sandboxed iframes). NOT a per-doc sidecar — dock
// position is a UI preference, so it lives in localStorage, not `.ok/` (no-sidecars
// STOP rule).

export const TERMINAL_DOCK_KEY = 'ok-terminal-dock-v1';

export type TerminalDockPosition = 'bottom' | 'right';

export const DEFAULT_TERMINAL_DOCK: TerminalDockPosition = 'right';

export interface DockStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// Right is the default, so any value that is not the literal 'bottom' coerces to
// 'right' — a corrupted, empty, or future-unknown stored value (and the unset
// case) all land on the default. Bottom must be stored explicitly, so a user who
// picks it keeps it across sessions.
function coerce(raw: string | null): TerminalDockPosition {
  return raw === 'bottom' ? 'bottom' : 'right';
}

export function readTerminalDock(storage?: DockStorage): TerminalDockPosition {
  try {
    const s = storage ?? localStorage;
    return coerce(s.getItem(TERMINAL_DOCK_KEY));
  } catch {
    return DEFAULT_TERMINAL_DOCK;
  }
}

export function writeTerminalDock(position: TerminalDockPosition, storage?: DockStorage): void {
  try {
    const s = storage ?? localStorage;
    s.setItem(TERMINAL_DOCK_KEY, position);
  } catch {
    // quota exceeded — in-memory state holds for the session (mirrors terminal-height-store)
  }
}

export function getInitialTerminalDock(): TerminalDockPosition {
  // `typeof localStorage` is unsafe when localStorage is a property getter that
  // throws on access; wrap the whole dispatch so the synchronous-init contract
  // survives any storage-restricted host (matches getInitialTerminalHeight).
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_TERMINAL_DOCK;
    return readTerminalDock();
  } catch {
    return DEFAULT_TERMINAL_DOCK;
  }
}
