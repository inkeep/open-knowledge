import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { ServerRuntimeConfig } from '@inkeep/open-knowledge-core';
import type { BootedServer, BootServerOptions } from '@inkeep/open-knowledge-server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SetupUtilityDeps, UtilityHandle } from './server-entry.ts';

let fakeHome = resolve(tmpdir(), '__ok_desktop_home_default__');
await vi.doMock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => fakeHome };
});

const { resolveDesktopServerRuntime, setupUtility } = await import('./server-entry');

let testDir: string;

beforeEach(() => {
  testDir = resolve(
    tmpdir(),
    `ok-desktop-entry-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  fakeHome = resolve(testDir, '__home__');
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function writeProjectConfig(yaml: string) {
  const dir = resolve(testDir, '.ok');
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'config.yml'), yaml, 'utf-8');
}

function writeLocalConfig(yaml: string) {
  const dir = resolve(testDir, '.ok', 'local');
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'config.yml'), yaml, 'utf-8');
}

describe('resolveDesktopServerRuntime — scope-correct three-layer load', () => {
  test('honors a project-local server.allowExternal (the desktop consent path)', () => {
    writeLocalConfig('server:\n  allowExternal: true\n');
    const { serverRuntime, configValid } = resolveDesktopServerRuntime(testDir);
    expect(configValid).toBe(true);
    expect(serverRuntime.allowExternal).toBe(true);
  });

  test('a committed server.allowExternal stays inert (clone-leak guard)', () => {
    writeProjectConfig('server:\n  allowExternal: true\n');
    const { serverRuntime } = resolveDesktopServerRuntime(testDir);
    expect(serverRuntime.allowExternal).toBe(false);
  });

  test('project-local wins over a committed allowExternal in either direction', () => {
    writeProjectConfig('server:\n  allowExternal: true\n');
    writeLocalConfig('server:\n  allowExternal: false\n');
    expect(resolveDesktopServerRuntime(testDir).serverRuntime.allowExternal).toBe(false);

    rmSync(resolve(testDir, '.ok'), { recursive: true, force: true });
    writeProjectConfig('server:\n  allowExternal: false\n');
    writeLocalConfig('server:\n  allowExternal: true\n');
    expect(resolveDesktopServerRuntime(testDir).serverRuntime.allowExternal).toBe(true);
  });

  test('surfaces committed server.externalUrl + server.port (project scope, honest boot)', () => {
    writeProjectConfig('server:\n  externalUrl: https://box.tailnet.ts.net\n  port: 24550\n');
    const { serverRuntime } = resolveDesktopServerRuntime(testDir);
    expect(serverRuntime.externalUrl).toBe('https://box.tailnet.ts.net');
    expect(serverRuntime.port).toBe(24550);
  });

  test('a project-local consent + committed externalUrl together admit the tunnel', () => {
    writeProjectConfig('server:\n  externalUrl: https://box.tailnet.ts.net\n  port: 24550\n');
    writeLocalConfig('server:\n  allowExternal: true\n');
    const { serverRuntime } = resolveDesktopServerRuntime(testDir);
    expect(serverRuntime.allowExternal).toBe(true);
    expect(serverRuntime.externalUrl).toBe('https://box.tailnet.ts.net');
  });

  test('degrades to schema defaults (consent forced off) on a schema-invalid config', () => {
    writeProjectConfig('server:\n  port: "abc"\n');
    const { config, configValid, serverRuntime } = resolveDesktopServerRuntime(testDir);
    expect(configValid).toBe(false);
    expect(serverRuntime.allowExternal).toBe(false);
    expect(serverRuntime.loopbackOnly).toBe(true);
    expect(config.server?.allowExternal ?? false).toBe(false);
  });

  test('no config files at all resolves to loopback-only defaults', () => {
    const { serverRuntime, configValid } = resolveDesktopServerRuntime(testDir);
    expect(configValid).toBe(true);
    expect(serverRuntime.allowExternal).toBe(false);
    expect(serverRuntime.loopbackOnly).toBe(true);
  });
});

function makeServerRuntime(port: number | undefined): ServerRuntimeConfig {
  return {
    port,
    bind: ['127.0.0.1'],
    externalUrl: undefined,
    allowExternal: false,
    openBrowser: false,
    idleShutdown: '30m',
    loopbackOnly: true,
  };
}

function addrInUse(): Error {
  return Object.assign(new Error('listen EADDRINUSE: address already in use'), {
    code: 'EADDRINUSE',
  });
}

interface DriveResult {
  posted: Array<Record<string, unknown>>;
  bootPorts: Array<number | undefined>;
  ready?: { type: string; port: number; apiOrigin: string };
  readyErr?: Error;
  handle: UtilityHandle;
  destroyReasons: Array<string | undefined>;
}

async function driveInit(opts: {
  requestedPort: number | undefined;
  ipcPort?: number;
  boot: (port: number | undefined) => Promise<{ port: number }>;
}): Promise<DriveResult> {
  const posted: Array<Record<string, unknown>> = [];
  const bootPorts: Array<number | undefined> = [];
  const destroyReasons: Array<string | undefined> = [];
  let messageHandler: ((e: { data: unknown }) => void) | undefined;

  const fakeBootServer = async (o: BootServerOptions): Promise<BootedServer> => {
    bootPorts.push(o.port);
    const res = await opts.boot(o.port);
    return {
      port: res.port,
      degraded: [],
      destroy: async (reason?: string) => {
        destroyReasons.push(reason);
      },
    } as unknown as BootedServer;
  };

  const deps: SetupUtilityDeps = {
    parentPort: {
      on: (_event, handler) => {
        messageHandler = handler;
      },
      postMessage: (value) => {
        posted.push(value as unknown as Record<string, unknown>);
      },
    },
    importServer: async () =>
      ({ bootServer: fakeBootServer }) as unknown as typeof import('@inkeep/open-knowledge-server'),
    exit: () => {},
    parentPid: process.pid,
    killProbe: () => {},
    onSignal: () => {},
    setInterval: () => ({ clear: () => {}, unref: () => {} }),
    prepareBootEnvironment: async () =>
      ({
        config: {} as never,
        contentDir: '/tmp/ok-drive',
        contentRoot: undefined,
        configValid: true,
        serverRuntime: makeServerRuntime(opts.requestedPort),
      }) as never,
    env: {},
  };

  const handle = setupUtility(deps);
  messageHandler?.({
    data: {
      type: 'init',
      opts: { projectDir: '/tmp/ok-drive', contentDir: '/tmp/ok-drive', port: opts.ipcPort ?? 0 },
    },
  });
  try {
    const ready = await handle.readyPromise;
    return { posted, bootPorts, ready, handle, destroyReasons };
  } catch (err) {
    return { posted, bootPorts, readyErr: err as Error, handle, destroyReasons };
  }
}

describe('port pinning + EADDRINUSE fallback', () => {
  test('boots on the pinned server.port when it is free', async () => {
    const { bootPorts, ready, posted } = await driveInit({
      requestedPort: 24550,
      boot: (port) => Promise.resolve({ port: port ?? 0 }),
    });
    expect(bootPorts).toEqual([24550]);
    expect(ready?.port).toBe(24550);
    const degraded = posted.find((m) => m.type === 'degraded');
    expect(degraded).toBeUndefined();
  });

  test('falls back to an ephemeral port when the pinned port is in use', async () => {
    const { bootPorts, ready, posted } = await driveInit({
      requestedPort: 24550,
      boot: (port) =>
        port === 24550 ? Promise.reject(addrInUse()) : Promise.resolve({ port: 51234 }),
    });
    expect(bootPorts).toEqual([24550, 0]);
    expect(ready?.port).toBe(51234);
    const degraded = posted.find((m) => m.type === 'degraded');
    expect(degraded).toBeUndefined();
  });

  test('unpinned local boot uses the ephemeral IPC port and never falls back', async () => {
    const { bootPorts, ready } = await driveInit({
      requestedPort: undefined,
      ipcPort: 0,
      boot: (port) => Promise.resolve({ port: port === 0 ? 42000 : (port ?? 0) }),
    });
    expect(bootPorts).toEqual([0]);
    expect(ready?.port).toBe(42000);
  });

  test('a non-EADDRINUSE boot failure propagates (no silent retry)', async () => {
    const { bootPorts, readyErr, posted } = await driveInit({
      requestedPort: 24550,
      boot: () => Promise.reject(new Error('git preflight failed')),
    });
    expect(bootPorts).toEqual([24550]);
    expect(readyErr?.message).toContain('git preflight failed');
    expect(posted.find((m) => m.type === 'error')).toBeDefined();
  });
});

describe('shutdown exit reason', () => {
  async function drive() {
    return driveInit({
      requestedPort: 24560,
      boot: (port) => Promise.resolve({ port: port ?? 0 }),
    });
  }

  test('a dead parent drains the server as parent-exit', async () => {
    const { handle, destroyReasons } = await drive();
    await handle.shutdown('parent-died');
    expect(destroyReasons).toEqual(['parent-exit']);
  });

  test('window-close IPC drains as parent-exit too — the host is going away', async () => {
    const { handle, destroyReasons } = await drive();
    await handle.shutdown('shutdown-ipc');
    expect(destroyReasons).toEqual(['parent-exit']);
  });

  test('a signal drains as external-signal', async () => {
    const { handle, destroyReasons } = await drive();
    await handle.shutdown('SIGTERM');
    expect(destroyReasons).toEqual(['external-signal']);
  });
});
