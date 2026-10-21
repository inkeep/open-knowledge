export const TERMINAL_HEIGHT_KEY = 'ok-terminal-height-v1';

const MIN_TERMINAL_HEIGHT = 120;
const MAX_TERMINAL_HEIGHT_FRACTION = 0.5;

export interface HeightStorage {
  getItem(key: string): string | null;
}

function maxHeight(viewportHeight: number): number {
  const vh = Number.isFinite(viewportHeight) ? viewportHeight : 0;
  return Math.max(MIN_TERMINAL_HEIGHT, Math.round(vh * MAX_TERMINAL_HEIGHT_FRACTION));
}

export function readTerminalHeight(storage: HeightStorage, viewportHeight: number): number | null {
  const raw = storage.getItem(TERMINAL_HEIGHT_KEY);
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(parsed, MIN_TERMINAL_HEIGHT), maxHeight(viewportHeight));
}
