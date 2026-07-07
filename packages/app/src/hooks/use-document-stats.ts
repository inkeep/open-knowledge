import type { HocuspocusProvider } from '@hocuspocus/provider';
import { useEffect, useState } from 'react';
import { computeBodyStats, type DocumentStats, EMPTY_STATS } from '@/lib/document-stats';

/**
 * Debounce window for recomputing stats. Observers fire on every Y.Text
 * transaction (local AND remote), so bounded rate is load-bearing during
 * agent writes / multi-client typing.
 */
const STATS_DEBOUNCE_MS = 300;

export function useDocumentStats(
  provider: HocuspocusProvider | null,
  activeDocName: string | null,
): DocumentStats {
  const [stats, setStats] = useState<DocumentStats>(EMPTY_STATS);

  useEffect(() => {
    if (!provider || !activeDocName) {
      setStats(EMPTY_STATS);
      return;
    }

    const ytext = provider.document.getText('source');
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    function compute() {
      if (cancelled) return;
      setStats(computeBodyStats(ytext.toString()));
    }

    compute();

    function handler() {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(compute, STATS_DEBOUNCE_MS);
    }

    ytext.observe(handler);

    return () => {
      cancelled = true;
      ytext.unobserve(handler);
      if (timeout) clearTimeout(timeout);
    };
  }, [provider, activeDocName]);

  return stats;
}
