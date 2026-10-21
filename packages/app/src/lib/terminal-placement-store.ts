import {
  normalizeTerminalPlacement,
  type TerminalPlacement,
} from '@inkeep/open-knowledge-core/terminal-layout';

export type { TerminalPlacement } from '@inkeep/open-knowledge-core/terminal-layout';

export const TERMINAL_PLACEMENT_KEY = 'ok-terminal-placement-v1';

export interface TerminalPlacementStorage {
  getItem(key: string): string | null;
}

export function readTerminalPlacement(storage: TerminalPlacementStorage): TerminalPlacement {
  return normalizeTerminalPlacement(storage.getItem(TERMINAL_PLACEMENT_KEY));
}
