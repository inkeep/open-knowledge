import { useEffect, useState } from 'react';

export interface RemoteModelCandidate {
  readonly value: string;
  readonly label: string;
  readonly contextChoices: readonly number[];
  readonly context: { readonly effectiveTokens: number; readonly origin: string } | null;
}

const cache = new Map<string, readonly RemoteModelCandidate[]>();

export function useModelCandidates(agentId: string | null): readonly RemoteModelCandidate[] {
  const [candidates, setCandidates] = useState<readonly RemoteModelCandidate[]>(() =>
    agentId === null ? [] : (cache.get(agentId) ?? []),
  );
  useEffect(() => {
    if (agentId === null) return;
    const cached = cache.get(agentId);
    if (cached !== undefined) {
      setCandidates(cached);
      return;
    }
    let cancelled = false;
    void fetch(`/api/acp/models?agent=${encodeURIComponent(agentId)}`)
      .then((res) => (res.ok ? res.json() : { candidates: [] }))
      .then((body: { candidates?: readonly RemoteModelCandidate[] }) => {
        const rows = body.candidates ?? [];
        cache.set(agentId, rows);
        if (!cancelled) setCandidates(rows);
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);
  return candidates;
}

export function contextChoicesForModel(
  candidates: readonly RemoteModelCandidate[],
  modelValue: string | null,
): readonly number[] {
  if (modelValue === null) return [];
  return candidates.find((candidate) => candidate.value === modelValue)?.contextChoices ?? [];
}
