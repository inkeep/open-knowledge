/**
 * Persisted, cross-panel "is the Properties section collapsed?" preference.
 *
 * One module-level external store (same pattern as `composer-draft-store.ts` and
 * `selection-context`) so every mounted `PropertyPanel` — several stay alive at
 * once in the pooled `EditorActivityPool` — reflects the collapse toggle LIVE
 * and in lockstep, and the choice survives navigation between files and reload.
 * A single user-global preference (NOT per-doc): collapsing the section on one
 * file collapses it everywhere, immediately.
 *
 * Default is OPEN (`collapsed === false`). Flip `DEFAULT_COLLAPSED` to change the
 * first-run default.
 *
 * Scroll safety: because this is live, toggling on one doc resizes the Properties
 * section on every mounted doc — including hidden, scrolled ones. The Properties
 * section sits above the document body, so that resize would shift a hidden doc's
 * restored scroll position. That is compensated in `ScrollPreservingContainer`
 * (EditorActivityPool), which restores scroll relative to a body-top anchor, not
 * a raw pixel offset — so the live resize here is safe.
 */
import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'ok-properties-collapsed-v1';
const DEFAULT_COLLAPSED = false;

/** SSR- and privacy-mode-safe storage handle. Mirrors the other client stores. */
function getStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Lazy-loaded from storage on first read, then kept in memory as the source of
 *  truth for the session. */
let state: boolean | null = null;
const listeners = new Set<() => void>();

function load(): boolean {
  const storage = getStorage();
  if (!storage) return DEFAULT_COLLAPSED;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return DEFAULT_COLLAPSED;
  } catch {
    return DEFAULT_COLLAPSED;
  }
}

function ensureLoaded(): boolean {
  if (state === null) state = load();
  return state;
}

function persist(collapsed: boolean): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    // Store the value explicitly (not remove-on-open) so it stays unambiguous
    // if `DEFAULT_COLLAPSED` is ever flipped to closed.
    storage.setItem(STORAGE_KEY, collapsed ? 'true' : 'false');
  } catch {
    // quota / privacy mode — the in-memory state is still the source of truth.
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** Current collapsed state. Stable across reads until an actual change, so
 *  `useSyncExternalStore` does not churn. */
export function getPropertiesCollapsed(): boolean {
  return ensureLoaded();
}

export function setPropertiesCollapsed(collapsed: boolean): void {
  if (ensureLoaded() === collapsed) return;
  state = collapsed;
  persist(collapsed);
  notify();
}

export function subscribePropertiesCollapsed(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * `[collapsed, setCollapsed]` over the shared store. Every panel re-renders when
 * any panel toggles. `getServerSnapshot` returns the default so SSR / test
 * harnesses render the open state without touching storage.
 */
export function usePropertiesCollapsed(): readonly [boolean, (collapsed: boolean) => void] {
  const collapsed = useSyncExternalStore(
    subscribePropertiesCollapsed,
    getPropertiesCollapsed,
    () => DEFAULT_COLLAPSED,
  );
  return [collapsed, setPropertiesCollapsed] as const;
}

/** Test-only: drop the in-memory snapshot so the next read re-loads from
 *  storage. Production never calls this — the store is a session singleton. */
export function __resetPropertiesCollapsedForTests(): void {
  state = null;
  listeners.clear();
}
