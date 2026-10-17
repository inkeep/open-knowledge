import type { HocuspocusProvider } from '@hocuspocus/provider';
import { isEditableTextDocFile } from '@inkeep/open-knowledge-core/constants/code-languages';
import { useEffect, useState } from 'react';
import type { Text as YText } from 'yjs';
import {
  computeBodyStats,
  computePlainTextStats,
  type DocumentStats,
  EMPTY_STATS,
} from '@/lib/document-stats';

const STATS_DEBOUNCE_MS = 300;
const statsCache = new WeakMap<
  YText,
  { source: string; plainText: boolean; stats: DocumentStats }
>();

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
    const plainText = isEditableTextDocFile(activeDocName);
    const computeStats = plainText ? computePlainTextStats : computeBodyStats;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    function compute() {
      if (cancelled) return;
      const source = ytext.toString();
      const cached = statsCache.get(ytext);
      if (cached?.source === source && cached.plainText === plainText) {
        setStats(cached.stats);
      } else {
        const nextStats = computeStats(source);
        statsCache.set(ytext, { source, plainText, stats: nextStats });
        setStats(nextStats);
      }
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
