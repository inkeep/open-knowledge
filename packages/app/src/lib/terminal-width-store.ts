export const TERMINAL_WIDTH_KEY = 'ok-terminal-width-v1';

// The terminal column wants more horizontal room than the doc panel: a usable
// shell needs roughly 80 columns, and tools like `claude` reflow poorly below
// ~92 columns / ~650px. The default leans wide for that reason; the min keeps it
// above the point where most CLIs become unusable. There is deliberately no
// pixel ceiling: the column may grow to near-full width, bounded at apply time
// by the layout's own constraints (the editor keeps a minimum sliver), so a
// wide persisted value must survive a reload rather than snap back.
export const DEFAULT_TERMINAL_WIDTH = 480;
export const MIN_TERMINAL_WIDTH = 320;

export interface TerminalWidthStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function clamp(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_TERMINAL_WIDTH;
  if (px < MIN_TERMINAL_WIDTH) return MIN_TERMINAL_WIDTH;
  return Math.round(px);
}

export function readTerminalWidth(storage?: TerminalWidthStorage): number {
  try {
    const s = storage ?? localStorage;
    const raw = s.getItem(TERMINAL_WIDTH_KEY);
    if (raw == null) return DEFAULT_TERMINAL_WIDTH;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_TERMINAL_WIDTH;
    return clamp(parsed);
  } catch {
    return DEFAULT_TERMINAL_WIDTH;
  }
}

export function writeTerminalWidth(px: number, storage?: TerminalWidthStorage): void {
  try {
    const s = storage ?? localStorage;
    s.setItem(TERMINAL_WIDTH_KEY, String(clamp(px)));
  } catch {
    // quota exceeded — in-memory state holds for the session (mirrors sidebar-pin-store)
  }
}

export function getInitialTerminalWidth(): number {
  // `typeof localStorage` is not safe when localStorage is a property getter that
  // throws on access (file:// protocol, Safari private mode SecurityError,
  // sandboxed iframes). Wrap the whole dispatch so the synchronous-init contract
  // survives any storage-restricted host.
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_TERMINAL_WIDTH;
    return readTerminalWidth();
  } catch {
    return DEFAULT_TERMINAL_WIDTH;
  }
}
