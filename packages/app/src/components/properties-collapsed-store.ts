import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'ok-properties-collapsed-v1';
const DEFAULT_COLLAPSED = false;

function getStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

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
    storage.setItem(STORAGE_KEY, collapsed ? 'true' : 'false');
  } catch {}
}

function notify(): void {
  for (const listener of listeners) listener();
}

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

export function usePropertiesCollapsed(): readonly [boolean, (collapsed: boolean) => void] {
  const collapsed = useSyncExternalStore(
    subscribePropertiesCollapsed,
    getPropertiesCollapsed,
    () => DEFAULT_COLLAPSED,
  );
  return [collapsed, setPropertiesCollapsed] as const;
}

export function __resetPropertiesCollapsedForTests(): void {
  state = null;
  listeners.clear();
}
