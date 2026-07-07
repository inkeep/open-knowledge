/**
 * Cached, non-blocking store for the current window's worktree model. A desktop
 * window is pinned to one project for its lifetime, so a single module-level
 * cache is correct (no per-project key).
 *
 * Shared by every worktree surface — the ProjectSwitcher submenu, the command
 * palette, and the switcher search — so the git-backed `worktree.list()` fetch
 * runs once and every consumer reads the same snapshot via `useSyncExternalStore`.
 * First subscription kicks off the fetch; the cached model is returned
 * synchronously thereafter, so rendering never blocks and repeat opens are
 * instant. `refresh()` re-fetches after a worktree is created (the topology
 * changed). A failed fetch keeps the prior cache rather than clearing it.
 *
 * Consumers render from the (possibly `null`) snapshot into a stable region, so
 * the async arrival fills that region without reflowing the primary list.
 */

import type { WorktreeSelectorModel } from '@inkeep/open-knowledge-core';

export interface WorktreeStore {
  getSnapshot(): WorktreeSelectorModel | null;
  subscribe(listener: () => void): () => void;
  /** Re-fetch (e.g. after creating a worktree). No-op if a fetch is in flight. */
  refresh(): void;
}

interface WorktreeStoreDeps {
  /** Resolves the current window's worktree model, or `null` when unavailable. */
  fetchModel: () => Promise<WorktreeSelectorModel | null>;
}

export function createWorktreeStore(deps: WorktreeStoreDeps): WorktreeStore {
  let model: WorktreeSelectorModel | null = null;
  let bootstrapped = false;
  let inFlight = false;
  // A refresh() that arrives mid-flight (e.g. worktree.create resolves before
  // the bootstrap load settles) is coalesced into one follow-up load rather than
  // dropped — otherwise a just-created worktree could miss the current window's
  // cache until remount.
  let reloadQueued = false;
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
      // Keep the prior cache on a null/failed result rather than blanking the
      // UI — a transient IPC hiccup shouldn't wipe a good list.
      if (next !== null && next !== model) {
        model = next;
        emit();
      }
    } catch {
      // Silent: consumers keep the last-known snapshot.
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
      return () => {
        listeners.delete(listener);
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

const productionStore: WorktreeStore =
  typeof window === 'undefined'
    ? // SSR / non-browser: nothing to fetch. Consumers render their empty state.
      { getSnapshot: () => null, subscribe: () => () => {}, refresh: () => {} }
    : createWorktreeStore({ fetchModel: fetchWorktreeModel });

export const subscribeToWorktrees = productionStore.subscribe;
export const getWorktreesSnapshot = productionStore.getSnapshot;
export const refreshWorktrees = productionStore.refresh;
