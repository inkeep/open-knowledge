export const TERMINAL_HEIGHT_KEY = 'ok-terminal-height-v1';

// Pixel fallback for the rare host with no measurable viewport (no `window` —
// SSR/headless). A windowed host opens at DEFAULT_TERMINAL_HEIGHT_FRACTION of the
// viewport instead; a storage read that throws is a separate path, handled by the
// catch in readTerminalHeight.
export const DEFAULT_TERMINAL_HEIGHT = 240;
export const MIN_TERMINAL_HEIGHT = 120;
// First-open height as a fraction of the renderer window (~1/3 of
// window.innerHeight): tall enough to read a command's output without dragging,
// and always under the 50vh ceiling.
const DEFAULT_TERMINAL_HEIGHT_FRACTION = 1 / 3;
// The ceiling is viewport-relative (50vh) rather than a fixed pixel cap so the
// dock never eats more than half the editor on any display — a persisted height
// from a tall screen clamps down when reopened on a short one.
const MAX_TERMINAL_HEIGHT_FRACTION = 0.5;

export interface HeightStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function maxHeight(viewportHeight: number): number {
  // Keep the 50vh ceiling at or above the floor so the clamp window never
  // inverts on a very short viewport.
  const vh = Number.isFinite(viewportHeight) ? viewportHeight : 0;
  return Math.max(MIN_TERMINAL_HEIGHT, Math.round(vh * MAX_TERMINAL_HEIGHT_FRACTION));
}

function defaultHeight(viewportHeight: number): number {
  const vh = Number.isFinite(viewportHeight) ? viewportHeight : 0;
  // Unmeasurable viewport — fall back to the fixed pixel default.
  if (vh <= 0) return DEFAULT_TERMINAL_HEIGHT;
  return Math.round(vh * DEFAULT_TERMINAL_HEIGHT_FRACTION);
}

function clamp(px: number, viewportHeight: number): number {
  const max = maxHeight(viewportHeight);
  if (!Number.isFinite(px)) return Math.min(defaultHeight(viewportHeight), max);
  if (px < MIN_TERMINAL_HEIGHT) return MIN_TERMINAL_HEIGHT;
  if (px > max) return max;
  return Math.round(px);
}

function currentViewportHeight(): number {
  if (typeof window === 'undefined') return 0;
  return window.innerHeight;
}

export function readTerminalHeight(storage?: HeightStorage, viewportHeight?: number): number {
  try {
    const s = storage ?? localStorage;
    const vh = viewportHeight ?? currentViewportHeight();
    const raw = s.getItem(TERMINAL_HEIGHT_KEY);
    if (raw == null) return clamp(defaultHeight(vh), vh);
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return clamp(defaultHeight(vh), vh);
    return clamp(parsed, vh);
  } catch {
    // localStorage threw (Safari private mode / file:// / sandboxed iframe):
    // intentionally the fixed pixel default, not the viewport fraction — when
    // storage is unreliable we don't trust the host to behave, so prefer the
    // constant over a measured value.
    return DEFAULT_TERMINAL_HEIGHT;
  }
}

export function writeTerminalHeight(
  px: number,
  storage?: HeightStorage,
  viewportHeight?: number,
): void {
  try {
    const s = storage ?? localStorage;
    const vh = viewportHeight ?? currentViewportHeight();
    s.setItem(TERMINAL_HEIGHT_KEY, String(clamp(px, vh)));
  } catch {
    // quota exceeded — in-memory state holds for the session (mirrors doc-panel-width-store)
  }
}

export function getInitialTerminalHeight(): number {
  // `typeof localStorage` is not safe when localStorage is a property getter
  // that throws on access (file:// protocol, Safari private mode SecurityError,
  // sandboxed iframes). Wrap the entire dispatch in try/catch so the
  // synchronous-init contract survives any storage-restricted host.
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_TERMINAL_HEIGHT;
    return readTerminalHeight();
  } catch {
    return DEFAULT_TERMINAL_HEIGHT;
  }
}
