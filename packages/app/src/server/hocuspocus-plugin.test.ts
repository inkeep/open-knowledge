import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as actualServerPkg from '@inkeep/open-knowledge-server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
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
    // `vi.doMock(...)` writes process-global module state in bun:test and
    // does NOT auto-restore between test files. Sibling tests in this codebase
    // document the leak explicitly (`server-factory.test.ts`,
    // `agent-presence.test.ts`, `provider-pool.test.ts`,
    // `local-op-security.test.ts`). Restore to keep the global module table
    // clean for any test that may later import `@inkeep/open-knowledge-server`.
    vi.restoreAllMocks();
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
    const createAssetServeMiddlewareSpy = vi.fn(() => innerAssetFn);
    const handleUpgrade = vi.fn(() => false);
    const teardownOrder: string[] = [];
    let resolveHostShutdown: (() => void) | undefined;
    const hostShutdown = new Promise<void>((resolve) => {
      resolveHostShutdown = resolve;
    });
    const fakeHost = {
      handleUpgrade,
      shutdown: vi.fn(async () => {
        teardownOrder.push('host');
        await hostShutdown;
      }),
      wss: {
        close: (done: (err?: Error) => void) => {
          teardownOrder.push('wss');
          done();
        },
      },
    };
    const createCollaborationHostSpy = vi.fn(() => fakeHost);
    const acpInit = vi.fn(async () => {});
    const acpDestroy = vi.fn(async () => {
      teardownOrder.push('acp');
    });
    class FakeAcpThreadManager {
      init = acpInit;
      destroy = acpDestroy;
    }
    const destroyServer = vi.fn(async () => {
      teardownOrder.push('server');
    });
    const createServerSpy = vi.fn(() => ({
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
      maintenanceCoordinator: {},
      destroy: destroyServer,
    }));

    vi.doMock('@inkeep/open-knowledge-server', () => ({
      ...actualServerPkg,
      AcpThreadManager: FakeAcpThreadManager,
      createAssetServeMiddleware: createAssetServeMiddlewareSpy,
      createCollaborationHost: createCollaborationHostSpy,
      createServer: createServerSpy,
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

    const createServerOptions = createServerSpy.mock.calls[0]?.[0];
    expect(createServerOptions?.configHomedirOverride).toBe(createServerOptions?.contentDir);

    // No post-hook returned — both middlewares are registered synchronously.
    // (Returning a function would defer registration to AFTER Vite's internal
    // middlewares, which would let `spaFallbackMiddleware` win for asset URLs.)
    expect(result).toBeUndefined();

    // Asset middleware factory was called exactly once.
    expect(createAssetServeMiddlewareSpy).toHaveBeenCalledTimes(1);
    expect(createCollaborationHostSpy).toHaveBeenCalledTimes(1);
    expect(createCollaborationHostSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        maintenanceCoordinator: expect.anything(),
        hocuspocus: expect.anything(),
      }),
    );
    expect(httpServer.listeners('upgrade')).toEqual([handleUpgrade]);

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

    let buildEndSettled = false;
    const buildEnd = Promise.resolve(plugin.buildEnd?.call(plugin)).then(() => {
      buildEndSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fakeHost.shutdown).toHaveBeenCalledOnce();
    expect(buildEndSettled).toBe(false);
    httpServer.emit('close');
    expect(fakeHost.shutdown).toHaveBeenCalledOnce();
    expect(teardownOrder).toEqual(['acp', 'host']);
    resolveHostShutdown?.();
    await buildEnd;
    expect(buildEndSettled).toBe(true);
    expect(fakeHost.shutdown).toHaveBeenCalledOnce();
    expect(acpDestroy).toHaveBeenCalledOnce();
    expect(destroyServer).toHaveBeenCalledOnce();
    expect(teardownOrder).toEqual(['acp', 'host', 'wss', 'server']);
    expect(httpServer.listeners('upgrade')).toEqual([]);
  });

  test('buildEnd awaits every overlapping configureServer runtime', async () => {
    const testContentDir = mkTmp();
    process.env.OK_TEST_CONTENT_DIR = testContentDir;
    const shutdowns = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const destroyServers = [vi.fn(async () => {}), vi.fn(async () => {})];
    const hosts = shutdowns.map((shutdown) => ({
      handleUpgrade: vi.fn(() => false),
      shutdown: vi.fn(() => shutdown.promise),
      wss: { close: (done: (err?: Error) => void) => done() },
    }));
    let serverIndex = 0;
    let hostIndex = 0;
    class FakeAcpThreadManager {
      async init(): Promise<void> {}
      async destroy(): Promise<void> {}
    }
    vi.doMock('@inkeep/open-knowledge-server', () => ({
      ...actualServerPkg,
      AcpThreadManager: FakeAcpThreadManager,
      createAssetServeMiddleware: () => () => {},
      createCollaborationHost: () => {
        const host = hosts[hostIndex++];
        if (host === undefined) throw new Error('missing fake host');
        return host;
      },
      createServer: () => {
        const destroy = destroyServers[serverIndex++];
        if (destroy === undefined) throw new Error('missing fake server');
        return {
          lockDir: testContentDir,
          contentFilter: { isPathIgnored: () => false, isExcluded: () => false },
          hocuspocus: { hooks: async () => {} },
          sessionManager: {},
          agentFocusBroadcaster: {},
          agentPresenceBroadcaster: {},
          maintenanceCoordinator: {},
          destroy,
        };
      },
      getLogger: () => ({ info: () => {}, error: () => {} }),
      makeLazyEmbeddingsKeyStore: () => ({}),
      releaseServerLock: () => {},
      updateServerLockPort: () => {},
    }));
    const { hocuspocusPlugin } = await import('./hocuspocus-plugin.ts?overlap-test');
    const makeViteServer = () => {
      const httpServer = new EventEmitter() as EventEmitter & {
        address: () => null;
      };
      httpServer.address = () => null;
      const middlewares = { use: () => middlewares };
      return { httpServer, middlewares };
    };
    const plugin = hocuspocusPlugin();
    const first = makeViteServer();
    const second = makeViteServer();
    // biome-ignore lint/suspicious/noExplicitAny: EventEmitter Vite stub
    await (plugin.configureServer as any).call(plugin, first);
    // biome-ignore lint/suspicious/noExplicitAny: EventEmitter Vite stub
    await (plugin.configureServer as any).call(plugin, second);

    let buildEndSettled = false;
    const buildEnd = Promise.resolve(plugin.buildEnd?.call(plugin)).then(() => {
      buildEndSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    for (const host of hosts) expect(host.shutdown).toHaveBeenCalledOnce();
    expect(buildEndSettled).toBe(false);
    shutdowns[0]?.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(buildEndSettled).toBe(false);
    shutdowns[1]?.resolve();
    await buildEnd;
    expect(buildEndSettled).toBe(true);
    for (const destroy of destroyServers) expect(destroy).toHaveBeenCalledOnce();
  });

  test('bounds WebSocket close and force-terminates clients before continuing teardown', async () => {
    vi.useFakeTimers();
    try {
      const testContentDir = mkTmp();
      process.env.OK_TEST_CONTENT_DIR = testContentDir;
      const order: string[] = [];
      const logger = { info: vi.fn(), error: vi.fn() };
      const terminateClient = vi.fn(() => {
        order.push('client');
      });
      class FakeAcpThreadManager {
        async init(): Promise<void> {}
        async destroy(): Promise<void> {
          order.push('acp');
        }
      }
      const host = {
        handleUpgrade: vi.fn(() => false),
        shutdown: vi.fn(async () => {
          order.push('host');
        }),
        wss: {
          clients: new Set([{ terminate: terminateClient }]),
          close: vi.fn((_done: (err?: Error) => void) => {
            order.push('wss');
          }),
        },
      };
      const destroy = vi.fn(async () => {
        order.push('server');
      });
      vi.doMock('@inkeep/open-knowledge-server', () => ({
        ...actualServerPkg,
        AcpThreadManager: FakeAcpThreadManager,
        createAssetServeMiddleware: () => () => {},
        createCollaborationHost: () => host,
        createServer: () => ({
          lockDir: testContentDir,
          contentFilter: { isPathIgnored: () => false, isExcluded: () => false },
          hocuspocus: { hooks: async () => {} },
          sessionManager: {},
          agentFocusBroadcaster: {},
          agentPresenceBroadcaster: {},
          maintenanceCoordinator: {},
          destroy,
        }),
        getLogger: () => logger,
        makeLazyEmbeddingsKeyStore: () => ({}),
        releaseServerLock: () => {},
        updateServerLockPort: () => {},
      }));
      const { hocuspocusPlugin } = await import('./hocuspocus-plugin.ts?wss-timeout-test');
      const httpServer = new EventEmitter() as EventEmitter & { address: () => null };
      httpServer.address = () => null;
      const middlewares = { use: () => middlewares };
      const plugin = hocuspocusPlugin();
      // biome-ignore lint/suspicious/noExplicitAny: EventEmitter Vite stub
      await (plugin.configureServer as any).call(plugin, { httpServer, middlewares });

      let buildEndSettled = false;
      const buildEndResult = Promise.resolve(plugin.buildEnd?.call(plugin)).then(
        () => {
          buildEndSettled = true;
          return undefined;
        },
        (err: unknown) => {
          buildEndSettled = true;
          return err;
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual(['acp', 'host', 'wss']);
      expect(buildEndSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(terminateClient).not.toHaveBeenCalled();
      expect(buildEndSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const buildEndError = await buildEndResult;
      expect(buildEndError).toBeInstanceOf(AggregateError);
      expect(terminateClient).toHaveBeenCalledOnce();
      expect(host.wss.close).toHaveBeenCalledOnce();
      expect(destroy).toHaveBeenCalledOnce();
      expect(order).toEqual(['acp', 'host', 'wss', 'client', 'server']);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'Vite collaboration teardown failed: WebSocket server',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test('propagates buildEnd AggregateError and contains HTTP-close fallback failures', async () => {
    const testContentDir = mkTmp();
    process.env.OK_TEST_CONTENT_DIR = testContentDir;
    const order: string[] = [];
    const logger = { info: vi.fn(), error: vi.fn() };
    class FakeAcpThreadManager {
      async init(): Promise<void> {}
      async destroy(): Promise<void> {
        order.push('acp');
        throw new Error('acp failed');
      }
    }
    const host = {
      handleUpgrade: vi.fn(() => false),
      shutdown: vi.fn(async () => {
        order.push('host');
        throw new Error('host failed');
      }),
      wss: {
        close: (done: (err?: Error) => void) => {
          order.push('wss');
          done(new Error('wss failed'));
        },
      },
    };
    const destroy = vi.fn(async () => {
      order.push('server');
      throw new Error('server failed');
    });
    vi.doMock('@inkeep/open-knowledge-server', () => ({
      ...actualServerPkg,
      AcpThreadManager: FakeAcpThreadManager,
      createAssetServeMiddleware: () => () => {},
      createCollaborationHost: () => host,
      createServer: () => ({
        lockDir: testContentDir,
        contentFilter: { isPathIgnored: () => false, isExcluded: () => false },
        hocuspocus: { hooks: async () => {} },
        sessionManager: {},
        agentFocusBroadcaster: {},
        agentPresenceBroadcaster: {},
        maintenanceCoordinator: {},
        destroy,
      }),
      getLogger: () => logger,
      makeLazyEmbeddingsKeyStore: () => ({}),
      releaseServerLock: () => {},
      updateServerLockPort: () => {},
    }));
    const { hocuspocusPlugin } = await import('./hocuspocus-plugin.ts?fallback-test');
    const httpServer = new EventEmitter() as EventEmitter & { address: () => null };
    httpServer.address = () => null;
    const middlewares = { use: () => middlewares };
    const plugin = hocuspocusPlugin();
    // biome-ignore lint/suspicious/noExplicitAny: EventEmitter Vite stub
    await (plugin.configureServer as any).call(plugin, { httpServer, middlewares });

    const buildEndError: unknown = await Promise.resolve(plugin.buildEnd?.call(plugin)).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(buildEndError).toBeInstanceOf(AggregateError);
    if (!(buildEndError instanceof AggregateError)) {
      throw new Error('buildEnd did not propagate an AggregateError');
    }
    expect(buildEndError.message).toBe('Hocuspocus Vite teardown failed');
    expect(buildEndError.errors).toHaveLength(1);
    const runtimeError = buildEndError.errors[0];
    expect(runtimeError).toBeInstanceOf(AggregateError);
    if (!(runtimeError instanceof AggregateError)) {
      throw new Error('runtime teardown did not aggregate phase failures');
    }
    expect(runtimeError.message).toBe('Vite collaboration teardown failed');
    expect(runtimeError.errors).toHaveLength(4);
    expect(order).toEqual(['acp', 'host', 'wss', 'server']);

    httpServer.emit('close');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(AggregateError) }),
      'HTTP close fallback teardown failed',
    );
    await expect(plugin.buildEnd?.call(plugin)).resolves.toBeUndefined();
  });
});
