import type { TextDirection } from '@inkeep/open-knowledge-core/i18n/direction';
import { useSyncExternalStore } from 'react';

export type EditorSidebarSide = 'start' | 'end';

// precedent #59: app-global by intent, a personal layout preference like the theme that follows the user into every project.
export const FILE_SIDEBAR_SIDE_KEY = 'ok-file-sidebar-side-v1';

export interface EditorSidebarSideStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface EditorSidebarSideStore {
  getSnapshot(): EditorSidebarSide;
  set(side: EditorSidebarSide): void;
  syncFromStorage(): void;
  subscribe(listener: () => void): () => void;
}

export function createEditorSidebarSideStore(
  key: string,
  fallback: EditorSidebarSide,
  storage: () => EditorSidebarSideStorage,
): EditorSidebarSideStore {
  const other: EditorSidebarSide = fallback === 'start' ? 'end' : 'start';
  const listeners = new Set<() => void>();
  let side: EditorSidebarSide | null = null;
  const read = (): EditorSidebarSide => {
    try {
      return storage().getItem(key) === other ? other : fallback;
    } catch {
      return fallback;
    }
  };
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot() {
      side ??= read();
      return side;
    },
    set(next) {
      side = next;
      try {
        storage().setItem(key, next);
      } catch {}
      notify();
    },
    syncFromStorage() {
      side = read();
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const fileSidebarSideStore = createEditorSidebarSideStore(
  FILE_SIDEBAR_SIDE_KEY,
  'start',
  () => localStorage,
);

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event.key === FILE_SIDEBAR_SIDE_KEY || event.key === null)
      fileSidebarSideStore.syncFromStorage();
  });
}

export function swapEditorSidebars(store: EditorSidebarSideStore = fileSidebarSideStore): void {
  store.set(store.getSnapshot() === 'start' ? 'end' : 'start');
}

export function physicalSide(side: EditorSidebarSide, direction: TextDirection): 'left' | 'right' {
  return (side === 'start') === (direction === 'ltr') ? 'left' : 'right';
}

export function documentPanelSide(fileSidebarSide: EditorSidebarSide): EditorSidebarSide {
  return fileSidebarSide === 'start' ? 'end' : 'start';
}

export function useFileSidebarSide(): EditorSidebarSide {
  return useSyncExternalStore(
    fileSidebarSideStore.subscribe,
    fileSidebarSideStore.getSnapshot,
    () => 'start',
  );
}
