// Persisted width of the right agents panel, per machine.
//
// The storage key still says "terminal" because this column used to hold the
// terminal when the dock was right-docked. Keeping the legacy key is the
// migration: a user who had sized that column keeps their width when the
// terminal moves to the bottom and the agents panel takes the column over.
export const AGENTS_PANEL_WIDTH_KEY = 'ok-terminal-width-v1';

// The agents panel wants more horizontal room than the doc panel: a transcript
// with code blocks and diffs reads badly in a narrow column. The default leans
// wide for that reason; the min keeps it above the point where the composer and
// message chrome start wrapping onto themselves. There is deliberately no pixel
// ceiling: the column may grow to near-full width, bounded at apply time by the
// layout's own constraints (the editor keeps a minimum sliver), so a wide
// persisted value must survive a reload rather than snap back.
export const DEFAULT_AGENTS_PANEL_WIDTH = 480;
export const MIN_AGENTS_PANEL_WIDTH = 320;

export interface WidthStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function clamp(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_AGENTS_PANEL_WIDTH;
  if (px < MIN_AGENTS_PANEL_WIDTH) return MIN_AGENTS_PANEL_WIDTH;
  return Math.round(px);
}

export function readAgentsPanelWidth(storage?: WidthStorage): number {
  try {
    const s = storage ?? localStorage;
    const raw = s.getItem(AGENTS_PANEL_WIDTH_KEY);
    if (raw == null) return DEFAULT_AGENTS_PANEL_WIDTH;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_AGENTS_PANEL_WIDTH;
    return clamp(parsed);
  } catch {
    return DEFAULT_AGENTS_PANEL_WIDTH;
  }
}

export function writeAgentsPanelWidth(px: number, storage?: WidthStorage): void {
  try {
    const s = storage ?? localStorage;
    s.setItem(AGENTS_PANEL_WIDTH_KEY, String(clamp(px)));
  } catch {
    // quota exceeded — in-memory state holds for the session (mirrors sidebar-pin-store)
  }
}

export function getInitialAgentsPanelWidth(): number {
  // `typeof localStorage` is not safe when localStorage is a property getter that
  // throws on access (file:// protocol, Safari private mode SecurityError,
  // sandboxed iframes). Wrap the whole dispatch so the synchronous-init contract
  // survives any storage-restricted host.
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_AGENTS_PANEL_WIDTH;
    return readAgentsPanelWidth();
  } catch {
    return DEFAULT_AGENTS_PANEL_WIDTH;
  }
}
