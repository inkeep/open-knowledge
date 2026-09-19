import type { AgentCatalog, CatalogAgent } from '@/lib/acp/catalog';

const DEFAULT_AGENT: CatalogAgent = {
  id: 'catalog-agent',
  name: 'Catalog Agent',
  version: '1.0.0',
  source: 'registry',
  supported: true,
  featured: false,
  harness: { cli: 'claude', availability: 'present', credentials: 'present' },
};

export function acpCatalogBody(
  agents: readonly Partial<CatalogAgent>[] = [{}],
  envelope: Partial<Omit<AgentCatalog, 'agents'>> = {},
): AgentCatalog {
  return {
    agents: agents.map((agent, index) => ({
      ...DEFAULT_AGENT,
      id: `${DEFAULT_AGENT.id}-${index}`,
      name: `${DEFAULT_AGENT.name} ${index}`,
      ...agent,
    })),
    stale: envelope.stale ?? false,
    maxThreads: envelope.maxThreads ?? 8,
  };
}
