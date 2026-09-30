import type { HocuspocusProvider } from '@hocuspocus/provider';
import { isEditableTextDocFile } from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';
import { type DocumentStats, EMPTY_STATS } from '@/lib/document-stats';
import { computeDocumentStats } from '@/lib/document-stats-runtime';

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
    const plain = isEditableTextDocFile(activeDocName);
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let dirty = false;

    function compute() {
      if (cancelled) return;
      if (inFlight) {
        dirty = true;
        return;
      }
      inFlight = true;
      computeDocumentStats(ytext.toString(), plain)
        .then((next) => {
          inFlight = false;
          if (cancelled) return;
          setStats(next);
          if (dirty) {
            dirty = false;
            compute();
          }
        })
        .catch((err: unknown) => {
          inFlight = false;
          console.warn('[document-stats] stats pass failed', err);
        });
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
