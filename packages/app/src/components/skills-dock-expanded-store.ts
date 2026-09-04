const STORAGE_KEY = 'ok-skills-dock-expanded-v1';

function storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

let cached: boolean | undefined;

export function readSkillsDockExpanded(): boolean {
  if (cached === undefined) {
    cached = storage()?.getItem(STORAGE_KEY) === 'true';
  }
  return cached;
}

const listeners = new Set<(expanded: boolean) => void>();

export function writeSkillsDockExpanded(expanded: boolean): void {
  if (cached === expanded) return;
  cached = expanded;
  try {
    storage()?.setItem(STORAGE_KEY, expanded ? 'true' : 'false');
  } catch {}
  for (const listener of listeners) listener(expanded);
}

export function subscribeSkillsDockExpanded(listener: (expanded: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function requestSkillsDockExpanded(): void {
  writeSkillsDockExpanded(true);
}

export function __skillsDockListenerCountForTests(): number {
  return listeners.size;
}

export function __resetSkillsDockExpandedForTests(): void {
  cached = undefined;
  cachedHeight = undefined;
  try {
    storage()?.removeItem(STORAGE_KEY);
    storage()?.removeItem(HEIGHT_KEY);
  } catch {}
}

const HEIGHT_KEY = 'ok-skills-dock-height-v1';

export const SKILLS_DOCK_MIN_HEIGHT = 96;
export function skillsDockMaxHeight(viewportHeight: number): number {
  return Math.max(SKILLS_DOCK_MIN_HEIGHT, Math.round(viewportHeight * 0.7));
}
export function clampSkillsDockHeight(height: number, viewportHeight: number): number {
  return Math.min(
    Math.max(Math.round(height), SKILLS_DOCK_MIN_HEIGHT),
    skillsDockMaxHeight(viewportHeight),
  );
}

let cachedHeight: number | null | undefined;

export function readSkillsDockHeight(): number | null {
  if (cachedHeight === undefined) {
    const raw = storage()?.getItem(HEIGHT_KEY);
    const parsed = raw === null || raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
    cachedHeight = Number.isFinite(parsed) ? parsed : null;
  }
  return cachedHeight;
}

export function writeSkillsDockHeight(height: number): void {
  cachedHeight = height;
  try {
    storage()?.setItem(HEIGHT_KEY, String(height));
  } catch {}
}
