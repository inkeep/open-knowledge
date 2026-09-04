import type { WorktreeSelectorModel } from '@inkeep/open-knowledge-core';

export interface WorktreeStore {
  getSnapshot(): WorktreeSelectorModel | null;
  subscribe(listener: () => void): () => void;
  refresh(): void;
}

interface WorktreeStoreDeps {
  fetchModel: () => Promise<WorktreeSelectorModel | null>;
  subscribeRevalidate?: (onRevalidate: () => void) => () => void;
}

export function createWorktreeStore(deps: WorktreeStoreDeps): WorktreeStore {
  let model: WorktreeSelectorModel | null = null;
  let bootstrapped = false;
  let inFlight = false;
  let reloadQueued = false;
  let revalidateUnsub: (() => void) | null = null;
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const listener of listeners) listener();
  }

  async function load(): Promise<void> {
    if (inFlight) {
      reloadQueued = true;
      return;
    }
    inFlight = true;
    try {
      const next = await deps.fetchModel();
      if (next !== null && next !== model) {
        model = next;
        emit();
      }
    } catch {
    } finally {
      inFlight = false;
      if (reloadQueued) {
        reloadQueued = false;
        void load();
      }
    }
  }

  return {
    getSnapshot: () => model,
    subscribe(listener) {
      listeners.add(listener);
      if (!bootstrapped) {
        bootstrapped = true;
        void load();
      }
      if (deps.subscribeRevalidate && revalidateUnsub === null) {
        revalidateUnsub = deps.subscribeRevalidate(() => {
          void load();
        });
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && revalidateUnsub !== null) {
          revalidateUnsub();
          revalidateUnsub = null;
        }
      };
    },
    refresh() {
      void load();
    },
  };
}

async function fetchWorktreeModel(): Promise<WorktreeSelectorModel | null> {
  const bridge = typeof window !== 'undefined' ? window.okDesktop : undefined;
  if (!bridge) return null;
  const result = await bridge.worktree.list();
  return result.ok ? result.model : null;
}

function subscribeBrowserRevalidate(onRevalidate: () => void): () => void {
  const handleResume = (): void => {
    if (document.visibilityState === 'visible') onRevalidate();
  };
  window.addEventListener('focus', handleResume);
  window.addEventListener('visibilitychange', handleResume);
  return () => {
    window.removeEventListener('focus', handleResume);
    window.removeEventListener('visibilitychange', handleResume);
  };
}

const productionStore: WorktreeStore =
  typeof window === 'undefined'
    ? { getSnapshot: () => null, subscribe: () => () => {}, refresh: () => {} }
    : createWorktreeStore({
        fetchModel: fetchWorktreeModel,
        subscribeRevalidate: subscribeBrowserRevalidate,
      });

export const subscribeToWorktrees = productionStore.subscribe;
export const getWorktreesSnapshot = productionStore.getSnapshot;
export const refreshWorktrees = productionStore.refresh;
