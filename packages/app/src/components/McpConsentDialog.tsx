/**
 * First-launch MCP consent dialog — thin lazy-loading gate.
 *
 * This wrapper renders in both `NavigatorApp` and `App.tsx` (host-agnostic
 * mount). It subscribes to `mcpConsentStore` and renders nothing until the
 * main-process `ok:mcp-wiring:show` IPC fires and the store becomes
 * non-null. **The dialog body is behind `React.lazy()`** — the ~5-6 kB of
 * checkbox UI, pure helpers, and shadcn Dialog wiring only loads at most
 * once per user, ever (marker idempotence).
 *
 * Size-limit motivation: shipping the dialog in the main bundle costs
 * ~1.5 kB gzipped for every page load, desktop AND web (`packages/app/` is
 * the shared Vite bundle consumed by both `ok ui` and the desktop
 * renderer). A one-time dialog that runs <0.1% of sessions has no business
 * being in the initial critical path. The body must NOT also be reachable
 * via a static re-export from this file — Rolldown's
 * `INEFFECTIVE_DYNAMIC_IMPORT` warning fires when both paths exist, and
 * the lazy chunk silently merges back into the main bundle.
 */

import { lazy, Suspense, useSyncExternalStore } from 'react';
import { mcpConsentStore } from '@/lib/mcp-consent-store';

const LazyMcpConsentDialogBody = lazy(() => import('./McpConsentDialogBody'));

/**
 * Thin gate: subscribes to the store's has-payload state and only mounts
 * the heavy dialog body when a consent request is present. Suspense's null
 * fallback means nothing renders during the lazy-chunk fetch (acceptable —
 * the dialog is modal-on-first-interaction, not a render-blocking surface).
 */
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
