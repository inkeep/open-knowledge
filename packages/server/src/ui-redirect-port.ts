/**
 * Redirect-target resolution for flows that need a browser-navigable UI port
 * for a project directory (the clone → open redirect in `api-extension.ts`).
 * Mirrors `resolveUiInfo` in `mcp/tools/preview-url.ts` — the canonical
 * two-source chain; the two surfaces must agree on what "no UI" means for as
 * long as `ui.lock` remains supported:
 *
 *   1. a live, non-draining `server.lock` advertising the `ui` capability →
 *      that server's port (single-listener topology);
 *   2. else a live, non-draining `ui.lock` with a bound port → that port —
 *      the `--only ui --server-url` split-mode proxy, OK Electron's
 *      advertisement, or a legacy sibling from an older binary;
 *   3. else a live server.lock whose `capabilities` EXPLICITLY omit `ui` →
 *      `'no-ui'` — definitive: no UI is serving and none will bind on its
 *      own;
 *   4. else `null` — nothing usable is live.
 *
 * A server.lock with no `capabilities` field (older writer) is treated as
 * ui-capable in step 1 — absence is indeterminate, and an optimistic
 * redirect beats wrongly refusing a healthy server (mirrors
 * `serverExplicitlyLacksUi` in `mcp/tools/get-preview-url.ts`).
 *
 * Step 2 retires with the ui.lock removal wave; until then, dropping it
 * would report "no UI" against a live split-mode pair while a UI is in
 * fact serving.
 */

import { readServerLock } from './server-lock.ts';
import { readUiLock } from './ui-lock.ts';

export function resolveUiRedirectPort(lockDir: string): number | 'no-ui' | null {
  const server = readServerLock(lockDir);
  const serverLive = server !== null && server.port > 0 && server.draining !== true;
  // Two ways step 1 admits a lock: no `capabilities` field at all (older
  // writer — indeterminate, be optimistic), or an explicit `ui` entry.
  if (serverLive && (!Array.isArray(server.capabilities) || server.capabilities.includes('ui'))) {
    return server.port;
  }
  const ui = readUiLock(lockDir);
  if (ui !== null && ui.port > 0 && ui.draining !== true) return ui.port;
  if (serverLive) return 'no-ui';
  return null;
}
