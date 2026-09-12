import { type SemanticIndexStatus, SemanticIndexStatusSchema } from '@inkeep/open-knowledge-core';
import { useEffect, useReducer, useRef } from 'react';
import { COMMAND_PALETTE_SEARCH_TIMEOUT_MS } from '@/components/command-palette-semantic';
import { subscribeToDocumentsChanged } from '@/lib/documents-events';

const SEMANTIC_STATUS_RETRY_BASE_MS = 2500;
const SEMANTIC_STATUS_RETRY_MAX_MS = 30_000;

type SemanticStatusProbeResult =
  | { kind: 'success'; status: SemanticIndexStatus }
  | { kind: 'invalid' }
  | { kind: 'unavailable' };

async function fetchSemanticStatus(
  options: { warnOnFailure?: boolean } = {},
): Promise<SemanticStatusProbeResult> {
  const warnOnFailure = options.warnOnFailure ?? true;
  try {
    const res = await fetch('/api/semantic-status', {
      signal: AbortSignal.timeout(COMMAND_PALETTE_SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      if (warnOnFailure) console.warn('[semantic-status] probe returned', res.status);
      return { kind: 'unavailable' };
    }
    const parsed = SemanticIndexStatusSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn('[semantic-status] probe returned an invalid payload');
      return { kind: 'invalid' };
    }
    return { kind: 'success', status: parsed.data };
  } catch (err) {
    if (warnOnFailure) console.warn('[semantic-status] probe failed', err);
    return { kind: 'unavailable' };
  }
}

interface UseSemanticSearchStatusResult {
  status: SemanticIndexStatus | null;
  stale: boolean;
  refresh: () => void;
}

interface SemanticStatusState {
  status: SemanticIndexStatus | null;
  stale: boolean;
}

function applyProbeResult(
  state: SemanticStatusState,
  result: SemanticStatusProbeResult,
): SemanticStatusState {
  if (result.kind === 'success') return { status: result.status, stale: false };
  if (result.kind === 'invalid') return { status: null, stale: false };
  return state.stale ? state : { ...state, stale: true };
}

export function useSemanticSearchStatus(
  options: { enabled?: boolean; retryUnavailable?: boolean } = {},
): UseSemanticSearchStatusResult {
  const enabled = options.enabled ?? true;
  const retryUnavailable = options.retryUnavailable ?? true;
  const [state, dispatch] = useReducer(applyProbeResult, { status: null, stale: false });
  const latestProbeId = useRef(0);

  function refresh() {
    if (!enabled) return;
    const probeId = ++latestProbeId.current;
    void fetchSemanticStatus().then((result) => {
      if (probeId === latestProbeId.current) dispatch(result);
    });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is stable in component scope; re-run only when `enabled` flips on.
  useEffect(() => {
    refresh();
    return () => {
      latestProbeId.current += 1;
    };
  }, [enabled]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh is stable in component scope.
  useEffect(() => {
    if (!enabled) return;
    return subscribeToDocumentsChanged((channels) => {
      if (channels.includes('files')) refresh();
    });
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !retryUnavailable || !state.stale) return;
    let ignore = false;
    let id: number | null = null;
    let attemptCount = 0;
    const attempt = () => {
      const delay = Math.min(
        SEMANTIC_STATUS_RETRY_BASE_MS * 2 ** attemptCount,
        SEMANTIC_STATUS_RETRY_MAX_MS,
      );
      id = window.setTimeout(() => {
        const probeId = ++latestProbeId.current;
        void fetchSemanticStatus({ warnOnFailure: false }).then((result) => {
          if (ignore) return;
          if (probeId !== latestProbeId.current) {
            attempt();
            return;
          }
          dispatch(result);
          if (result.kind === 'unavailable') {
            attemptCount += 1;
            attempt();
          }
        });
      }, delay);
    };
    attempt();
    return () => {
      ignore = true;
      if (id !== null) window.clearTimeout(id);
    };
  }, [enabled, retryUnavailable, state.stale]);

  return { status: state.status, stale: state.stale, refresh };
}
