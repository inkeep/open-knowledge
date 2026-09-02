import {
  normalizeTerminalRightWidth,
  PREFERRED_TERMINAL_RIGHT_WIDTH,
} from '@inkeep/open-knowledge-core';

export {
  MIN_TERMINAL_RIGHT_WIDTH,
  PREFERRED_TERMINAL_RIGHT_WIDTH,
} from '@inkeep/open-knowledge-core';

export const TERMINAL_RIGHT_WIDTH_KEY = 'ok-terminal-right-width-v1';

export interface TerminalRightWidthStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readTerminalRightWidth(storage?: TerminalRightWidthStorage): number {
  try {
    const target = storage ?? localStorage;
    const raw = target.getItem(TERMINAL_RIGHT_WIDTH_KEY);
    if (raw === null || raw.trim() === '') return PREFERRED_TERMINAL_RIGHT_WIDTH;
    const parsed = Number(raw);
    return Number.isFinite(parsed)
      ? normalizeTerminalRightWidth(parsed)
      : PREFERRED_TERMINAL_RIGHT_WIDTH;
  } catch {
    return PREFERRED_TERMINAL_RIGHT_WIDTH;
  }
}

export function writeTerminalRightWidth(width: number, storage?: TerminalRightWidthStorage): void {
  try {
    const target = storage ?? localStorage;
    target.setItem(TERMINAL_RIGHT_WIDTH_KEY, String(normalizeTerminalRightWidth(width)));
  } catch {}
}
