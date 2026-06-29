import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { ConfigSchema } from '@inkeep/open-knowledge-server';
import type { KeyringSmokeResult } from '../../src/utility/keyring-smoke.ts';
import {
  type PreparedBootEnvironment,
  resolveContentDir,
  setupUtility,
} from '../../src/utility/server-entry.ts';


interface MockParentPort {
  on: ReturnType<typeof mock>;
  postMessage: ReturnType<typeof mock>;
  fire: (msg: unknown) => void;
}

function mockParentPort(): MockParentPort {
  let handler: ((event: { data: unknown }) => void) | null = null;
  const on = mock((_event: 'message', h: (event: { data: unknown }) => void) => {
    handler = h;
  });
  return {
    on,
    postMessage: mock(() => {}),
    fire: (msg: unknown) => handler?.({ data: msg }),
  };
}

interface MockEnv {
  parentPort: MockParentPort;
  exit: ReturnType<typeof mock>;
  killProbe: ReturnType<typeof mock>;
  signalHandlers: Map<string, () => void>;
  intervals: Array<{ cb: () => void; ms: number }>;
  intervalCancel: ReturnType<typeof mock>;
}

function buildEnv(): MockEnv {
  const env: MockEnv = {
    parentPort: mockParentPort(),
    exit: mock(() => {}),
    killProbe: mock(() => {}),
    signalHandlers: new Map(),
    intervals: [],
    intervalCancel: mock(() => {}),
  };
  return env;
}

function makeFakePrepared(overrides?: Partial<PreparedBootEnvironment>): PreparedBootEnvironment {
  return {
    config: ConfigSchema.parse({}),
    contentDir: '/fake/content',
    contentRoot: undefined,
    configValid: true,
    ...overrides,
  };
}

function fakePrepare(returnValue?: PreparedBootEnvironment) {
  return mock(() => Promise.resolve(returnValue ?? makeFakePrepared()));
}

describe('setupUtility (IPC handshake + lifecycle)', () => {
  let env: MockEnv;

  beforeEach(() => {
    env = buildEnv();
  });

  test('on init message: imports server, calls bootServer with M1 opt-outs, posts ready', async () => {
    const fakeBooted = {
      port: 51234,
      destroy: mock(() => Promise.resolve()),
      degraded: [] as readonly string[],
    };
    const bootServer = mock(() => Promise.resolve(fakeBooted));
    const importServer = mock(() =>
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
        return { unref: mock(() => {}), clear: env.intervalCancel };
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
    expect(callArgs?.attachUiSibling).toBe(false);
    expect(callArgs?.idleShutdownMs).toBe(null);
    expect(callArgs?.skipAutoInit).toBe(true);
    expect(callArgs?.autoInitFn).toBeUndefined();
    expect(callArgs?.contentDir).toBe('/fake/test-project');
    expect(callArgs?.config).toBe(prepared.config);

    expect(env.parentPort.postMessage).toHaveBeenCalledWith({
      type: 'ready',
      port: 51234,
      apiOrigin: 'http://localhost:51234',
    });
  });

  test('on init failure: posts error and exits non-zero', async () => {
    const importServer = mock(() => Promise.reject(new Error('boot failed')));
    const handle = setupUtility({
      parentPort: env.parentPort,
      importServer,
      exit: env.exit,
      parentPid: 99999,
      killProbe: env.killProbe,
      onSignal: (sig, h) => env.signalHandlers.set(sig, h),
      setInterval: (cb, ms) => {
        env.intervals.push({ cb, ms });
        return { unref: mock(() => {}), clear: env.intervalCancel };
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
      destroy: mock(() => Promise.resolve()),
      degraded: [] as readonly string[],
    };
    const bootServer = mock(() => Promise.resolve(fakeBooted));

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
        return { unref: mock(() => {}), clear: env.intervalCancel };
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
    const destroy = mock(() => Promise.resolve());
    const fakeBooted = { port: 51234, destroy, degraded: [] as readonly string[] };
    const bootServer = mock(() => Promise.resolve(fakeBooted));

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
        return { unref: mock(() => {}), clear: env.intervalCancel };
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
    const destroy = mock(() => Promise.resolve());
    const fakeBooted = { port: 51234, destroy, degraded: [] as readonly string[] };
    const bootServer = mock(() => Promise.resolve(fakeBooted));

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
        return { unref: mock(() => {}), clear: env.intervalCancel };
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
    const destroy = mock(() => Promise.resolve());
    const fakeBooted = { port: 51234, destroy, degraded: [] as readonly string[] };
    const bootServer = mock(() => Promise.resolve(fakeBooted));

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
        return { unref: mock(() => {}), clear: env.intervalCancel };
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
    const runSmoke = mock(() => Promise.resolve(smokeResult));
    const writeSmokeResult = mock(() => Promise.resolve());

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
        return { unref: mock(() => {}), clear: env.intervalCancel };
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
    const runSmoke = mock(() => Promise.resolve(smokeResult));
    const writeSmokeResult = mock(() => Promise.resolve());

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
        return { unref: mock(() => {}), clear: env.intervalCancel };
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
    const runSmoke = mock(() => Promise.resolve(smokeResult));
    const writeSmokeResult = mock(() => Promise.resolve());

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
        return { unref: mock(() => {}), clear: env.intervalCancel };
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
    const runSmoke = mock(() =>
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
        return { unref: mock(() => {}), clear: env.intervalCancel };
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
    const runSmoke = mock(() => Promise.resolve(smokeResult));
    const writeSmokeResult = mock(() => Promise.reject(new Error('EACCES')));

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
        return { unref: mock(() => {}), clear: env.intervalCancel };
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
    const runSmoke = mock(() => Promise.resolve(smokeResult));

    setupUtility({
      parentPort: env.parentPort,
      importServer: () =>
        Promise.resolve({
          bootServer: mock(() => Promise.resolve({})),
        } as unknown as typeof import('@inkeep/open-knowledge-server')),
      exit: env.exit,
      parentPid: 99999,
      killProbe: env.killProbe,
      onSignal: (sig, h) => env.signalHandlers.set(sig, h),
      setInterval: (cb, ms) => {
        env.intervals.push({ cb, ms });
        return { unref: mock(() => {}), clear: env.intervalCancel };
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
      destroy: mock(() => Promise.resolve()),
      degraded: ['shadow-repo'] as readonly string[],
    };
    const bootServer = mock(() => Promise.resolve(fakeBooted));

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
        return { unref: mock(() => {}), clear: env.intervalCancel };
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
      destroy: mock(() => Promise.resolve()),
      degraded: [] as readonly string[],
    };
    const bootServer = mock(() => Promise.resolve(fakeBooted));

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
        return { unref: mock(() => {}), clear: env.intervalCancel };
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
      destroy: mock(() => Promise.resolve()),
      degraded: [] as readonly string[],
    };
    const bootServer = mock(() => Promise.resolve(fakeBooted));

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
        return { unref: mock(() => {}), clear: env.intervalCancel };
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
      destroy: mock(() => Promise.resolve()),
      degraded: [] as readonly string[],
    };
    const bootServer = mock(() => Promise.resolve(fakeBooted));
    const warnSpy = mock(() => {});
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
          return { unref: mock(() => {}), clear: env.intervalCancel };
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
      destroy: mock(() => Promise.resolve()),
      degraded: [] as readonly string[],
    };
    const bootServer = mock(() => Promise.resolve(fakeBooted));

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
        return { unref: mock(() => {}), clear: env.intervalCancel };
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
    const warnSpy = mock(() => {});
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
    const warnSpy = mock(() => {});
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
      destroy: mock(() => Promise.resolve()),
      degraded: [] as readonly string[],
    };
    const bootServer = mock(() => Promise.resolve(fakeBooted));

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
        return { unref: mock(() => {}), clear: env.intervalCancel };
      },
    });

    env.parentPort.fire({
      type: 'init',
      opts: {
        contentDir: tmpRoot,
        projectDir: tmpRoot,
        port: 0,
        host: 'localhost',
        didEnsureGit: true, // skip real git resolution; .git/HEAD is already present anyway
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
      destroy: mock(() => Promise.resolve()),
      degraded: [] as readonly string[],
    };
    const bootServer = mock(() => Promise.resolve(fakeBooted));

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
        return { unref: mock(() => {}), clear: env.intervalCancel };
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
      destroy: mock(() => Promise.resolve()),
      degraded: [] as readonly string[],
    };
    const bootServer = mock(() => Promise.resolve(fakeBooted));

    const warnSpy = mock(() => {});
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
          return { unref: mock(() => {}), clear: env.intervalCancel };
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
        String(args[0] ?? '').includes('[config] desktop boot config invalid'),
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
      destroy: mock(() => Promise.resolve()),
      degraded: [] as readonly string[],
    };
    const bootServer = mock(() => Promise.resolve(fakeBooted));

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
        return { unref: mock(() => {}), clear: env.intervalCancel };
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
