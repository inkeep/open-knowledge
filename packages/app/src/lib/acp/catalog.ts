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
    cli: 'claude' | 'codex' | 'cursor' | 'gemini' | 'opencode' | 'pi';
    availability: 'present' | 'not-found' | 'unknown';
    /** A sign-in already exists in the namespace the adapter reads. */
    credentials: 'present' | 'unknown';
  };
}

/**
 * Whether this host looks ready to run the agent — the single predicate behind
 * both the launcher menus and the Settings list, which must never disagree.
 *
 * Either signal alone is enough, and both are weak. The CLI on PATH means the
 * user works with this harness, not that they are signed in; a credential
 * record means they signed in here at some point, not that the token still
 * works. Neither is a launchability test either: adapters bring their own
 * runtime (npx, or a binary OK downloads itself), so a host with neither
 * signal can still run the agent perfectly well once the user turns it on.
 *
 * Being wrong in the offering direction costs a sign-in prompt; being wrong in
 * the hiding direction costs an agent the user never learns they can use. This
 * only decides what to offer unprompted, so it leans toward offering.
 */
export function isHarnessDetected(agent: CatalogAgent): boolean {
  if (!agent.supported) return false;
  return agent.harness?.availability === 'present' || agent.harness?.credentials === 'present';
}

/** Registry agents this host looks ready to run, best-known first. */
export function detectedHarnessAgents(agents: readonly CatalogAgent[]): CatalogAgent[] {
  const priority = ['claude-acp', 'codex-acp', 'cursor', 'opencode'];
  // `indexOf` returns -1 for an id not in the priority list; map that to the end
  // so an unranked agent sorts AFTER the known first-party ones, not before them.
  const rank = (id: string): number => {
    const i = priority.indexOf(id);
    return i === -1 ? priority.length : i;
  };
  return agents.filter(isHarnessDetected).sort((a, b) => rank(a.id) - rank(b.id));
}

/**
 * Sort rank by what the harness probes found: 0 for an agent whose CLI is on the
 * host, whose credentials are already there, or whose probe has not landed yet;
 * 1 for one the PATH probe positively reported absent with nothing else to go on.
 *
 * `unknown` ranks WITH `present`, not with `not-found` — a probe that has not
 * answered is pending, not a negative result, and burying an agent the user
 * actually has behind a fold because a PATH check was slow is the worse failure.
 * Same three-valued discipline the Desktop rows already apply to their own probe.
 *
 * Distinct from `isHarnessDetected`, which needs a positive answer; this one
 * only orders, so it keeps the pending case up top.
 */
export function harnessPresenceRank(agent: CatalogAgent): number {
  if (agent.harness?.credentials === 'present') return 0;
  return agent.harness?.availability === 'not-found' ? 1 : 0;
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
        featured: agent.featured,
        ...(agent.iconUrl !== undefined ? { iconUrl: agent.iconUrl } : {}),
      })),
    );
  }, [agents]);
}
