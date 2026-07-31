/**
 * First-paint cache for the sidebar's "Skills section visible" preference.
 *
 * The authoritative value lives in the project config CRDT (`merged.appearance
 * .sidebar.showSkillsSection`), which is `undefined` until the config doc syncs
 * after a reload. Falling back to `?? true` during that window flashes the
 * Files/Skills switcher for anyone who has the section turned OFF: it mounts on
 * first paint, then unmounts once the config loads `false`.
 *
 * This localStorage mirror lets the initial render use the last known value so
 * there is no flash. It is written ONLY when the config carries an explicit
 * value, so default users (config value `undefined`) never store anything and
 * keep the `?? true` default — they never flashed anyway.
 */
const STORAGE_KEY = 'ok-skills-section-visible-v1';

function storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// undefined = not yet loaded from storage; null = no stored value.
let cached: boolean | null | undefined;

/** Last explicitly-stored value, or null if the user never set the preference. */
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
  } catch {
    // quota / privacy mode — in-memory `cached` still serves this session.
  }
}

/**
 * Test-only: reset to the never-set state. Clears the stored mirror as well as
 * the in-memory snapshot — dropping the snapshot alone just makes the next read
 * reload whatever a previous test wrote, so the preference still leaks across
 * tests in the same worker.
 */
export function __resetSkillsSectionVisibleCacheForTests(): void {
  cached = undefined;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // no storage in this environment — the in-memory reset above is enough.
  }
}
