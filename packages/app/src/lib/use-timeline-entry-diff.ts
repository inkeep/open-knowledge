/**
 * `useTimelineEntryDiff` — data layer for the inline diff in the Timeline
 * tab's expanded entry rows. Mirrors the cache + cancellation shape of
 * `useActivityPanel`'s burst-diff fetch, but the diff is computed client-side
 * (no server endpoint synthesizes it). Two reference frames (see
 * `TimelineDiffMode`): `vs-parent` diffs the previous version against this one
 * (immutable audit), `vs-live` diffs this version against the live Y.Text WIP
 * (restore preview).
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
  | {
      status: 'ready';
      /** Unified-diff string (for the source view). Empty when the bodies match. */
      diff: string;
      additions: number;
      deletions: number;
      /**
       * Frontmatter-stripped bodies of both sides, for the rendered prose diff
       * (word-level). `before` is the parent/version content, `after` is this
       * version's content (vs-parent) or live Y.Text (vs-live). Equal when there
       * is no change — the prose view then renders `after` as the plain document.
       */
      before: string;
      after: string;
    };

/**
 * Count added/removed lines in a `diff.createPatch` unified-diff string. Lines
 * starting with a single `+`/`-` are changes; the `+++`/`---` file headers and
 * `@@` hunk headers are excluded. Cheap enough to run on expand — no server
 * round-trip, and the `+N −M` stat is only shown while a row is open.
 */
export function countDiffStat(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

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
  // Whole-file context: the patch includes every line so the diff renders the
  // full document with the change highlighted in place (the pane then scrolls
  // to the first change), rather than just the changed hunk.
  const context = Math.max(historical.split('\n').length, current.split('\n').length);
  return createPatch(docName, historical, current, '', '', { context });
}

/**
 * Which reference frame the diff compares against:
 *   - `vs-parent`: `content@parentSha` → `content@sha`. Both historical, so the
 *     diff is immutable and never drifts as the live doc changes — the honest
 *     "exactly what this version's author changed." When `parentSha` is null
 *     (first/oldest version), the parent side is empty (whole doc as additions).
 *   - `vs-live`: `content@sha` → live Y.Text. The "what a restore would undo"
 *     preview; the "after" side is mutable, so this is recomputed every run.
 */
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

    // Fetch a historical version's content by SHA, cached forever (historical
    // bytes never change). Shared by both the `sha` side and the vs-parent
    // `parentSha` side. Returns null on a non-ok response so the caller can
    // surface the error state.
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
          // Immutable audit diff: previous version → this version. Both sides
          // historical, so the result is stable and fully cacheable.
          const parentContent = parentSha ? await fetchHistoricalContent(parentSha) : '';
          if (cancelled) return;
          if (parentContent === null) {
            setResult({ status: 'error', diff: null });
            return;
          }
          beforeRaw = parentContent;
          afterRaw = shaContent;
        } else {
          // Restore preview: this version → live Y.Text. The "after" side is
          // mutable, so this branch is recomputed on every effect run.
          beforeRaw = shaContent;
          afterRaw = providerRef.current?.document.getText('source').toString() ?? '';
        }

        // Frontmatter-stripped bodies drive the rendered prose diff (word-level);
        // `computeTimelineDiff` stays the single source of the source-view patch.
        const before = stripFrontmatter(beforeRaw).body;
        const after = stripFrontmatter(afterRaw).body;
        const patchStr = computeTimelineDiff(beforeRaw, afterRaw, docName);
        if (cancelled) return;
        const { additions, deletions } = countDiffStat(patchStr);
        setResult({ status: 'ready', diff: patchStr, additions, deletions, before, after });
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
