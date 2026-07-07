/**
 * Hook for the read-only semantic-search setup/coverage probe in Settings →
 * Search.
 *
 * Fetches `GET /api/semantic-status` (network-free on the server — it only
 * reports the resolved config + warmed cache state, never embeds) on mount and
 * on a CC1 `files` push. The server reacts to a runtime `search.semantic.enabled`
 * toggle through the project-local config file-watcher, so the panel becomes
 * accurate once the persistence debounce settles — call {@link refresh} after a
 * toggle to pull the updated state without waiting for the next `files` signal.
 *
 * Returns null until the first response arrives (and on any fetch failure — the
 * Switch reflects the synchronous CRDT preference regardless, so a missing
 * coverage panel degrades gracefully).
 *
 * Pass `{ enabled: false }` to suspend probing (mount fetch + `files`-push
 * refresh). The omnibar uses this to probe only while open — it is always
 * mounted, so an unconditional hook would re-probe on every file change for the
 * whole session. The last snapshot is retained while suspended, so re-enabling
 * shows it instantly (no flash) before the refresh lands. Defaults to enabled.
 */
import type { SemanticIndexStatus } from '@inkeep/open-knowledge-core';
import { useEffect, useState } from 'react';
import { subscribeToDocumentsChanged } from '@/lib/documents-events';

async function fetchSemanticStatus(): Promise<SemanticIndexStatus | null> {
  try {
    const res = await fetch('/api/semantic-status');
    if (!res.ok) {
      // Non-2xx: the coverage panel degrades to hidden. Debug-level — this is a
      // non-critical read; surface it for diagnosis without alarming the user.
      console.debug('[semantic-status] probe returned', res.status);
      return null;
    }
    return (await res.json()) as SemanticIndexStatus;
  } catch (err) {
    console.debug('[semantic-status] probe failed', err);
    return null;
  }
}

interface UseSemanticSearchStatusResult {
  status: SemanticIndexStatus | null;
  refresh: () => void;
}

export function useSemanticSearchStatus(
  options: { enabled?: boolean } = {},
): UseSemanticSearchStatusResult {
  const enabled = options.enabled ?? true;
  const [status, setStatus] = useState<SemanticIndexStatus | null>(null);

  function refresh() {
    if (!enabled) return;
    void fetchSemanticStatus().then((next) => {
      // Keep the last good snapshot on a transient failure rather than
      // blanking the panel — `fetchSemanticStatus` already maps errors to null.
      if (next) setStatus(next);
    });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is stable in component scope; re-run only when `enabled` flips on.
  useEffect(() => {
    refresh();
  }, [enabled]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is stable in component scope.
  useEffect(() => {
    if (!enabled) return;
    return subscribeToDocumentsChanged((channels) => {
      if (channels.includes('files')) refresh();
    });
  }, [enabled]);

  return { status, refresh };
}
