/**
 * Hook for reactively reading a doc's `lifecycle.status` from its Y.Doc.
 *
 * Looks up the pool entry for `docName`, subscribes to that doc's
 * `Y.Map('lifecycle')` change events, and re-renders on every update.
 * Drives the editor-area conditional swap between the editor children and
 * `<DiffViewBoundary>`.
 *
 * Returns:
 *   - `'conflict'` when the doc's `lifecycle.status` is the string
 *     `'conflict'` (the only value the swap gate recognizes).
 *   - `null` when the status is unset OR the doc has no loaded provider in
 *     the pool (e.g., the doc is not currently open). Callers treat `null`
 *     as "fall back to the default editor branch."
 *
 * Mirrors the subscription pattern of `useGitSyncStatus` (event-driven
 * re-render via React state) but reads from a per-doc Y.Map instead of a
 * CC1-pushed JSON status.
 */
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { useEffect, useState } from 'react';
import { useDocumentContext } from '@/editor/DocumentContext';

type LifecycleStatus = 'conflict' | null;

function readStatus(provider: HocuspocusProvider | null): LifecycleStatus {
  if (!provider) return null;
  const raw = provider.document.getMap('lifecycle').get('status');
  return raw === 'conflict' ? 'conflict' : null;
}

export function useLifecycleStatus(docName: string | null): LifecycleStatus {
  const { poolEntries } = useDocumentContext();
  const entry = docName ? (poolEntries.find((e) => e.docName === docName) ?? null) : null;
  // Subscribe by provider identity (stable across pool-snapshot churn —
  // `takeSnapshot` allocates a fresh entry wrapper per call but reuses the
  // underlying provider). Without this we'd unobserve/observe on every
  // unrelated pool-state mutation (lastAccessedAt updates, MRU re-sorts).
  const provider = entry?.provider ?? null;
  const [status, setStatus] = useState<LifecycleStatus>(() => readStatus(provider));

  useEffect(() => {
    if (!provider) {
      setStatus(null);
      return;
    }
    const lifecycleMap = provider.document.getMap('lifecycle');
    setStatus(readStatus(provider));
    const onChange = () => setStatus(readStatus(provider));
    lifecycleMap.observe(onChange);
    return () => {
      lifecycleMap.unobserve(onChange);
    };
  }, [provider]);

  return status;
}
