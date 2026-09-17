import { useEffect } from 'react';
import { detectedHarnessAgents, useAgentCatalogQuery } from '@/lib/acp/catalog';
import { setDetectedRegisteredAgentSuggestions } from '@/lib/acp/registered-agents';

export function AcpHarnessAgentDetection() {
  const catalog = useAgentCatalogQuery();

  useEffect(() => {
    const suggestions = detectedHarnessAgents(catalog.data?.agents ?? []).map((agent) => ({
      source: agent.source,
      id: agent.id,
      name: agent.name,
      featured: agent.featured,
      ...(agent.iconUrl !== undefined ? { iconUrl: agent.iconUrl } : {}),
    }));
    setDetectedRegisteredAgentSuggestions(suggestions);
    return () => setDetectedRegisteredAgentSuggestions([]);
  }, [catalog.data]);

  return null;
}
