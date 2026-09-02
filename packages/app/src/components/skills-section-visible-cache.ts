const STORAGE_KEY = 'ok-skills-section-visible-v1';

function storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

let cached: boolean | null | undefined;

export function readCachedSkillsSectionVisible(): boolean | null {
  if (cached === undefined) {
    const raw = storage()?.getItem(STORAGE_KEY) ?? null;
    cached = raw === 'true' ? true : raw === 'false' ? false : null;
  }
  return cached;
}

export function writeCachedSkillsSectionVisible(visible: boolean): void {
  if (cached === visible) return;
  cached = visible;
  try {
    storage()?.setItem(STORAGE_KEY, visible ? 'true' : 'false');
  } catch {}
}

export function __resetSkillsSectionVisibleCacheForTests(): void {
  cached = undefined;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {}
}
