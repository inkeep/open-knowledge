/**
 * `useTimelineEntryDiff` — data layer for the inline diff in the Timeline
 * tab's expanded entry rows. Mirrors the cache + cancellation shape of
 * `useActivityPanel`'s burst-diff fetch, but the diff is computed client-side
 * (no server endpoint synthesizes it) so the live Y.Text WIP is part of the
 * comparison.
 *
 * Responsibilities:
 *   1. On `sha` set: fetch `GET /api/history/<sha>?docName=<>`. Cache the
 *      response.content keyed by `${docName}\u0000${sha}` — sha alone is not
 *      sufficient: an upstream-import commit can touch many files and the
 *      same sha appears across multiple docs' timelines with different
 *      bodies.
 *   2. Snapshot `current` from `activeProvider.document.getText('source')`
 *      once at the moment the effect fires (when the user expands a row).
 *      The provider is read via a ref, NOT the effect's deps array, so a
 *      provider-identity churn (reconnect, server-instance-mismatch
 *      recovery) does not silently re-snapshot mid-view. Strip frontmatter
 *      from both sides; if the bodies match exactly, surface an empty diff
 *      string so the renderer's "No changes" placeholder fires. Otherwise
 *      compute the unified diff via
 *      `diff.createPatch(docName, historical, current, '', '', { context: 3 })`.
 *      The diff is recomputed every effect run — never cached, because the
 *      `current` side is mutable.
 *   3. Cancellation: an in-flight fetch that completes after `sha` swapped
 *      or the host component unmounted must not produce stale state.
 *
 * Inert mode: `sha === null` → no fetch, `{ diff: null, status: 'idle' }`.
 *
 * Cache scope: `LruStringCache` is owned by `TimelineContent` (via `useState`
 * initializer) and passed in. The composite cache key keeps entries
 * partitioned per docName, so even if `TimelineContent` survives doc-to-doc
 * navigation (no `key={docName}` on the parent today), a hit is always for
 * the right document.
 */
import { stripFrontmatter } from '@inkeep/open-knowledge-core';
import { createPatch } from 'diff';
import { useEffect, useRef, useState } from 'react';
import { useDocumentContext } from '@/editor/DocumentContext';
import type { LruStringCache } from '@/lib/lru-string-cache';

export const HISTORICAL_CONTENT_CACHE_LIMIT = 32;

type UseTimelineEntryDiffResult =
  | { status: 'idle'; diff: null }
  | { status: 'loading'; diff: null }
  | { status: 'error'; diff: null }
  | { status: 'ready'; diff: string };

/**
 * Composite cache key format for `LruStringCache`. Exported for unit tests
 * + TimelineContent consumers that want to manipulate cache entries directly.
 */
export function timelineEntryCacheKey(docName: string, sha: string): string {
  return `${docName}\u0000${sha}`;
}

/**
 * Pure function: compute the inline-diff string from raw historical content
 * and raw current content. Strips frontmatter from both sides and either
 * returns `''` (bodies match — caller should render the "No changes"
 * placeholder) or the unified-diff string from `diff.createPatch`.
 *
 * Exported for unit tests; the hook below is the only production caller.
 */
export function computeTimelineDiff(
  historicalRaw: string,
  currentRaw: string,
  docName: string,
): string {
  const historical = stripFrontmatter(historicalRaw).body;
  const current = stripFrontmatter(currentRaw).body;
  if (historical === current) return '';
  return createPatch(docName, historical, current, '', '', { context: 3 });
}

export function useTimelineEntryDiff(
  sha: string | null,
  docName: string,
  cache: LruStringCache,
): UseTimelineEntryDiffResult {
  const { activeProvider } = useDocumentContext();
  const [result, setResult] = useState<UseTimelineEntryDiffResult>({ status: 'idle', diff: null });

  // Provider identity churns on reconnect / instance-mismatch recovery.
  // Snapshotting via a ref keeps the diff stable while the row is expanded.
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

    async function run() {
      try {
        const key = timelineEntryCacheKey(docName, activeSha);
        let historicalRaw = cache.get(key);
        if (historicalRaw === undefined) {
          const res = await fetch(
            `/api/history/${activeSha}?docName=${encodeURIComponent(docName)}`,
          );
          if (cancelled) return;
          if (!res.ok) {
            setResult({ status: 'error', diff: null });
            return;
          }
          const body = (await res.json()) as { content?: string };
          if (cancelled) return;
          historicalRaw = body.content ?? '';
          cache.set(key, historicalRaw);
        }

        if (cancelled) return;

        const currentRaw = providerRef.current?.document.getText('source').toString() ?? '';
        const patchStr = computeTimelineDiff(historicalRaw, currentRaw, docName);

        if (cancelled) return;
        setResult({ status: 'ready', diff: patchStr });
      } catch (err) {
        if (!cancelled) {
          console.error('[timeline-diff] failed to load entry diff', {
            sha: activeSha,
            docName,
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
  }, [sha, docName, cache]);

  return result;
}
