import type { TextDirection } from '@inkeep/open-knowledge-core/i18n/direction';
import { useSyncExternalStore } from 'react';
import { currentDocumentDirection } from './use-document-direction';

export type LogicalSide = 'start' | 'end';
export type PhysicalSide = 'left' | 'right';

// precedent #59: app-global by intent, personal layout preferences like the theme that follow the user into every project.
export const FILE_SIDEBAR_SIDE_KEY = 'ok-file-sidebar-side-v1';
export const CHAT_HISTORY_SIDE_KEY = 'ok-chat-history-side-v1';

export interface SidebarSideStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SidebarSideStore {
  getSnapshot(): LogicalSide;
  set(side: LogicalSide): void;
  syncFromStorage(): void;
  subscribe(listener: () => void): () => void;
}

export function createSidebarSideStore(
  key: string,
  fallback: LogicalSide,
  storage: () => SidebarSideStorage,
): SidebarSideStore {
  const other: LogicalSide = fallback === 'start' ? 'end' : 'start';
  const listeners = new Set<() => void>();
  let side: LogicalSide | null = null;
  const read = (): LogicalSide => {
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

const fileSidebarSideStore = createSidebarSideStore(
  FILE_SIDEBAR_SIDE_KEY,
  'start',
  () => localStorage,
);
const chatHistorySideStore = createSidebarSideStore(
  CHAT_HISTORY_SIDE_KEY,
  'end',
  () => localStorage,
);

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event.key === FILE_SIDEBAR_SIDE_KEY || event.key === null)
      fileSidebarSideStore.syncFromStorage();
    if (event.key === CHAT_HISTORY_SIDE_KEY || event.key === null)
      chatHistorySideStore.syncFromStorage();
  });
}

export function swapEditorSidebars(store: SidebarSideStore = fileSidebarSideStore): void {
  store.set(store.getSnapshot() === 'start' ? 'end' : 'start');
}

export function moveChatHistory(
  physical: PhysicalSide,
  direction: TextDirection = currentDocumentDirection(),
  store: SidebarSideStore = chatHistorySideStore,
): void {
  store.set(physicalSide('start', direction) === physical ? 'start' : 'end');
}

export function physicalSide(side: LogicalSide, direction: TextDirection): PhysicalSide {
  return (side === 'start') === (direction === 'ltr') ? 'left' : 'right';
}

export function documentPanelSide(fileSidebarSide: LogicalSide): LogicalSide {
  return fileSidebarSide === 'start' ? 'end' : 'start';
}

export function useFileSidebarSide(): LogicalSide {
  return useSyncExternalStore(
    fileSidebarSideStore.subscribe,
    fileSidebarSideStore.getSnapshot,
    () => 'start',
  );
}

export function useChatHistorySide(): LogicalSide {
  return useSyncExternalStore(
    chatHistorySideStore.subscribe,
    chatHistorySideStore.getSnapshot,
    () => 'end',
  );
}
