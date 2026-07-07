/**
 * Module-level cache of the current git branch reported by the server.
 *
 * Single fire-once `/api/server-info` fetch on first subscription, shared
 * across every `useCurrentBranch` consumer. Subsequent changes arrive via
 * the `branch-changed` window event (emitted by DocumentContext's branch
 * dispatchers on real switches). `null` = no git checkout, detached HEAD,
 * unreached fetch, or pre-bootstrap state.
 */
import { ServerInfoSuccessSchema } from '@inkeep/open-knowledge-core';
import { subscribeToBranchChanged } from '@/lib/documents-events';

export interface BranchStore {
  getSnapshot(): string | null;
  subscribe(listener: () => void): () => void;
}

interface BranchStoreDeps {
  /** Resolves the current branch on bootstrap. */
  fetchBranch: () => Promise<string | null>;
  /** Wire up event-driven updates. */
  subscribeToEvent: (cb: (branch: string | null) => void) => () => void;
}

export function createBranchStore(deps: BranchStoreDeps): BranchStore {
  let currentBranch: string | null = null;
  let bootstrapStarted = false;
  const listeners = new Set<() => void>();

  function setBranch(next: string | null): void {
    if (next === currentBranch) return;
    currentBranch = next;
    for (const listener of listeners) listener();
  }

  deps.subscribeToEvent(setBranch);

  async function bootstrap(): Promise<void> {
    if (bootstrapStarted) return;
    bootstrapStarted = true;
    try {
      const next = await deps.fetchBranch();
      setBranch(next);
    } catch {
      // Silent: the event channel will catch the value once SystemDocSubscriber
      // connects.
    }
  }

  return {
    getSnapshot: () => currentBranch,
    subscribe(listener) {
      listeners.add(listener);
      void bootstrap();
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

async function fetchCurrentBranch(): Promise<string | null> {
  const res = await fetch('/api/server-info', { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;
  const json = await res.json();
  const parsed = ServerInfoSuccessSchema.safeParse(json);
  if (!parsed.success) return null;
  return parsed.data.currentBranch ?? null;
}

const productionStore: BranchStore =
  typeof window === 'undefined'
    ? // SSR / non-browser: no event channel, no fetch. The hook still resolves
      // to `null` and consumers render their no-branch fallback.
      { getSnapshot: () => null, subscribe: () => () => {} }
    : createBranchStore({
        fetchBranch: fetchCurrentBranch,
        subscribeToEvent: subscribeToBranchChanged,
      });

export const subscribeToBranch = productionStore.subscribe;
export const getBranchSnapshot = productionStore.getSnapshot;
