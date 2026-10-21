import {
  normalizeTerminalRightWidth,
  PREFERRED_TERMINAL_RIGHT_WIDTH,
} from '@inkeep/open-knowledge-core/terminal-layout';

export const TERMINAL_RIGHT_WIDTH_KEY = 'ok-terminal-right-width-v1';

export interface TerminalRightWidthStorage {
  getItem(key: string): string | null;
}

export function readTerminalRightWidth(storage: TerminalRightWidthStorage): number {
  const raw = storage.getItem(TERMINAL_RIGHT_WIDTH_KEY);
  if (raw === null || raw.trim() === '') return PREFERRED_TERMINAL_RIGHT_WIDTH;
  return normalizeTerminalRightWidth(Number(raw));
}
