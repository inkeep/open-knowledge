import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as actualServerPkg from '@inkeep/open-knowledge-server';
import { resolveContentConfig } from './hocuspocus-plugin.ts';

const createdDirs: string[] = [];

function mkTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok-hocuspocus-plugin-'));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveContentConfig', () => {
  test('no config.yml: defaults to projectRoot', () => {
    const projectRoot = mkTmp();
    const config = resolveContentConfig(projectRoot);
    expect(config.dir).toBe(projectRoot);
  });

  test('config.yml without content.dir: defaults to projectRoot', () => {
    const projectRoot = mkTmp();
    mkdirSync(join(projectRoot, '.ok'), { recursive: true });
    writeFileSync(join(projectRoot, '.ok/config.yml'), 'server:\n  host: 0.0.0.0\n', 'utf-8');
    const config = resolveContentConfig(projectRoot);
    expect(config.dir).toBe(projectRoot);
  });

  test('config.yml with content.dir: resolves relative to projectRoot', () => {
    const projectRoot = mkTmp();
    mkdirSync(join(projectRoot, '.ok'), { recursive: true });
    writeFileSync(join(projectRoot, '.ok/config.yml'), "content:\n  dir: 'content'\n", 'utf-8');
    const config = resolveContentConfig(projectRoot);
    expect(config.dir).toBe(join(projectRoot, 'content'));
  });
});

/**
 * Middleware-registration ordering contract.
 *
 * The plugin's `configureServer` registers the asset-serve middleware
 * SYNCHRONOUSLY (front of chain, BEFORE Vite installs its own internal
 * middlewares). This is load-bearing: the asset middleware's 404 guard must run
 * before Vite's `spaFallbackMiddleware`, otherwise unknown asset URLs return
 * 200 + text/html instead of 404, and asset URLs that exist return
 * the SPA shell instead of the asset bytes (naturalWidth = 0,
 * application/pdf becomes text/html).
 *
 * A post-hook approach (`return () => server.middlewares.use(...)`) would
 * land the middlewares AFTER `spaFallbackMiddleware`, breaking those guards.
 * This test pins the synchronous-registration contract.
 */
describe('hocuspocusPlugin.configureServer middleware ordering', () => {
  // Save + restore `OK_TEST_CONTENT_DIR` so this test does not leak into
  // sibling tests in the same `bun test` process (any later test that
  // dynamically re-imports `hocuspocus-plugin.ts` would otherwise pick up a
  // stale path pointing at a deleted tmpdir).
  let origEnv: string | undefined;
  beforeEach(() => {
    origEnv = process.env.OK_TEST_CONTENT_DIR;
  });
  afterEach(() => {
    if (origEnv !== undefined) process.env.OK_TEST_CONTENT_DIR = origEnv;
    else delete process.env.OK_TEST_CONTENT_DIR;
    // `mock.module(...)` writes process-global module state in bun:test and
    // does NOT auto-restore between test files. Sibling tests in this codebase
    // document the leak explicitly (`server-factory.test.ts`,
    // `agent-presence.test.ts`, `provider-pool.test.ts`,
    // `local-op-security.test.ts`). Restore to keep the global module table
    // clean for any test that may later import `@inkeep/open-knowledge-server`.
    mock.restore();
  });

  test('registers asset + api middlewares synchronously, no post-hook returned', async () => {
    const testContentDir = mkTmp();
    process.env.OK_TEST_CONTENT_DIR = testContentDir;

    // Spy on `createAssetServeMiddleware` to verify the asset middleware was
    // actually constructed (and not, e.g., silently skipped by a regression).
    // The inner asset fn counts its invocations so the bypass-path assertions
    // below can confirm bypass routes never reach it. Doesn't depend on JS
    // NamedEvaluation (which `return (req, res, next) => {…}` does NOT
    // trigger — `.name` on the real returned fn is `''`, not
    // `'assetServeMiddleware'`).
    let innerAssetCalls = 0;
    const innerAssetFn = (..._args: unknown[]) => {
      innerAssetCalls += 1;
    };
    const createAssetServeMiddlewareSpy = mock(() => innerAssetFn);

    mock.module('@inkeep/open-knowledge-server', () => ({
      ...actualServerPkg,
      createAssetServeMiddleware: createAssetServeMiddlewareSpy,
      createServer: () => ({
        lockDir: testContentDir,
        contentFilter: { isPathIgnored: () => false },
        hocuspocus: {
          hooks: async () => {},
          getConnectionsCount: () => 0,
          handleConnection: () => ({
            handleMessage: () => {},
            handleClose: () => {},
          }),
        },
        sessionManager: { closeAllForAgent: async () => {} },
        agentFocusBroadcaster: { clearFocus: () => {} },
        agentPresenceBroadcaster: { clearPresence: () => {}, bumpPresenceTs: () => {} },
        destroy: async () => {},
      }),
      handleCollabSocketError: () => false,
      parseKeepaliveConnectionId: () => null,
      releaseServerLock: () => {},
      toBroadcasterKey: (id: string) => `agent-${id}`,
      updateServerLockPort: () => {},
    }));

    // Re-import the plugin under the mock with a cache-busting query so the
    // mock applies even when bun:test has previously loaded the module in
    // this process.
    const { hocuspocusPlugin } = await import('./hocuspocus-plugin.ts?ordering-test');

    const httpServer = new EventEmitter() as EventEmitter & {
      prependListener: (event: string, fn: (...args: unknown[]) => void) => unknown;
      address: () => null;
    };
    httpServer.prependListener = httpServer.on.bind(httpServer);
    httpServer.address = () => null;

    const registered: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const viteServerStub = {
      httpServer,
      middlewares: {
        use: (fn: (req: unknown, res: unknown, next: () => void) => void) => {
          registered.push(fn);
          return viteServerStub.middlewares;
        },
      },
    };

    const plugin = hocuspocusPlugin();
    expect(typeof plugin.configureServer).toBe('function');

    // biome-ignore lint/suspicious/noExplicitAny: minimal Vite ViteDevServer stub for the structural assertion
    const result = await (plugin.configureServer as any).call(plugin, viteServerStub);

    // No post-hook returned — both middlewares are registered synchronously.
    // (Returning a function would defer registration to AFTER Vite's internal
    // middlewares, which would let `spaFallbackMiddleware` win for asset URLs.)
    expect(result).toBeUndefined();

    // Asset middleware factory was called exactly once.
    expect(createAssetServeMiddlewareSpy).toHaveBeenCalledTimes(1);

    // Two middlewares were registered synchronously: the asset wrapper +
    // the api handler.
    expect(registered).toHaveLength(2);

    // The first middleware is the asset wrapper. Drive it with Vite-internal
    // paths; the wrapper must call next() (bypass) instead of the inner
    // factory-returned fn — otherwise the asset middleware would 404 paths
    // Vite owns (regressing the original boot-blank-page bug).
    const assetWrapper = registered[0];
    if (!assetWrapper) throw new Error('asset wrapper not registered');

    for (const bypassUrl of [
      '/src/editor/slash-command/preview-assets/image-preview.png?import',
      '/favicon.svg',
      '/@vite/client',
      '/@fs/path/to/file.ts',
      '/@id/some-virtual',
      '/@react-refresh',
      '/node_modules/some-dep/index.js',
      '/index.html?html-proxy&index=0.css',
    ]) {
      let nextCalled = false;
      assetWrapper({ url: bypassUrl }, {}, () => {
        nextCalled = true;
      });
      expect(nextCalled, `bypass should fire for ${bypassUrl}`).toBe(true);
    }

    // The inner asset fn must NOT have been called for any bypass route.
    expect(innerAssetCalls).toBe(0);

    // Non-bypassed paths DO delegate to the inner asset fn. Includes query
    // strings that contain `import` / `html-proxy` as substrings but not as
    // bare flags — the wrapper must use boundary-aware param matching.
    for (const nonBypassUrl of [
      '/photo.png',
      '/photo.png?reimport=1',
      '/photo.png?importMode=auto',
      '/photo.png?html-proxy-ish=1',
    ]) {
      assetWrapper({ url: nonBypassUrl }, {}, () => {});
    }
    expect(innerAssetCalls).toBe(4);
  });
});
