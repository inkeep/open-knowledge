import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { resolveServerRuntimeConfig } from '@inkeep/open-knowledge-core';
import { ConfigSchema } from '@inkeep/open-knowledge-server';
import { beforeEach, describe, expect, type Mock, test, vi } from 'vitest';
import { UTILITY_INIT_PHASES } from '../../src/shared/boot-narration.ts';
import type { KeyringSmokeResult } from '../../src/utility/keyring-smoke.ts';
import {
  type PreparedBootEnvironment,
  resolveContentDir,
  type SetupUtilityDeps,
  setupUtility,
  type UtilityOutgoingMessage,
} from '../../src/utility/server-entry.ts';

type UtilityParentPort = NonNullable<SetupUtilityDeps['parentPort']>;

interface MockParentPort {
  on: Mock<UtilityParentPort['on']>;
  postMessage: Mock<UtilityParentPort['postMessage']>;
  fire: (msg: unknown) => void;
}

function mockParentPort(): MockParentPort {
  let handler: ((event: { data: unknown }) => void) | null = null;
  const on = vi.fn<UtilityParentPort['on']>((_event, h) => {
    handler = h;
  });
  return {
    on,
    postMessage: vi.fn<UtilityParentPort['postMessage']>(() => {}),
    fire: (msg: unknown) => handler?.({ data: msg }),
  };
}

interface MockEnv {
  parentPort: MockParentPort;
  exit: Mock<SetupUtilityDeps['exit']>;
  killProbe: Mock<SetupUtilityDeps['killProbe']>;
  signalHandlers: Map<string, () => void>;
  intervals: Array<{ cb: () => void; ms: number }>;
  intervalCancel: Mock<() => void>;
}

function buildEnv(): MockEnv {
  const env: MockEnv = {
    parentPort: mockParentPort(),
    exit: vi.fn(() => {}),
    killProbe: vi.fn(() => {}),
    signalHandlers: new Map(),
    intervals: [],
    intervalCancel: vi.fn(() => {}),
  };
  return env;
}

function makeFakePrepared(overrides?: Partial<PreparedBootEnvironment>): PreparedBootEnvironment {
  const config = overrides?.config ?? ConfigSchema.parse({});
  return {
    config,
    contentDir: '/fake/content',
    contentRoot: undefined,
    configValid: true,
    serverRuntime: resolveServerRuntimeConfig(config),
    ...overrides,
  };
}

function fakePrepare(returnValue?: PreparedBootEnvironment) {
  return vi.fn(() => Promise.resolve(returnValue ?? makeFakePrepared()));
}

describe('setupUtility (IPC handshake + lifecycle)', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = buildEnv();
  });

  test('on init message: imports server, calls bootServer with M1 opt-outs, posts ready', async () => {
    const fakeBooted = {
      port: 51234,
      destroy: vi.fn(() => Promise.resolve()),
      degraded: [] as readonly string[],
    };
    const bootServer = vi.fn(() => Promise.resolve(fakeBooted));
    const importServer = vi.fn(() =>
      Promise.resolve({ bootServer } as unknown as typeof import('@inkeep/open-knowledge-server')),
    );
    const prepared = makeFakePrepared({ contentDir: '/fake/test-project', contentRoot: undefined });

    const handle = setupUtility({
      parentPort: env.parentPort,
      importServer,
      exit: env.exit,
      parentPid: 99999,
      killProbe: env.killProbe,
      onSignal: (sig, h) => env.signalHandlers.set(sig, h),
      setInterval: (cb, ms) => {
        env.intervals.push({ cb, ms });
        return { unref: vi.fn(() => {}), clear: env.intervalCancel };
      },
      prepareBootEnvironment: fakePrepare(prepared),
    });

    env.parentPort.fire({
      type: 'init',
      opts: {
        contentDir: '/tmp/test-project',
        projectDir: '/tmp/test-project',
        port: 0,
        host: 'localhost',
      },
    });

    const ready = await handle.readyPromise;
    expect(ready.type).toBe('ready');
    expect(ready.port).toBe(51234);
    expect(ready.apiOrigin).toBe('http://localhost:51234');

    const callArgs = bootServer.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(callArgs?.idleShutdownMs).toBe(null);
    expect(callArgs?.skipAutoInit).toBe(true);
    expect(callArgs?.autoInitFn).toBeUndefined();
    expect(callArgs?.contentDir).toBe('/fake/test-project');
    expect(callArgs?.config).toBe(prepared.config);
    expect(callArgs?.serverRuntime).toBe(prepared.serverRuntime);
    expect(callArgs?.bind).toBe(prepared.serverRuntime.bind);

    expect(env.parentPort.postMessage).toHaveBeenCalledWith({
      type: 'ready',
      port: 51234,
      apiOrigin: 'http://localhost:51234',
    });
  });

  test('on init failure: posts error and exits non-zero', async () => {
    const importServer = vi.fn(() => Promise.reject(new Error('boot failed')));
    const handle = setupUtility({
      parentPort: env.parentPort,
      importServer,
      exit: env.exit,
      parentPid: 99999,
      killProbe: env.killProbe,
      onSignal: (sig, h) => env.signalHandlers.set(sig, h),
      setInterval: (cb, ms) => {
        env.intervals.push({ cb, ms });
        return { unref: vi.fn(() => {}), clear: env.intervalCancel };
      },
    });

    env.parentPort.fire({
      type: 'init',
      opts: { contentDir: '/tmp/x', projectDir: '/tmp/x', port: 0, host: 'localhost' },
    });

    await expect(handle.readyPromise).rejects.toThrow('boot failed');
    expect(env.exit).toHaveBeenCalledWith(1);
  });

  test('parent-death poll: triggers shutdown on EPERM/ESRCH', async () => {
    const fakeBooted = {
      port: 51234,
      destroy: vi.fn(() => Promise.resolve()),
      degraded: [] as readonly string[],
    };
    const bootServer = vi.fn(() => Promise.resolve(fakeBooted));

    const handle = setupUtility({
      parentPort: env.parentPort,
      importServer: () =>
        Promise.resolve({
          bootServer,
        } as unknown as typeof import('@inkeep/open-knowledge-server')),
      exit: env.exit,
      parentPid: 99999,
      killProbe: () => {
        const err = new Error('No such process') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      },
      onSignal: (sig, h) => env.signalHandlers.set(sig, h),
      setInterval: (cb, ms) => {
        env.intervals.push({ cb, ms });
        return { unref: vi.fn(() => {}), clear: env.intervalCancel };
      },
      parentPollMs: 100,
      prepareBootEnvironment: fakePrepare(),
    });

    expect(env.intervals.length).toBeGreaterThan(0);
    const pollCb = env.intervals[0]?.cb;
    expect(pollCb).toBeDefined();
    pollCb?.();

    await wait(10);
    expect(env.exit).toHaveBeenCalledWith(0);
    void handle;
  });

  test('shutdown IPC: drains booted server then exits 0', async () => {
    const destroy = vi.fn(() => Promise.resolve());
    const fakeBooted = { port: 51234, destroy, degraded: [] as readonly string[] };
    const bootServer = vi.fn(() => Promise.resolve(fakeBooted));

    const handle = setupUtility({
      parentPort: env.parentPort,
      importServer: () =>
        Promise.resolve({
          bootServer,
        } as unknown as typeof import('@inkeep/open-knowledge-server')),
      exit: env.exit,
      parentPid: 99999,
      killProbe: env.killProbe,
      onSignal: (sig, h) => env.signalHandlers.set(sig, h),
      setInterval: (cb, ms) => {
        env.intervals.push({ cb, ms });
        return { unref: vi.fn(() => {}), clear: env.intervalCancel };
      },
      prepareBootEnvironment: fakePrepare(),
    });

    env.parentPort.fire({
      type: 'init',
      opts: { contentDir: '/tmp/x', projectDir: '/tmp/x', port: 0, host: 'localhost' },
    });
    await handle.readyPromise;

    env.parentPort.fire({ type: 'shutdown' });
    await wait(10);

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(env.exit).toHaveBeenCalledWith(0);
    expect(env.intervalCancel).toHaveBeenCalled();
  });

  test('SIGTERM handler triggers same shutdown path as IPC', async () => {
    const destroy = vi.fn(() => Promise.resolve());
    const fakeBooted = { port: 51234, destroy, degraded: [] as readonly string[] };
    const bootServer = vi.fn(() => Promise.resolve(fakeBooted));

    const handle = setupUtility({
      parentPort: env.parentPort,
      importServer: () =>
        Promise.resolve({
          bootServer,
        } as unknown as typeof import('@inkeep/open-knowledge-server')),
      exit: env.exit,
      parentPid: 99999,
      killProbe: env.killProbe,
      onSignal: (sig, h) => env.signalHandlers.set(sig, h),
      setInterval: (cb, ms) => {
        env.intervals.push({ cb, ms });
        return { unref: vi.fn(() => {}), clear: env.intervalCancel };
      },
      prepareBootEnvironment: fakePrepare(),
    });

    env.parentPort.fire({
      type: 'init',
      opts: { contentDir: '/tmp/x', projectDir: '/tmp/x', port: 0, host: 'localhost' },
    });
    await handle.readyPromise;

    const sigtermHandler = env.signalHandlers.get('SIGTERM');
    expect(sigtermHandler).toBeDefined();
    sigtermHandler?.();
    await wait(10);

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(env.exit).toHaveBeenCalledWith(0);
  });

  test('shutdown is idempotent — multiple calls drain once', async () => {
    const destroy = vi.fn(() => Promise.resolve());
    const fakeBooted = { port: 51234, destroy, degraded: [] as readonly string[] };
    const bootServer = vi.fn(() => Promise.resolve(fakeBooted));

    const handle = setupUtility({
      parentPort: env.parentPort,
      importServer: () =>
        Promise.resolve({
          bootServer,
        } as unknown as typeof import('@inkeep/open-knowledge-server')),
      exit: env.exit,
      parentPid: 99999,
      killProbe: env.killProbe,
      onSignal: (sig, h) => env.signalHandlers.set(sig, h),
      setInterval: (cb, ms) => {
        env.intervals.push({ cb, ms });
        return { unref: vi.fn(() => {}), clear: env.intervalCancel };
      },
      prepareBootEnvironment: fakePrepare(),
    });

    env.parentPort.fire({
      type: 'init',
      opts: { contentDir: '/tmp/x', projectDir: '/tmp/x', port: 0, host: 'localhost' },
    });
    await handle.readyPromise;

    await handle.shutdown('test-1');
    await handle.shutdown('test-2');
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test('boot auto-smoke: OK_DEBUG_KEYRING_SMOKE=1 + OUT path writes JSON atomically', async () => {
    const smokeResult: KeyringSmokeResult = {
      ok: true,
      backend: 'keyring',
      durationMs: 12,
      timestamp: '2026-04-21T00:00:00.000Z',
    };
    const runSmoke = vi.fn(() => Promise.resolve(smokeResult));
    const writeSmokeResult = vi.fn(() => Promise.resolve());

    setupUtility({
      parentPort: env.parentPort,
      importServer: () =>
        Promise.resolve({} as unknown as typeof import('@inkeep/open-knowledge-server')),
      exit: env.exit,
      parentPid: 99999,
      killProbe: env.killProbe,
      onSignal: (sig, h) => env.signalHandlers.set(sig, h),
      setInterval: (cb, ms) => {
        env.intervals.push({ cb, ms });
        return { unref: vi.fn(() => {}), clear: env.intervalCancel };
      },
      runSmoke,
      env: {
        OK_DEBUG_KEYRING_SMOKE: '1',
        OK_DEBUG_KEYRING_SMOKE_OUT: '/tmp/smoke-out.json',
      },
      writeSmokeResult,
    });

    await wait(5);

    expect(runSmoke).toHaveBeenCalledTimes(1);
    expect(writeSmokeResult).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenContents] = writeSmokeResult.mock.calls[0] as [string, string];
    expect(writtenPath).toBe('/tmp/smoke-out.json');
    const parsed = JSON.parse(writtenContents) as KeyringSmokeResult;
    expect(parsed).toEqual(smokeResult);
    expect(writtenContents.endsWith('\n')).toBe(true);
    expect(env.exit).not.toHaveBeenCalled();
  });

  test('boot auto-smoke + EXIT=1: calls exit(0) after write, does NOT register listener', async () => {
    const smokeResult: KeyringSmokeResult = {
      ok: true,
      backend: 'keyring',
      durationMs: 5,
      timestamp: '2026-04-21T00:00:00.000Z',
    };
    const runSmoke = vi.fn(() => Promise.resolve(smokeResult));
    const writeSmokeResult = vi.fn(() => Promise.resolve());

    setupUtility({
      parentPort: env.parentPort,
      importServer: () =>
        Promise.resolve({} as unknown as typeof import('@inkeep/open-knowledge-server')),
      exit: env.exit,
      parentPid: 99999,
      killProbe: env.killProbe,
      onSignal: (sig, h) => env.signalHandlers.set(sig, h),
      setInterval: (cb, ms) => {
        env.intervals.push({ cb, ms });
        return { unref: vi.fn(() => {}), clear: env.intervalCancel };
      },
      runSmoke,
      env: {
        OK_DEBUG_KEYRING_SMOKE: '1',
        OK_DEBUG_KEYRING_SMOKE_OUT: '/tmp/smoke-exit.json',
        OK_DEBUG_KEYRING_SMOKE_EXIT: '1',
      },
      writeSmokeResult,
    });

    await wait(5);

    expect(runSmoke).toHaveBeenCalledTimes(1);
    expect(writeSmokeResult).toHaveBeenCalledTimes(1);
    expect(env.exit).toHaveBeenCalledWith(0);
    expect(env.parentPort.on).not.toHaveBeenCalled();
  });

  test('boot auto-smoke: OK_DEBUG_KEYRING_SMOKE=1 without OUT path still posts IPC result', async () => {
    const smokeResult: KeyringSmokeResult = {
      ok: true,
      backend: 'keyring',
      durationMs: 8,
      timestamp: '2026-04-21T00:00:00.000Z',
    };
    const runSmoke = vi.fn(() => Promise.resolve(smokeResult));
    const writeSmokeResult = vi.fn(() => Promise.resolve());

    setupUtility({
      parentPort: env.parentPort,
      importServer: () =>
        Promise.resolve({} as unknown as typeof import('@inkeep/open-knowledge-server')),
      exit: env.exit,
      parentPid: 99999,
      killProbe: env.killProbe,
      onSignal: (sig, h) => env.signalHandlers.set(sig, h),
      setInterval: (cb, ms) => {
        env.intervals.push({ cb, ms });
        return { unref: vi.fn(() => {}), clear: env.intervalCancel };
      },
      runSmoke,
      env: { OK_DEBUG_KEYRING_SMOKE: '1' },
      writeSmokeResult,
    });

    await wait(5);

    expect(runSmoke).toHaveBeenCalledTimes(1);
    expect(writeSmokeResult).not.toHaveBeenCalled();
    expect(env.parentPort.postMessage).toHaveBeenCalledWith({
      type: 'debug-keyring-smoke-result',
      correlationId: 'auto-boot',
      result: smokeResult,
    });
    expect(env.parentPort.on).toHaveBeenCalled();
  });

  test('boot auto-smoke: env unset → no smoke runs, listener registered immediately', async () => {
    const runSmoke = vi.fn(() =>
      Promise.resolve({ ok: true, timestamp: 'x' } as KeyringSmokeResult),
    );

    setupUtility({
      parentPort: env.parentPort,
      importServer: () =>
        Promise.resolve({} as unknown as typeof import('@inkeep/open-knowledge-server')),
      exit: env.exit,
      parentPid: 99999,
      killProbe: env.killProbe,
      onSignal: (sig, h) => env.signalHandlers.set(sig, h),
      setInterval: (cb, ms) => {
        env.intervals.push({ cb, ms });
        return { unref: vi.fn(() => {}), clear: env.intervalCancel };
      },
      runSmoke,
      env: {},
    });

    await wait(5);

    expect(runSmoke).not.toHaveBeenCalled();
    expect(env.parentPort.on).toHaveBeenCalled();
  });

  test('boot auto-smoke: write failure logs + continues (does NOT exit or hang)', async () => {
    const smokeResult: KeyringSmokeResult = {
      ok: true,
      backend: 'keyring',
      durationMs: 3,
      timestamp: '2026-04-21T00:00:00.000Z',
    };
    const runSmoke = vi.fn(() => Promise.resolve(smokeResult));
    const writeSmokeResult = vi.fn(() => Promise.reject(new Error('EACCES')));

    setupUtility({
      parentPort: env.parentPort,
      importServer: () =>
        Promise.resolve({} as unknown as typeof import('@inkeep/open-knowledge-server')),
      exit: env.exit,
      parentPid: 99999,
      killProbe: env.killProbe,
      onSignal: (sig, h) => env.signalHandlers.set(sig, h),
      setInterval: (cb, ms) => {
        env.intervals.push({ cb, ms });
        return { unref: vi.fn(() => {}), clear: env.intervalCancel };
      },
      runSmoke,
      env: {
        OK_DEBUG_KEYRING_SMOKE: '1',
        OK_DEBUG_KEYRING_SMOKE_OUT: '/tmp/unwritable/smoke.json',
      },
      writeSmokeResult,
    });

    await wait(5);

    expect(runSmoke).toHaveBeenCalledTimes(1);
    expect(writeSmokeResult).toHaveBeenCalledTimes(1);
    expect(env.exit).not.toHaveBeenCalled();
    expect(env.parentPort.on).toHaveBeenCalled();
  });

  test('debug-keyring-smoke IPC: invokes injected runSmoke and echoes correlationId', async () => {
    const smokeResult: KeyringSmokeResult = {
      ok: true,
      backend: 'keyring',
      durationMs: 7,
      timestamp: '2026-04-21T00:00:00.000Z',
    };
    const runSmoke = vi.fn(() => Promise.resolve(smokeResult));

    setupUtility({
      parentPort: env.parentPort,
      importServer: () =>
        Promise.resolve({
          bootServer: vi.fn(() => Promise.resolve({})),
        } as unknown as typeof import('@inkeep/open-knowledge-server')),
      exit: env.exit,
      parentPid: 99999,
      killProbe: env.killProbe,
      onSignal: (sig, h) => env.signalHandlers.set(sig, h),
      setInterval: (cb, ms) => {
        env.intervals.push({ cb, ms });
        return { unref: vi.fn(() => {}), clear: env.intervalCancel };
      },
      runSmoke,
    });

    env.parentPort.fire({ type: 'debug-keyring-smoke', correlationId: 'abc-123' });
    await wait(5);

    expect(runSmoke).toHaveBeenCalledTimes(1);
    expect(env.parentPort.postMessage).toHaveBeenCalledWith({
      type: 'debug-keyring-smoke-result',
      correlationId: 'abc-123',
      result: smokeResult,
    });
  });

  test('degraded subsystems are reported via separate IPC after ready', async () => {
    const fakeBooted = {
      port: 51234,
      destroy: vi.fn(() => Promise.resolve()),
      degraded: ['shadow-repo'] as readonly string[],
    };
    const bootServer = vi.fn(() => Promise.resolve(fakeBooted));

    const handle = setupUtility({
      parentPort: env.parentPort,
      importServer: () =>
        Promise.resolve({
          bootServer,
        } as unknown as typeof import('@inkeep/open-knowledge-server')),
      exit: env.exit,
      parentPid: 99999,
      killProbe: env.killProbe,
      onSignal: (sig, h) => env.signalHandlers.set(sig, h),
      setInterval: (cb, ms) => {
        env.intervals.push({ cb, ms });
        return { unref: vi.fn(() => {}), clear: env.intervalCancel };
      },
      prepareBootEnvironment: fakePrepare(),
    });

    env.parentPort.fire({
      type: 'init',
      opts: { contentDir: '/tmp/x', projectDir: '/tmp/x', port: 0, host: 'localhost' },
    });
    await handle.readyPromise;

    expect(env.parentPort.postMessage).toHaveBeenCalledWith({
      type: 'degraded',
      subsystems: ['shadow-repo'],
    });
  });
});

describe('handleInit boot prelude (FR-16/17/18/19/22/24)', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = buildEnv();
  });

  test('loaded config.content.dir overrides IPC contentDir hint', async () => {
    const config = ConfigSchema.parse({ content: { dir: 'docs' } });
    const prepared = makeFakePrepared({
      config,
      contentDir: '/projects/myrepo/docs',
      contentRoot: 'docs',
    });
    const fakeBooted = {
      port: 4242,
      destroy: vi.fn(() => Promise.resolve()),
      degraded: [] as readonly string[],
    };
    const bootServer = vi.fn(() => Promise.resolve(fakeBooted));

    const handle = setupUtility({
      parentPort: env.parentPort,
      importServer: () =>
        Promise.resolve({
          bootServer,
        } as unknown as typeof import('@inkeep/open-knowledge-server')),
      exit: env.exit,
      parentPid: 99999,
      killProbe: env.killProbe,
      onSignal: (sig, h) => env.signalHandlers.set(sig, h),
      setInterval: (cb, ms) => {
        env.intervals.push({ cb, ms });
        return { unref: vi.fn(() => {}), clear: env.intervalCancel };
      },
      prepareBootEnvironment: fakePrepare(prepared),
    });

    env.parentPort.fire({
      type: 'init',
      opts: {
        contentDir: '/projects/myrepo',
        projectDir: '/projects/myrepo',
        port: 0,
        host: 'localhost',
      },
    });
    await handle.readyPromise;

    const callArgs = bootServer.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(callArgs?.contentDir).toBe('/projects/myrepo/docs');
    expect(callArgs?.contentRoot).toBe('docs');
    expect(callArgs?.config).toBe(config);
  });

  test('IPC didEnsureGit + consentVersion are forwarded to the prepare hook', async () => {
    const prepare = fakePrepare();
    const fakeBooted = {
      port: 4242,
      destroy: vi.fn(() => Promise.resolve()),
      degraded: [] as readonly string[],
    };
    const bootServer = vi.fn(() => Promise.resolve(fakeBooted));

    const handle = setupUtility({
      parentPort: env.parentPort,
      importServer: () =>
        Promise.resolve({
          bootServer,
        } as unknown as typeof import('@inkeep/open-knowledge-server')),
      exit: env.exit,
      parentPid: 99999,
      killProbe: env.killProbe,
      onSignal: (sig, h) => env.signalHandlers.set(sig, h),
      setInterval: (cb, ms) => {
        env.intervals.push({ cb, ms });
        return { unref: vi.fn(() => {}), clear: env.intervalCancel };
      },
      prepareBootEnvironment: prepare,
    });

    env.parentPort.fire({
      type: 'init',
      opts: {
        contentDir: '/projects/myrepo',
        projectDir: '/projects/myrepo',
        port: 0,
        host: 'localhost',
        didEnsureGit: true,
        consentVersion: 1,
      },
    });
    await handle.readyPromise;

    const ipcArgs = prepare.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(ipcArgs?.didEnsureGit).toBe(true);
    expect(ipcArgs?.consentVersion).toBe(1);
    expect(ipcArgs?.projectDir).toBe('/projects/myrepo');
  });

  test('OK_DEBUG_DESKTOP_BOOT_TRACE=1 logs the resolved config trace', async () => {
    const fakeBooted = {
      port: 4242,
      destroy: vi.fn(() => Promise.resolve()),
      degraded: [] as readonly string[],
    };
    const bootServer = vi.fn(() => Promise.resolve(fakeBooted));
    const warnSpy = vi.fn(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;
    try {
      const handle = setupUtility({
        parentPort: env.parentPort,
        importServer: () =>
          Promise.resolve({
            bootServer,
          } as unknown as typeof import('@inkeep/open-knowledge-server')),
        exit: env.exit,
        parentPid: 99999,
        killProbe: env.killProbe,
        onSignal: (sig, h) => env.signalHandlers.set(sig, h),
        setInterval: (cb, ms) => {
          env.intervals.push({ cb, ms });
          return { unref: vi.fn(() => {}), clear: env.intervalCancel };
        },
        prepareBootEnvironment: fakePrepare(
          makeFakePrepared({
            contentDir: '/projects/myrepo/docs',
            contentRoot: 'docs',
            configValid: true,
          }),
        ),
        env: { OK_DEBUG_DESKTOP_BOOT_TRACE: '1' },
      });

      env.parentPort.fire({
        type: 'init',
        opts: {
          contentDir: '/projects/myrepo',
          projectDir: '/projects/myrepo',
          port: 0,
          host: 'localhost',
        },
      });
      await handle.readyPromise;

      const traceCall = warnSpy.mock.calls.find((args) =>
        String(args[0] ?? '').startsWith('[desktop-boot-trace]'),
      );
      expect(traceCall).toBeDefined();
      const traceLine = String(traceCall?.[0] ?? '');
      expect(traceLine).toContain('projectDir=/projects/myrepo');
      expect(traceLine).toContain('contentRoot="docs"');
      expect(traceLine).toContain('resolvedContentDir=/projects/myrepo/docs');
      expect(traceLine).toContain('configValid=true');
    } finally {
      console.warn = originalWarn;
    }
  });

  test('bootServer always receives a full ConfigSchema-parsed object (FR-19a)', async () => {
    const config = ConfigSchema.parse({});
    const prepared = makeFakePrepared({ config, configValid: false });
    const fakeBooted = {
      port: 4242,
      destroy: vi.fn(() => Promise.resolve()),
      degraded: [] as readonly string[],
    };
    const bootServer = vi.fn(() => Promise.resolve(fakeBooted));

    const handle = setupUtility({
      parentPort: env.parentPort,
      importServer: () =>
        Promise.resolve({
          bootServer,
        } as unknown as typeof import('@inkeep/open-knowledge-server')),
      exit: env.exit,
      parentPid: 99999,
      killProbe: env.killProbe,
      onSignal: (sig, h) => env.signalHandlers.set(sig, h),
      setInterval: (cb, ms) => {
        env.intervals.push({ cb, ms });
        return { unref: vi.fn(() => {}), clear: env.intervalCancel };
      },
      prepareBootEnvironment: fakePrepare(prepared),
    });

    env.parentPort.fire({
      type: 'init',
      opts: {
        contentDir: '/projects/myrepo',
        projectDir: '/projects/myrepo',
        port: 0,
        host: 'localhost',
      },
    });
    await handle.readyPromise;

    const callArgs = bootServer.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(callArgs?.config).toBeDefined();
    const passedConfig = callArgs?.config as { content?: { dir?: unknown } } | undefined;
    expect(passedConfig?.content?.dir).toBeDefined();
  });
});

describe('resolveContentDir (FR-17 unit)', () => {
  test('empty config.content.dir falls back to ipcFallback', () => {
    const config = ConfigSchema.parse({ content: { dir: '' } });
    expect(resolveContentDir('/projects/myrepo', config, '/ipc/picked')).toBe('/ipc/picked');
  });

  test('"." falls back to ipcFallback', () => {
    const config = ConfigSchema.parse({ content: { dir: '.' } });
    expect(resolveContentDir('/projects/myrepo', config, '/ipc/picked')).toBe('/ipc/picked');
  });

  test('non-trivial relative content.dir wins over ipcFallback', () => {
    const config = ConfigSchema.parse({ content: { dir: 'docs' } });
    expect(resolveContentDir('/projects/myrepo', config, '/ipc/picked')).toBe(
      '/projects/myrepo/docs',
    );
  });

  test('absolute content.dir inside projectDir is honored', () => {
    const config = ConfigSchema.parse({ content: { dir: '/projects/myrepo/docs' } });
    expect(resolveContentDir('/projects/myrepo', config, '/ipc/picked')).toBe(
      '/projects/myrepo/docs',
    );
  });

  test('".." escape falls back to ipcFallback (defense-in-depth)', () => {
    const warnSpy = vi.fn(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;
    try {
      const config = ConfigSchema.parse({ content: { dir: '../escape' } });
      expect(resolveContentDir('/projects/myrepo', config, '/ipc/picked')).toBe('/ipc/picked');
      const escapeWarning = warnSpy.mock.calls.find((args) =>
        String(args[0] ?? '').includes('content.dir='),
      );
      expect(escapeWarning).toBeDefined();
    } finally {
      console.warn = originalWarn;
    }
  });

  test('absolute content.dir outside projectDir falls back to ipcFallback', () => {
    const warnSpy = vi.fn(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;
    try {
      const config = ConfigSchema.parse({ content: { dir: '/elsewhere/secrets' } });
      expect(resolveContentDir('/projects/myrepo', config, '/ipc/picked')).toBe('/ipc/picked');
    } finally {
      console.warn = originalWarn;
    }
  });

  test('undefined ipcFallback defaults to projectDir for the empty/. case', () => {
    const config = ConfigSchema.parse({});
    expect(resolveContentDir('/projects/myrepo', config, undefined)).toBe('/projects/myrepo');
  });
});

describe('handleInit defaultPrepareBootEnvironment (integration)', () => {
  let env: MockEnv;
  let tmpRoot: string;

  beforeEach(() => {
    env = buildEnv();
    tmpRoot = mkdtempSync(resolve(tmpdir(), 'ok-utility-prelude-'));
  });

  test('loads real .ok/config.yml + resolves content.dir via the production prelude', async () => {
    mkdirSync(resolve(tmpRoot, '.git'), { recursive: true });
    writeFileSync(resolve(tmpRoot, '.git/HEAD'), 'ref: refs/heads/main\n', 'utf-8');
    mkdirSync(resolve(tmpRoot, '.ok'), { recursive: true });
    writeFileSync(
      resolve(tmpRoot, '.ok/config.yml'),
      'version: 1\ncontent:\n  dir: docs\n',
      'utf-8',
    );
    mkdirSync(resolve(tmpRoot, 'docs'), { recursive: true });

    const fakeBooted = {
      port: 4242,
      destroy: vi.fn(() => Promise.resolve()),
      degraded: [] as readonly string[],
    };
    const bootServer = vi.fn(() => Promise.resolve(fakeBooted));

    const handle = setupUtility({
      parentPort: env.parentPort,
      importServer: () =>
        Promise.resolve({
          bootServer,
        } as unknown as typeof import('@inkeep/open-knowledge-server')),
      exit: env.exit,
      parentPid: 99999,
      killProbe: env.killProbe,
      onSignal: (sig, h) => env.signalHandlers.set(sig, h),
      setInterval: (cb, ms) => {
        env.intervals.push({ cb, ms });
        return { unref: vi.fn(() => {}), clear: env.intervalCancel };
      },
    });

    env.parentPort.fire({
      type: 'init',
      opts: {
        contentDir: tmpRoot,
        projectDir: tmpRoot,
        port: 0,
        host: 'localhost',
        didEnsureGit: true,
      },
    });
    await handle.readyPromise;

    const callArgs = bootServer.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(callArgs?.contentDir).toBe(resolve(tmpRoot, 'docs'));
    expect(callArgs?.contentRoot).toBe('docs');
    const passedConfig = callArgs?.config as { content?: { dir?: unknown } } | undefined;
    expect(passedConfig?.content?.dir).toBe('docs');

    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('didEnsureGit=false runs ensureProjectGit which scaffolds a real .git/', async () => {
    const fakeBooted = {
      port: 4242,
      destroy: vi.fn(() => Promise.resolve()),
      degraded: [] as readonly string[],
    };
    const bootServer = vi.fn(() => Promise.resolve(fakeBooted));

    const handle = setupUtility({
      parentPort: env.parentPort,
      importServer: () =>
        Promise.resolve({
          bootServer,
        } as unknown as typeof import('@inkeep/open-knowledge-server')),
      exit: env.exit,
      parentPid: 99999,
      killProbe: env.killProbe,
      onSignal: (sig, h) => env.signalHandlers.set(sig, h),
      setInterval: (cb, ms) => {
        env.intervals.push({ cb, ms });
        return { unref: vi.fn(() => {}), clear: env.intervalCancel };
      },
    });

    env.parentPort.fire({
      type: 'init',
      opts: {
        contentDir: tmpRoot,
        projectDir: tmpRoot,
        port: 0,
        host: 'localhost',
      },
    });
    await handle.readyPromise;

    const headPath = resolve(tmpRoot, '.git/HEAD');
    const configPath = resolve(tmpRoot, '.ok/config.yml');
    const headStat = execFileSync('test', ['-f', headPath], { encoding: 'utf-8' });
    expect(headStat).toBe('');
    const configStat = execFileSync('test', ['-f', configPath], { encoding: 'utf-8' });
    expect(configStat).toBe('');

    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('invalid YAML config falls back to schema defaults and logs warning', async () => {
    mkdirSync(resolve(tmpRoot, '.git'), { recursive: true });
    writeFileSync(resolve(tmpRoot, '.git/HEAD'), 'ref: refs/heads/main\n', 'utf-8');
    mkdirSync(resolve(tmpRoot, '.ok'), { recursive: true });
    writeFileSync(resolve(tmpRoot, '.ok/config.yml'), 'version: 1\ncontent: {\n', 'utf-8');

    const fakeBooted = {
      port: 4242,
      destroy: vi.fn(() => Promise.resolve()),
      degraded: [] as readonly string[],
    };
    const bootServer = vi.fn(() => Promise.resolve(fakeBooted));

    const warnSpy = vi.fn(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;
    try {
      const handle = setupUtility({
        parentPort: env.parentPort,
        importServer: () =>
          Promise.resolve({
            bootServer,
          } as unknown as typeof import('@inkeep/open-knowledge-server')),
        exit: env.exit,
        parentPid: 99999,
        killProbe: env.killProbe,
        onSignal: (sig, h) => env.signalHandlers.set(sig, h),
        setInterval: (cb, ms) => {
          env.intervals.push({ cb, ms });
          return { unref: vi.fn(() => {}), clear: env.intervalCancel };
        },
      });

      env.parentPort.fire({
        type: 'init',
        opts: {
          contentDir: tmpRoot,
          projectDir: tmpRoot,
          port: 0,
          host: 'localhost',
          didEnsureGit: true,
        },
      });
      await handle.readyPromise;

      const fallbackWarn = warnSpy.mock.calls.find((args) =>
        String(args[0] ?? '').includes('[config] Failed to parse'),
      );
      expect(fallbackWarn).toBeDefined();

      expect(bootServer).toHaveBeenCalled();
      const callArgs = bootServer.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
      const passedConfig = callArgs?.config as { content?: { dir?: unknown } } | undefined;
      expect(passedConfig?.content?.dir).toBe('.');
    } finally {
      console.warn = originalWarn;
    }

    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('initContent is idempotent on re-runs — does not clobber an existing config.yml', async () => {
    mkdirSync(resolve(tmpRoot, '.git'), { recursive: true });
    writeFileSync(resolve(tmpRoot, '.git/HEAD'), 'ref: refs/heads/main\n', 'utf-8');
    mkdirSync(resolve(tmpRoot, '.ok'), { recursive: true });
    const userCustomized = 'version: 1\ncontent:\n  dir: notes\n';
    writeFileSync(resolve(tmpRoot, '.ok/config.yml'), userCustomized, 'utf-8');
    mkdirSync(resolve(tmpRoot, 'notes'), { recursive: true });

    const fakeBooted = {
      port: 4242,
      destroy: vi.fn(() => Promise.resolve()),
      degraded: [] as readonly string[],
    };
    const bootServer = vi.fn(() => Promise.resolve(fakeBooted));

    const handle = setupUtility({
      parentPort: env.parentPort,
      importServer: () =>
        Promise.resolve({
          bootServer,
        } as unknown as typeof import('@inkeep/open-knowledge-server')),
      exit: env.exit,
      parentPid: 99999,
      killProbe: env.killProbe,
      onSignal: (sig, h) => env.signalHandlers.set(sig, h),
      setInterval: (cb, ms) => {
        env.intervals.push({ cb, ms });
        return { unref: vi.fn(() => {}), clear: env.intervalCancel };
      },
    });

    env.parentPort.fire({
      type: 'init',
      opts: {
        contentDir: tmpRoot,
        projectDir: tmpRoot,
        port: 0,
        host: 'localhost',
        didEnsureGit: true,
      },
    });
    await handle.readyPromise;

    const { readFileSync } = await import('node:fs');
    const post = readFileSync(resolve(tmpRoot, '.ok/config.yml'), 'utf-8');
    expect(post).toBe(userCustomized);

    rmSync(tmpRoot, { recursive: true, force: true });
  });
});

const PLANNED_UTILITY_INIT_PHASES = [
  'init-received',
  'imports-resolved',
  'project-git-ensured',
  'boot-server-started',
];

const PHASES_WITHOUT_ENSURING_GIT = PLANNED_UTILITY_INIT_PHASES.filter(
  (phase) => phase !== 'project-git-ensured',
);

function postedToMain(env: MockEnv): UtilityOutgoingMessage[] {
  return env.parentPort.postMessage.mock.calls.map(([message]) => message);
}

function initPhasesPostedToMain(env: MockEnv): unknown[] {
  return postedToMain(env)
    .filter((message) => message.type === 'init-phase')
    .map((message) => message.phase);
}

function countersAtRead(read: number): {
  uptimeMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
} {
  return { uptimeMs: read * 3, cpuUserMs: read * 2, cpuSystemMs: read };
}

function isUsableCounter(counter: unknown): boolean {
  return typeof counter === 'number' && Number.isFinite(counter) && counter >= 0;
}

describe('setupUtility narrates its startup phases to main before it reports ready', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = buildEnv();
  });

  test('marks receiving init, resolving its imports and starting the server, each with the counters read at that mark, then posts ready', async () => {
    const phasesPostedBefore: Record<string, unknown[]> = {};
    let counterReads = 0;
    const fakeBooted = {
      port: 51234,
      destroy: vi.fn(() => Promise.resolve()),
      degraded: [] as readonly string[],
    };
    const bootServer = vi.fn(() => {
      phasesPostedBefore.bootServer = initPhasesPostedToMain(env);
      return Promise.resolve(fakeBooted);
    });
    const plannedDeps = {
      readInitCounters: () => {
        counterReads += 1;
        return countersAtRead(counterReads);
      },
    };

    const handle = setupUtility({
      parentPort: env.parentPort,
      importServer: () => {
        phasesPostedBefore.importServer = initPhasesPostedToMain(env);
        return Promise.resolve({
          bootServer,
        } as unknown as typeof import('@inkeep/open-knowledge-server'));
      },
      exit: env.exit,
      parentPid: 99999,
      killProbe: env.killProbe,
      onSignal: (sig, h) => env.signalHandlers.set(sig, h),
      setInterval: (cb, ms) => {
        env.intervals.push({ cb, ms });
        return { unref: vi.fn(() => {}), clear: env.intervalCancel };
      },
      prepareBootEnvironment: () => {
        phasesPostedBefore.prepare = initPhasesPostedToMain(env);
        return Promise.resolve(makeFakePrepared());
      },
      ...plannedDeps,
    });

    env.parentPort.fire({
      type: 'init',
      opts: { contentDir: '/tmp/x', projectDir: '/tmp/x', port: 0, host: 'localhost' },
    });
    await handle.readyPromise;

    expect(postedToMain(env)).toEqual([
      ...PHASES_WITHOUT_ENSURING_GIT.map((phase, index) => ({
        type: 'init-phase',
        phase,
        ...countersAtRead(index + 1),
      })),
      { type: 'ready', port: 51234, apiOrigin: 'http://localhost:51234' },
    ]);
    expect(phasesPostedBefore).toEqual({
      importServer: PHASES_WITHOUT_ENSURING_GIT.slice(0, 1),
      prepare: PHASES_WITHOUT_ENSURING_GIT.slice(0, 2),
      bootServer: PHASES_WITHOUT_ENSURING_GIT,
    });
  });

  test.each([
    { didEnsureGit: false, markedPhases: PLANNED_UTILITY_INIT_PHASES },
    { didEnsureGit: true, markedPhases: PHASES_WITHOUT_ENSURING_GIT },
  ])(
    'marks ensuring the project git only when it ensured it itself (didEnsureGit=$didEnsureGit), with counters it read itself',
    async ({ didEnsureGit, markedPhases }) => {
      expect(UTILITY_INIT_PHASES).toEqual(PLANNED_UTILITY_INIT_PHASES);
      const tmpRoot = mkdtempSync(resolve(tmpdir(), 'ok-utility-phase-marks-'));
      if (didEnsureGit) {
        mkdirSync(resolve(tmpRoot, '.git'), { recursive: true });
        writeFileSync(resolve(tmpRoot, '.git/HEAD'), 'ref: refs/heads/main\n', 'utf-8');
      }
      try {
        const fakeBooted = {
          port: 4242,
          destroy: vi.fn(() => Promise.resolve()),
          degraded: [] as readonly string[],
        };
        const bootServer = vi.fn(() => Promise.resolve(fakeBooted));
        const handle = setupUtility({
          parentPort: env.parentPort,
          importServer: () =>
            Promise.resolve({
              bootServer,
            } as unknown as typeof import('@inkeep/open-knowledge-server')),
          exit: env.exit,
          parentPid: 99999,
          killProbe: env.killProbe,
          onSignal: (sig, h) => env.signalHandlers.set(sig, h),
          setInterval: (cb, ms) => {
            env.intervals.push({ cb, ms });
            return { unref: vi.fn(() => {}), clear: env.intervalCancel };
          },
        });

        env.parentPort.fire({
          type: 'init',
          opts: {
            contentDir: tmpRoot,
            projectDir: tmpRoot,
            port: 0,
            host: 'localhost',
            didEnsureGit,
          },
        });
        await handle.readyPromise;

        const posted = postedToMain(env);
        const marks = posted.filter((message) => message.type === 'init-phase');
        expect(marks.map((mark) => mark.phase)).toEqual(markedPhases);
        expect(
          marks
            .flatMap((mark) => [mark.uptimeMs, mark.cpuUserMs, mark.cpuSystemMs])
            .filter((counter) => !isUsableCounter(counter)),
        ).toEqual([]);
        expect(posted.findIndex((message) => message.type === 'ready')).toBeGreaterThan(
          posted.findLastIndex((message) => message.type === 'init-phase'),
        );
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    },
  );

  test('reports a failed start as an error after the phase marks it reached', async () => {
    const handle = setupUtility({
      parentPort: env.parentPort,
      importServer: vi.fn(() => Promise.reject(new Error('boot failed'))),
      exit: env.exit,
      parentPid: 99999,
      killProbe: env.killProbe,
      onSignal: (sig, h) => env.signalHandlers.set(sig, h),
      setInterval: (cb, ms) => {
        env.intervals.push({ cb, ms });
        return { unref: vi.fn(() => {}), clear: env.intervalCancel };
      },
    });

    env.parentPort.fire({
      type: 'init',
      opts: { contentDir: '/tmp/x', projectDir: '/tmp/x', port: 0, host: 'localhost' },
    });

    await expect(handle.readyPromise).rejects.toThrow('boot failed');
    expect(
      postedToMain(env).map((message) =>
        message.type === 'init-phase' ? message.phase : message.type,
      ),
    ).toEqual([...PHASES_WITHOUT_ENSURING_GIT.slice(0, 1), 'error']);
    expect(env.exit).toHaveBeenCalledWith(1);
  });

  test('reads its default phase counters in milliseconds of its own uptime and CPU clocks', async () => {
    const tmpRoot = mkdtempSync(resolve(tmpdir(), 'ok-utility-phase-counters-'));
    mkdirSync(resolve(tmpRoot, '.git'), { recursive: true });
    writeFileSync(resolve(tmpRoot, '.git/HEAD'), 'ref: refs/heads/main\n', 'utf-8');
    try {
      const fakeBooted = {
        port: 4243,
        destroy: vi.fn(() => Promise.resolve()),
        degraded: [] as readonly string[],
      };
      const handle = setupUtility({
        parentPort: env.parentPort,
        importServer: () =>
          Promise.resolve({
            bootServer: vi.fn(() => Promise.resolve(fakeBooted)),
          } as unknown as typeof import('@inkeep/open-knowledge-server')),
        exit: env.exit,
        parentPid: 99999,
        killProbe: env.killProbe,
        onSignal: (sig, h) => env.signalHandlers.set(sig, h),
        setInterval: (cb, ms) => {
          env.intervals.push({ cb, ms });
          return { unref: vi.fn(() => {}), clear: env.intervalCancel };
        },
      });

      const beforeInit = ownClocksInMs(Math.floor);
      env.parentPort.fire({
        type: 'init',
        opts: {
          contentDir: tmpRoot,
          projectDir: tmpRoot,
          port: 0,
          host: 'localhost',
          didEnsureGit: true,
        },
      });
      await handle.readyPromise;
      const afterReady = ownClocksInMs(Math.ceil);

      const marks = postedToMain(env).filter((message) => message.type === 'init-phase');
      expect(marks.map((mark) => mark.phase)).toEqual(PHASES_WITHOUT_ENSURING_GIT);
      expect(
        marks.flatMap((mark) =>
          OWN_CLOCK_COUNTERS.filter((counter) => {
            const value = mark[counter];
            return !(
              typeof value === 'number' &&
              value >= beforeInit[counter] &&
              value <= afterReady[counter]
            );
          }).map((counter) => ({
            phase: mark.phase,
            counter,
            value: mark[counter],
            from: beforeInit[counter],
            to: afterReady[counter],
          })),
        ),
      ).toEqual([]);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

const OWN_CLOCK_COUNTERS = ['uptimeMs', 'cpuUserMs', 'cpuSystemMs'] as const;

function ownClocksInMs(
  round: (ms: number) => number,
): Record<(typeof OWN_CLOCK_COUNTERS)[number], number> {
  const cpu = process.cpuUsage();
  return {
    uptimeMs: round(process.uptime() * 1000),
    cpuUserMs: round(cpu.user / 1000),
    cpuSystemMs: round(cpu.system / 1000),
  };
}

function startUtilityWhoseBootPreparationWaits(env: MockEnv): {
  bootServer: Mock<
    () => Promise<{ port: number; destroy: () => Promise<void>; degraded: readonly string[] }>
  >;
  reachedBootPreparation: Promise<void>;
  finishBootPreparation: () => void;
} {
  let enterBootPreparation!: () => void;
  let finishBootPreparation!: () => void;
  const entered = new Promise<void>((resolve) => {
    enterBootPreparation = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    finishBootPreparation = resolve;
  });
  const bootServer = vi.fn(() =>
    Promise.resolve({
      port: 51289,
      destroy: () => Promise.resolve(),
      degraded: [] as readonly string[],
    }),
  );
  const handle = setupUtility({
    parentPort: env.parentPort,
    importServer: () =>
      Promise.resolve({
        bootServer,
      } as unknown as typeof import('@inkeep/open-knowledge-server')),
    exit: env.exit,
    parentPid: 99999,
    killProbe: env.killProbe,
    onSignal: (sig, h) => env.signalHandlers.set(sig, h),
    setInterval: (cb, ms) => {
      env.intervals.push({ cb, ms });
      return { unref: vi.fn(() => {}), clear: env.intervalCancel };
    },
    prepareBootEnvironment: async () => {
      enterBootPreparation();
      await finished;
      return makeFakePrepared();
    },
  });

  env.parentPort.fire({
    type: 'init',
    opts: { contentDir: '/tmp/x', projectDir: '/tmp/x', port: 0, host: 'localhost' },
  });
  return {
    bootServer,
    reachedBootPreparation: Promise.race([entered, handle.readyPromise.then(() => {})]),
    finishBootPreparation,
  };
}

async function finishBootPreparationAndLetInitContinue(finish: () => void): Promise<void> {
  finish();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('setupUtility honours a shutdown that arrives before its init reaches bootServer', () => {
  test('exits 0 without calling bootServer when shutdown arrives while its init is still preparing the boot environment', async () => {
    const withoutShutdown = startUtilityWhoseBootPreparationWaits(buildEnv());
    await withoutShutdown.reachedBootPreparation;
    await finishBootPreparationAndLetInitContinue(withoutShutdown.finishBootPreparation);
    expect(withoutShutdown.bootServer).toHaveBeenCalledTimes(1);

    const env = buildEnv();
    const utility = startUtilityWhoseBootPreparationWaits(env);
    await utility.reachedBootPreparation;
    expect(utility.bootServer).not.toHaveBeenCalled();

    env.parentPort.fire({ type: 'shutdown' });
    await finishBootPreparationAndLetInitContinue(utility.finishBootPreparation);

    expect(utility.bootServer).not.toHaveBeenCalled();
    expect(env.exit.mock.calls).toEqual([[0]]);
  });
});
