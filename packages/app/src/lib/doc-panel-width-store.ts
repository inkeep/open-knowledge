export const DOC_PANEL_WIDTH_KEY = 'ok-doc-panel-width-v1';

export const DEFAULT_DOC_PANEL_WIDTH = 320;
export const MIN_DOC_PANEL_WIDTH = 300;
export const MAX_DOC_PANEL_WIDTH = 600;

export interface WidthStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function clamp(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_DOC_PANEL_WIDTH;
  if (px < MIN_DOC_PANEL_WIDTH) return MIN_DOC_PANEL_WIDTH;
  if (px > MAX_DOC_PANEL_WIDTH) return MAX_DOC_PANEL_WIDTH;
  return Math.round(px);
}

export function readDocPanelWidth(storage?: WidthStorage): number {
  try {
    const s = storage ?? localStorage;
    const raw = s.getItem(DOC_PANEL_WIDTH_KEY);
    if (raw == null) return DEFAULT_DOC_PANEL_WIDTH;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_DOC_PANEL_WIDTH;
    return clamp(parsed);
  } catch {
    return DEFAULT_DOC_PANEL_WIDTH;
  }
}

export function writeDocPanelWidth(px: number, storage?: WidthStorage): void {
  try {
    const s = storage ?? localStorage;
    s.setItem(DOC_PANEL_WIDTH_KEY, String(clamp(px)));
  } catch {
  }
}

export function getInitialDocPanelWidth(): number {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_DOC_PANEL_WIDTH;
    return readDocPanelWidth();
  } catch {
    return DEFAULT_DOC_PANEL_WIDTH;
  }
}
