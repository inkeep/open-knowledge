import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { detectedHarnessAgents, fetchAgentCatalog } from '@/lib/acp/catalog';
import { setDetectedRegisteredAgentSuggestions } from '@/lib/acp/registered-agents';

/**
 * Projects server-host harness detection into every registered-agent picker.
 * Suggestions remain non-persistent and never become the explicit default.
 */
export function AcpHarnessAgentDetection() {
  const catalog = useQuery({
    queryKey: ['acp-catalog'],
    queryFn: ({ signal }) => fetchAgentCatalog(signal),
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    const suggestions = detectedHarnessAgents(catalog.data?.agents ?? []).map((agent) => ({
      source: agent.source,
      id: agent.id,
      name: agent.name,
      ...(agent.iconUrl !== undefined ? { iconUrl: agent.iconUrl } : {}),
    }));
    setDetectedRegisteredAgentSuggestions(suggestions);
    return () => setDetectedRegisteredAgentSuggestions([]);
  }, [catalog.data]);

  return null;
}
