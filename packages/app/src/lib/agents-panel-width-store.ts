export const AGENTS_PANEL_WIDTH_KEY = 'ok-terminal-width-v1';

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
  } catch {}
}

export function getInitialAgentsPanelWidth(): number {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_AGENTS_PANEL_WIDTH;
    return readAgentsPanelWidth();
  } catch {
    return DEFAULT_AGENTS_PANEL_WIDTH;
  }
}
