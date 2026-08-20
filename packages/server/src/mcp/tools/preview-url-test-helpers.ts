/**
 * Test helpers for `resolvePreviewUrl` consumers.
 *
 * Most MCP-tool tests want to assert "this tool emitted a previewUrl that
 * routes through the running UI." The resolver's only browser-reachable
 * source is a live `server.lock` advertising the `ui` capability (the
 * `env`/`config` sources were removed alongside `preview.baseUrl`, and the
 * sibling `ui.lock` was retired with the single-listener topology). This
 * module bundles the lock setup + the URL prefix into one call so each test
 * doesn't repeat the mechanics — and so a port change touches one place.
 *
 * Not a `*.test.ts` file by design — the runner won't auto-discover it.
 */

import { resolve } from 'node:path';
import { LOCAL_DIR, OK_DIR } from '@inkeep/open-knowledge-core';
import { acquireServerLock, updateServerLockPort } from '../../server-lock.ts';

/**
 * Default port for the test UI server. Vite's dev-server default — picking
 * a familiar number makes failing-test output read naturally. The
 * specific value doesn't matter: the resolver returns whatever the
 * lock's port is, and assertions reference the same constant via the
 * returned `uiBase`.
 */
const TEST_UI_PORT = 5173;

/**
 * Seed a ui-capable `server.lock` rooted at `cwd/.ok/local/` and bind it to
 * `TEST_UI_PORT`. Returns the URL prefix the resolver will emit
 * (`http://localhost:<port>` — no trailing slash, no hash) so call sites can
 * build their expected URLs as `${uiBase}/#/<docName>` without re-hardcoding
 * the port number.
 *
 * The `cwd` argument is whatever directory the tool's `resolveCwd` resolves to
 * — usually the test's per-test tmpDir. The resolver anchors `resolveLockDir`
 * at the project root (cwd), not contentDir (see `server-factory.ts`), so this
 * helper's `<cwd>/.ok/local/` is the exact path the resolver will look at —
 * independent of whatever `config.content.dir` happens to be.
 */
export function bindTestUiServerLock(cwd: string, port = TEST_UI_PORT): string {
  bindTestServerLock(cwd, port, ['http', 'ws', 'ui']);
  return `http://localhost:${port}`;
}

/**
 * Acquire a bound `server.lock` rooted at `cwd/.ok/local/`. Registers THIS
 * test process's pid, so liveness checks treat the server as alive for the
 * duration of the test. Used by tests exercising `preview_url`'s
 * backend-ensure branches, which key off `server.lock` state.
 */
export function bindTestServerLock(cwd: string, port = 4321, capabilities?: string[]): void {
  const lockDir = resolve(cwd, OK_DIR, LOCAL_DIR);
  // `capabilities` survives the port update — `updateServerLockPort` reads the
  // acquired metadata and rewrites only port/url. Pass `['http','ws']` to model
  // an `--only server` boot (no `ui`), or `['http','ws','ui']` for a shell-
  // serving single-listener server.
  acquireServerLock(lockDir, {
    port: 0,
    worktreeRoot: cwd,
    ...(capabilities !== undefined ? { capabilities } : {}),
  });
  updateServerLockPort(lockDir, port);
}
