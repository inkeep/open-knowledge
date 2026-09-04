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
  supported: boolean;
  featured: boolean;
  harness?: {
    cli: 'claude' | 'codex' | 'cursor' | 'gemini' | 'opencode' | 'pi';
    availability: 'present' | 'not-found' | 'unknown';
    credentials: 'present' | 'unknown';
  };
}

export function isHarnessDetected(agent: CatalogAgent): boolean {
  if (!agent.supported) return false;
  return agent.harness?.availability === 'present' || agent.harness?.credentials === 'present';
}

export function detectedHarnessAgents(agents: readonly CatalogAgent[]): CatalogAgent[] {
  const priority = ['claude-acp', 'codex-acp', 'cursor', 'opencode'];
  const rank = (id: string): number => {
    const i = priority.indexOf(id);
    return i === -1 ? priority.length : i;
  };
  return agents.filter(isHarnessDetected).sort((a, b) => rank(a.id) - rank(b.id));
}

export function harnessPresenceRank(agent: CatalogAgent): number {
  if (agent.harness?.credentials === 'present') return 0;
  return agent.harness?.availability === 'not-found' ? 1 : 0;
}

export interface AgentCatalog {
  agents: CatalogAgent[];
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
        featured: agent.featured,
        ...(agent.iconUrl !== undefined ? { iconUrl: agent.iconUrl } : {}),
      })),
    );
  }, [agents]);
}
