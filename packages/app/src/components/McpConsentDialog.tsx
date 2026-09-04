import { lazy, Suspense, useSyncExternalStore } from 'react';
import { mcpConsentStore } from '@/lib/mcp-consent-store';

const LazyMcpConsentDialogBody = lazy(() => import('./McpConsentDialogBody'));

export function McpConsentDialog() {
  const hasPayload = useSyncExternalStore(
    mcpConsentStore.subscribe,
    () => mcpConsentStore.getSnapshot() !== null,
    () => false,
  );
  if (!hasPayload) return null;
  return (
    <Suspense fallback={null}>
      <LazyMcpConsentDialogBody />
    </Suspense>
  );
}
