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

export function useConflicts(): {
  conflicts: ConflictEntryWire[];
  loading: boolean;
  error: ConflictsFetchError | null;
} {
  const [conflicts, setConflicts] = useState<ConflictEntryWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ConflictsFetchError | null>(null);
  const latestRequestId = useRef(0);

  function refresh() {
    const requestId = ++latestRequestId.current;
    void fetchConflicts().then(({ conflicts: list, error: err }) => {
      if (requestId !== latestRequestId.current) return;
      if (err === undefined) setConflicts(list);
      setError(err ?? null);
      setLoading(false);
    });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is intentionally stable (defined in hook scope)
  useEffect(() => {
    refresh();
  }, []);

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
