import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { resolveUiInfo } from './mcp/tools/preview-url.ts';
import {
  acquireServerLock,
  markServerLockDraining,
  releaseServerLock,
  updateServerLockPort,
} from './server-lock.ts';
import { resolveUiRedirectPort } from './ui-redirect-port.ts';

/**
 * Guardrail: `resolveUiInfo` (preview-url.ts) and `resolveUiRedirectPort`
 * (ui-redirect-port.ts) are twins that MUST agree on the "no UI" boundary —
 * both route the capability decision through the shared `lockAdvertisesUi`
 * predicate. This table drives BOTH over the same `server.lock` states and
 * asserts they classify UI-present identically (and, when present, surface the
 * same port). A divergence here is the exact class of bug the shared predicate
 * exists to prevent once `ui.lock` no longer backstops either surface.
 *
 * The OTHER `lockAdvertisesUi` consumers are exercised where their own
 * liveness/shape logic lives, so no surface reintroduces the divergence:
 *   - `serverExplicitlyLacksUi` (get-preview-url.ts) — the LIVE-lock inverse;
 *     pinned by get-preview-url.test.ts's `--only server` + draining hints.
 *   - `createOffCwdResolverDeps.inspect` (off-cwd-resolver.ts) — off-cwd-resolver.test.ts.
 *   - CLI `ok status` / `ok ps` / `resolveServerReuse` — all import the exported
 *     predicate; the missing-`capabilities` optimism is pinned by status.test.ts
 *     and ps.test.ts so a pre-v2 server never shows "no UI" while preview_url
 *     would navigate to it.
 */
describe('resolveUiInfo ⇔ resolveUiRedirectPort agreement', () => {
  const dirs: string[] = [];

  function makeLockDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ok-ui-agree-'));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  type Seed = (lockDir: string) => void;
  const cases: Array<{ name: string; seed: Seed; uiPresent: boolean }> = [
    {
      name: 'ui-capable live server.lock',
      seed: (d) => {
        acquireServerLock(d, { port: 0, worktreeRoot: d, capabilities: ['http', 'ws', 'ui'] });
        updateServerLockPort(d, 46001, 'http://127.0.0.1:46001');
      },
      uiPresent: true,
    },
    {
      name: 'no-capabilities live server.lock (optimistic)',
      seed: (d) => {
        acquireServerLock(d, { port: 0, worktreeRoot: d });
        updateServerLockPort(d, 46002, 'http://127.0.0.1:46002');
      },
      uiPresent: true,
    },
    {
      name: 'explicit no-ui live server.lock',
      seed: (d) => {
        acquireServerLock(d, { port: 0, worktreeRoot: d, capabilities: ['http', 'ws'] });
        updateServerLockPort(d, 46003, 'http://127.0.0.1:46003');
      },
      uiPresent: false,
    },
    {
      name: 'draining ui-capable server.lock',
      seed: (d) => {
        acquireServerLock(d, { port: 0, worktreeRoot: d, capabilities: ['http', 'ws', 'ui'] });
        updateServerLockPort(d, 46004, 'http://127.0.0.1:46004');
        markServerLockDraining(d);
      },
      uiPresent: false,
    },
    {
      name: 'explicit no-ui + draining server.lock',
      seed: (d) => {
        acquireServerLock(d, { port: 0, worktreeRoot: d, capabilities: ['http', 'ws'] });
        updateServerLockPort(d, 46005, 'http://127.0.0.1:46005');
        markServerLockDraining(d);
      },
      uiPresent: false,
    },
    {
      name: 'unbound (port 0) ui-capable server.lock',
      seed: (d) => {
        acquireServerLock(d, { port: 0, worktreeRoot: d, capabilities: ['http', 'ws', 'ui'] });
      },
      uiPresent: false,
    },
    {
      name: 'no lock at all',
      seed: () => undefined,
      uiPresent: false,
    },
  ];

  for (const c of cases) {
    test(`${c.name}: twins agree UI-present=${c.uiPresent}`, () => {
      const lockDir = makeLockDir();
      c.seed(lockDir);
      try {
        const base = resolveUiInfo({ lockDir }).baseUrl;
        const redirect = resolveUiRedirectPort(lockDir);
        const infoPresent = base !== null;
        const redirectPresent = typeof redirect === 'number';
        // The two twins must classify UI-present identically...
        expect(infoPresent).toBe(redirectPresent);
        // ...and match the expected outcome for the state.
        expect(infoPresent).toBe(c.uiPresent);
        // When a UI is present, both surface the same port.
        if (c.uiPresent) {
          expect(base).toContain(`:${redirect}`);
        }
      } finally {
        releaseServerLock(lockDir);
      }
    });
  }
});
