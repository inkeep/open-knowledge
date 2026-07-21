/**
 * Fetch the ACP agent catalog from the server (`GET /api/acp/catalog`) — the
 * registry-driven list the launch UI renders. The server owns the CDN fetch +
 * offline cache; the client just consumes the resolved rows.
 */

import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { hydrateRegisteredAgentMeta } from './registered-agents';

export interface CatalogAgent {
  id: string;
  name: string;
  version: string;
  description?: string;
  license?: string;
  iconUrl?: string;
  website?: string;
  source: 'registry' | 'custom';
  /** A launchable distribution exists for this host platform. */
  supported: boolean;
  featured: boolean;
  harness?: {
    cli: 'claude' | 'codex' | 'cursor' | 'opencode' | 'pi';
    availability: 'present' | 'not-found' | 'unknown';
  };
}

/** Registry agents whose corresponding first-party CLI is on the server host. */
export function detectedHarnessAgents(agents: readonly CatalogAgent[]): CatalogAgent[] {
  const priority = ['claude-acp', 'codex-acp', 'cursor', 'opencode'];
  // `indexOf` returns -1 for an id not in the priority list; map that to the end
  // so an unranked agent sorts AFTER the known first-party ones, not before them.
  const rank = (id: string): number => {
    const i = priority.indexOf(id);
    return i === -1 ? priority.length : i;
  };
  return agents
    .filter((agent) => agent.supported && agent.harness?.availability === 'present')
    .sort((a, b) => rank(a.id) - rank(b.id));
}

export interface AgentCatalog {
  agents: CatalogAgent[];
  /** True when the server served its offline fallback cache. */
  stale: boolean;
  maxThreads: number;
}

export async function fetchAgentCatalog(signal?: AbortSignal): Promise<AgentCatalog> {
  const res = await fetch('/api/acp/catalog', {
    signal: signal ?? AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`agent catalog request failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as AgentCatalog;
  return {
    agents: Array.isArray(body.agents) ? body.agents : [],
    stale: body.stale === true,
    maxThreads: typeof body.maxThreads === 'number' ? body.maxThreads : 8,
  };
}

/**
 * Fill in registered agents' real display names + brand icons from the registry
 * catalog. A freshly registered agent (from a launcher pick or a Configure
 * agents toggle) ships ids + names only, so every launcher menu renders a
 * neutral glyph until this runs.
 *
 * Mount once high in the app tree so hydration happens on cold start regardless
 * of whether the user ever opens Configure agents. Shares the `['acp-catalog']`
 * query cache with that settings tab (React Query dedups by key — no double
 * fetch), and only patches metadata in place, never the launch default.
 */
export function useHydrateRegisteredAgentMeta(): void {
  const { data } = useQuery({
    queryKey: ['acp-catalog'],
    queryFn: ({ signal }) => fetchAgentCatalog(signal),
    staleTime: 5 * 60 * 1000,
  });

  const agents = data?.agents;
  useEffect(() => {
    if (!agents) return;
    hydrateRegisteredAgentMeta(
      agents.map((agent) => ({
        source: agent.source,
        id: agent.id,
        name: agent.name,
        supported: agent.supported,
        ...(agent.iconUrl !== undefined ? { iconUrl: agent.iconUrl } : {}),
      })),
    );
  }, [agents]);
}
