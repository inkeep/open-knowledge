/**
 * Redirect-target resolution for flows that need a browser-navigable UI port
 * for a project directory (the clone → open redirect in `api-extension.ts`).
 * Twin of `resolveUiInfo` in `mcp/tools/preview-url.ts` — the two surfaces must
 * agree on what "no UI" means, so both route the capability decision through
 * the shared `lockAdvertisesUi` predicate:
 *
 *   1. a live, non-draining `server.lock` advertising the `ui` capability (or
 *      omitting the `capabilities` field — indeterminate, treated
 *      optimistically) → that server's port (single-listener topology);
 *   2. else a live, non-draining `server.lock` whose `capabilities` EXPLICITLY
 *      omit `ui` → `'no-ui'` — definitive: no UI is serving and none will bind
 *      on its own;
 *   3. else `null` — nothing usable is live.
 */

import { lockAdvertisesUi, readServerLock } from './server-lock.ts';

export function resolveUiRedirectPort(lockDir: string): number | 'no-ui' | null {
  const server = readServerLock(lockDir);
  if (server === null || server.port <= 0 || server.draining === true) return null;
  return lockAdvertisesUi(server) ? server.port : 'no-ui';
}
