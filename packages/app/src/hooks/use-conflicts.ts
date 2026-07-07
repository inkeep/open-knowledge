/**
 * Hook for subscribing to the project-level conflict list via CC1
 * `sync-status` channel.
 *
 * Fetches `GET /api/sync/conflicts` on mount and whenever the server emits a
 * `ch:'sync-status'` CC1 signal (the same trigger {@link useGitSyncStatus}
 * subscribes to). Backs the sidebar Conflicts section + acts as the single
 * source of truth that converges with the topbar `SyncStatusBadge`'s
 * `conflictCount` field (both come from the same server state — the
 * `/api/sync/status` endpoint computes its `conflictCount` from
 * `<contentDir>/.ok/conflicts.json` and `/api/sync/conflicts` reads the same
 * file; CC1 `sync-status` invalidates both in lockstep).
 *
 * Tab-badge counts come from per-doc `useLifecycleStatus(tab.docName)`
 * readings (live CRDT state). The CRDT lifecycle gets pushed by the server's
 * file-watcher / reconciliation path on the same edges that flip
 * `conflicts.json`; the two propagation paths are independent but converge
 * in steady state. A brief mismatch window can exist between the moment
 * `conflicts.json` is written and the per-doc Y.Map `lifecycle.status`
 * propagates to the client — it closes inside one provider sync round-trip.
 */
import type { ConflictEntryWire } from '@inkeep/open-knowledge-core';
import { useEffect, useRef, useState } from 'react';
import { subscribeToDocumentsChanged } from '@/lib/documents-events';

type ConflictsFetchError = 'network' | 'server';

interface ConflictsFetchResult {
  conflicts: ConflictEntryWire[];
  error?: ConflictsFetchError;
}

async function fetchConflicts(): Promise<ConflictsFetchResult> {
  try {
    const res = await fetch('/api/sync/conflicts');
    if (!res.ok) {
      console.warn(
        JSON.stringify({
          event: 'conflicts-fetch-failed',
          status: res.status,
        }),
      );
      return { conflicts: [], error: 'server' };
    }
    const data = (await res.json()) as { conflicts?: ConflictEntryWire[] };
    return { conflicts: data.conflicts ?? [] };
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: 'conflicts-fetch-failed',
        status: null,
        detail: err instanceof Error ? err.message : String(err),
      }),
    );
    return { conflicts: [], error: 'network' };
  }
}

/**
 * Tracks the conflict list via initial fetch + CC1 `sync-status` re-fetch.
 * `loading` is `true` until the first response (success OR failure) arrives.
 */
export function useConflicts(): {
  conflicts: ConflictEntryWire[];
  loading: boolean;
  error: ConflictsFetchError | null;
} {
  const [conflicts, setConflicts] = useState<ConflictEntryWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ConflictsFetchError | null>(null);
  // Monotonic request ID: the mount fetch and any CC1-triggered re-fetch
  // run concurrently. When two are in flight, only the most-recently-
  // dispatched response wins — earlier (stale) responses are discarded.
  // Without this, a CC1 refresh that fires immediately after mount could
  // resolve first and then be overwritten by the slower initial fetch.
  const latestRequestId = useRef(0);

  function refresh() {
    const requestId = ++latestRequestId.current;
    void fetchConflicts().then(({ conflicts: list, error: err }) => {
      if (requestId !== latestRequestId.current) return;
      setConflicts(list);
      setError(err ?? null);
      setLoading(false);
    });
  }

  // Initial fetch on mount
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is intentionally stable (defined in hook scope)
  useEffect(() => {
    refresh();
  }, []);

  // Re-fetch on CC1 sync-status signal — same invalidation the
  // useGitSyncStatus hook subscribes to, so the two converge in steady state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is intentionally stable (defined in hook scope)
  useEffect(() => {
    return subscribeToDocumentsChanged((channels) => {
      if (channels.includes('sync-status')) {
        refresh();
      }
    });
  }, []);

  return { conflicts, loading, error };
}
