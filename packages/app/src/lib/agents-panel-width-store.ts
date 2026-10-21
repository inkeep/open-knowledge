export const AGENTS_PANEL_WIDTH_KEY = 'ok-terminal-width-v1';

const MIN_AGENTS_PANEL_WIDTH = 320;

export interface WidthStorage {
  getItem(key: string): string | null;
}

export function readAgentsPanelWidth(storage: WidthStorage): number | null {
  const raw = storage.getItem(AGENTS_PANEL_WIDTH_KEY);
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(parsed, MIN_AGENTS_PANEL_WIDTH);
}
