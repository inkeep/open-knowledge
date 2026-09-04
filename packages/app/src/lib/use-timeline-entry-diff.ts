import {
  diffFrontmatter,
  type FrontmatterDelta,
  stripFrontmatter,
} from '@inkeep/open-knowledge-core';
import { createPatch } from 'diff';
import { useEffect, useRef, useState } from 'react';
import { useDocumentContext } from '@/editor/DocumentContext';
import type { LruStringCache } from '@/lib/lru-string-cache';

export const HISTORICAL_CONTENT_CACHE_LIMIT = 32;

type UseTimelineEntryDiffResult =
  | { status: 'idle'; diff: null }
  | { status: 'loading'; diff: null }
  | { status: 'error'; diff: null }
  | {
      status: 'ready';
      diff: string;
      additions: number;
      deletions: number;
      before: string;
      after: string;
      properties: FrontmatterDelta;
    };

export function countDiffStat(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

export function timelineEntryCacheKey(docName: string, sha: string): string {
  return `${docName}\u0000${sha}`;
}

export function computeTimelineDiff(
  historicalRaw: string,
  currentRaw: string,
  docName: string,
): string {
  const historical = stripFrontmatter(historicalRaw).body;
  const current = stripFrontmatter(currentRaw).body;
  if (historical === current) return '';
  const context = Math.max(historical.split('\n').length, current.split('\n').length);
  return createPatch(docName, historical, current, '', '', { context });
}

export type TimelineDiffMode = 'vs-parent' | 'vs-live';

export function useTimelineEntryDiff(
  sha: string | null,
  docName: string,
  cache: LruStringCache,
  mode: TimelineDiffMode = 'vs-live',
  parentSha: string | null = null,
): UseTimelineEntryDiffResult {
  const { activeProvider } = useDocumentContext();
  const [result, setResult] = useState<UseTimelineEntryDiffResult>({ status: 'idle', diff: null });

  const providerRef = useRef(activeProvider);
  useEffect(() => {
    providerRef.current = activeProvider;
  });

  useEffect(() => {
    if (!sha) {
      setResult({ status: 'idle', diff: null });
      return;
    }

    const activeSha = sha;
    let cancelled = false;
    setResult({ status: 'loading', diff: null });

    async function fetchHistoricalContent(versionSha: string): Promise<string | null> {
      const key = timelineEntryCacheKey(docName, versionSha);
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const res = await fetch(`/api/history/${versionSha}?docName=${encodeURIComponent(docName)}`);
      if (!res.ok) {
        console.error('[timeline-diff] history fetch returned non-ok response', {
          sha: versionSha,
          docName,
          status: res.status,
        });
        return null;
      }
      const body = (await res.json()) as { content?: string };
      const content = body.content ?? '';
      cache.set(key, content);
      return content;
    }

    async function run() {
      try {
        const shaContent = await fetchHistoricalContent(activeSha);
        if (cancelled) return;
        if (shaContent === null) {
          setResult({ status: 'error', diff: null });
          return;
        }

        let beforeRaw: string;
        let afterRaw: string;
        if (mode === 'vs-parent') {
          const parentContent = parentSha ? await fetchHistoricalContent(parentSha) : '';
          if (cancelled) return;
          if (parentContent === null) {
            setResult({ status: 'error', diff: null });
            return;
          }
          beforeRaw = parentContent;
          afterRaw = shaContent;
        } else {
          beforeRaw = shaContent;
          afterRaw = providerRef.current?.document.getText('source').toString() ?? '';
        }

        const before = stripFrontmatter(beforeRaw).body;
        const after = stripFrontmatter(afterRaw).body;
        const patchStr = computeTimelineDiff(beforeRaw, afterRaw, docName);
        const properties = diffFrontmatter(beforeRaw, afterRaw);
        if (cancelled) return;
        const { additions, deletions } = countDiffStat(patchStr);
        setResult({
          status: 'ready',
          diff: patchStr,
          additions,
          deletions,
          before,
          after,
          properties,
        });
      } catch (err) {
        if (!cancelled) {
          console.error('[timeline-diff] failed to load entry diff', {
            sha: activeSha,
            docName,
            mode,
            err,
          });
          setResult({ status: 'error', diff: null });
        }
      }
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [sha, docName, cache, mode, parentSha]);

  return result;
}
