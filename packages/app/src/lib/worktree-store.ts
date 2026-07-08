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
 * instant. `refresh()` re-fetches after an in-app worktree create (the topology
 * changed). A failed fetch keeps the prior cache rather than clearing it.
 *
 * Out-of-band topology changes — a `git worktree add` in a terminal, or a
 * create in ANOTHER OK window (a separate BrowserWindow, hence a separate
 * module instance with its own cache) — never call `refresh()` here, so the
 * cache would otherwise stay frozen for the window's lifetime (the "new worktree
 * only shows after a restart" bug). `subscribeRevalidate` closes that gap: it
 * re-fetches on window focus / tab-visible, the same reactive signal
 * `PageListContext` / `FileTree` / `GraphView` use to recover from stale list
 * data. There's no cheap push for git worktree topology, so focus/visibility is
 * the proportionate invalidation trigger.
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
  /**
   * Register an external revalidation trigger — invoked whenever a signal
   * suggests the git worktree topology may have changed out-of-band (window
   * regains focus, tab becomes visible). Each call re-fetches the model.
   * Returns an unsubscribe. Wired to the subscriber lifecycle: attached when the
   * first consumer subscribes, detached when the last unsubscribes, so it never
   * fires — or leaks a listener — while nothing is mounted. Optional (omitted in
   * SSR and in tests that don't exercise revalidation).
   */
  subscribeRevalidate?: (onRevalidate: () => void) => () => void;
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
  // Live only while at least one consumer is subscribed — ref-counted off
  // `listeners` so a focus event never re-fetches (or holds a DOM listener)
  // while the store is unmounted.
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
      // Attach the revalidation trigger on the first live subscriber. `load()`'s
      // in-flight coalescing bounds a burst of focus events to at most one
      // follow-up fetch, so no throttle is needed here.
      if (deps.subscribeRevalidate && revalidateUnsub === null) {
        revalidateUnsub = deps.subscribeRevalidate(() => {
          void load();
        });
      }
      return () => {
        listeners.delete(listener);
        // Detach when the last subscriber leaves so the DOM listener can't
        // outlive the store's consumers.
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

/**
 * Browser revalidation trigger: re-fetch when the window regains focus or the
 * tab becomes visible — the moment a worktree created out-of-band (a terminal
 * `git worktree add`, or another OK window) should surface without an app
 * restart. Mirrors the focus/visibilitychange revalidation in `PageListContext`
 * / `FileTree` / `GraphView`. The `visibilityState === 'visible'` gate drops the
 * hide half of `visibilitychange` (only re-fetch on show), and `visibilitychange`
 * is attached on `window` (it bubbles up from `document`) to match those callers.
 */
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
    ? // SSR / non-browser: nothing to fetch. Consumers render their empty state.
      { getSnapshot: () => null, subscribe: () => () => {}, refresh: () => {} }
    : createWorktreeStore({
        fetchModel: fetchWorktreeModel,
        subscribeRevalidate: subscribeBrowserRevalidate,
      });

export const subscribeToWorktrees = productionStore.subscribe;
export const getWorktreesSnapshot = productionStore.getSnapshot;
export const refreshWorktrees = productionStore.refresh;
