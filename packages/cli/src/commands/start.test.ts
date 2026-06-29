import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { spawn as NativeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { LOCAL_DIR } from '@inkeep/open-knowledge-core';
import { type Config, ConfigSchema } from '@inkeep/open-knowledge-server';
import {
  awaitUiSiblingPort,
  type BootedStartServer,
  bootStartServer,
  buildIdleShutdownHandler,
  computeConnectExitCode,
  connectUiSibling,
  decideUiSpawn,
  deriveServerProcessTitle,
  formatShutdownNotice,
  isServerLockCollision,
  OkDirMissingError,
  resolveCollabPort,
  resolveHost,
  resolveStartConsoleLevel,
  shouldConnectToExistingServer,
  spawnOkUi,
  startCommand,
  tryDescribeLockCollision,
  type UiSpawnDecision,
  withEphemeralTempDirReap,
} from './start.ts';
import { closeHttpServers, startUiServer, type UiServerHandle } from './ui.ts';

describe('resolveHost', () => {
  test('returns --host flag when present (highest priority)', () => {
    expect(resolveHost({ host: '0.0.0.0' }, { HOST: '127.0.0.2' })).toBe('0.0.0.0');
  });

  test('falls back to HOST env when --host is absent', () => {
    expect(resolveHost({}, { HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });

  test('falls back to DEFAULT_SERVER_HOST (localhost) when both flag and env are absent', () => {
    expect(resolveHost({}, {})).toBe('localhost');
  });

  test('explicit undefined --host falls through to env (precedence: flag > env > default)', () => {
    expect(resolveHost({ host: undefined }, { HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });
});

describe('formatShutdownNotice', () => {
  test('SIGINT includes the headline, the wait notice, and the force-quit hint', () => {
    const lines = formatShutdownNotice('SIGINT');
    expect(lines[0]).toContain('Stopping OpenKnowledge');
    expect(lines.some((l) => l.includes('few seconds'))).toBe(true);
    expect(lines.some((l) => l.includes('force quit'))).toBe(true);
  });

  test('SIGTERM omits the force-quit hint (no interactive second-press path)', () => {
    const lines = formatShutdownNotice('SIGTERM');
    expect(lines[0]).toContain('Stopping OpenKnowledge');
    expect(lines.some((l) => l.includes('few seconds'))).toBe(true);
    expect(lines.some((l) => l.includes('force quit'))).toBe(false);
  });
});

describe('resolveStartConsoleLevel', () => {
  test('returns "warn" when no level is pinned (quiet terminal by default)', () => {
    expect(resolveStartConsoleLevel({})).toBe('warn');
  });

  test('returns null (leave env untouched) when LOG_LEVEL is set', () => {
    expect(resolveStartConsoleLevel({ LOG_LEVEL: 'info' })).toBeNull();
    expect(resolveStartConsoleLevel({ LOG_LEVEL: 'debug' })).toBeNull();
  });

  test('returns null when OK_CONSOLE_LEVEL is already set', () => {
    expect(resolveStartConsoleLevel({ OK_CONSOLE_LEVEL: 'info' })).toBeNull();
  });
});

describe('deriveServerProcessTitle', () => {
  test('returns "open-knowledge-server <basename>" for a typical project path', () => {
    expect(deriveServerProcessTitle('/Users/alice/projects/my-notes')).toBe(
      'open-knowledge-server my-notes',
    );
  });

  test('strips non-printable bytes from the project name', () => {
    expect(deriveServerProcessTitle('/path/to/bad\x07name\x7F')).toBe(
      'open-knowledge-server badname',
    );
  });

  test('falls back to "unknown" when basename is empty or all non-printable', () => {
    expect(deriveServerProcessTitle('/')).toBe('open-knowledge-server unknown');
    expect(deriveServerProcessTitle('/path/to/\x00\x01\x02')).toBe('open-knowledge-server unknown');
  });

  test('truncates long project names to keep ps lines readable', () => {
    const longName = 'a'.repeat(200);
    const result = deriveServerProcessTitle(`/parent/${longName}`);
    expect(result.length).toBeLessThanOrEqual(86);
    expect(result.startsWith('open-knowledge-server ')).toBe(true);
    expect(result.length).toBe(22 + 64);
  });

  test('trims leading/trailing whitespace from the project name', () => {
    expect(deriveServerProcessTitle('/parent/   leading-trailing   ')).toBe(
      'open-knowledge-server leading-trailing',
    );
  });

  test('preserves typical kebab-case, snake_case, and dotted names', () => {
    expect(deriveServerProcessTitle('/x/my-project')).toBe('open-knowledge-server my-project');
    expect(deriveServerProcessTitle('/x/my_project')).toBe('open-knowledge-server my_project');
    expect(deriveServerProcessTitle('/x/v1.2.3')).toBe('open-knowledge-server v1.2.3');
  });
});

describe('decideUiSpawn', () => {
  test('absent lock → spawn(absent)', () => {
    const result = decideUiSpawn({ uiLock: null, isAlive: () => true });
    expect(result).toEqual<UiSpawnDecision>({ action: 'spawn', reason: 'absent' });
  });

  test('lock with dead pid → spawn(stale)', () => {
    const result = decideUiSpawn({
      uiLock: { pid: 999999, port: 3000 },
      isAlive: () => false,
    });
    expect(result).toEqual<UiSpawnDecision>({
      action: 'spawn',
      reason: 'stale',
      stalePid: 999999,
    });
  });

  test('lock with live pid → skip(alive)', () => {
    const result = decideUiSpawn({
      uiLock: { pid: 4242, port: 3001 },
      isAlive: (pid) => pid === 4242,
    });
    expect(result).toEqual<UiSpawnDecision>({
      action: 'skip',
      reason: 'alive',
      pid: 4242,
      port: 3001,
    });
  });

  test('isAlive probe receives the lock pid', () => {
    const seen: number[] = [];
    decideUiSpawn({
      uiLock: { pid: 7777, port: 3000 },
      isAlive: (pid) => {
        seen.push(pid);
        return true;
      },
    });
    expect(seen).toEqual([7777]);
  });
});

describe('buildIdleShutdownHandler', () => {
  test('SIGTERMs UI sibling; if it exits within grace, awaits destroy', async () => {
    const events: string[] = [];
    let alive = true;
    const onShutdown = buildIdleShutdownHandler({
      readUiLock: () => ({ pid: 1234, port: 3000 }),
      isAlive: () => alive,
      killPid: (pid, sig) => {
        events.push(`kill:${pid}:${sig}`);
        if (sig === 'SIGTERM') alive = false;
      },
      destroy: async () => {
        events.push('destroy');
      },
      sigtermGraceMs: 100,
      sigtermPollIntervalMs: 5,
      sleep: async () => {},
    });
    await onShutdown();
    expect(events).toEqual(['kill:1234:SIGTERM', 'destroy']);
  });

  test('escalates to SIGKILL when SIGTERM grace expires', async () => {
    const events: string[] = [];
    const warned: object[] = [];
    const onShutdown = buildIdleShutdownHandler({
      readUiLock: () => ({ pid: 1234, port: 3000 }),
      isAlive: () => true,
      killPid: (pid, sig) => {
        events.push(`kill:${pid}:${sig}`);
      },
      destroy: async () => {
        events.push('destroy');
      },
      sigtermGraceMs: 20,
      sigtermPollIntervalMs: 5,
      sleep: async () => {},
      log: {
        info: () => {},
        warn: (obj) => warned.push(obj),
        error: () => {},
      },
    });
    await onShutdown();
    expect(events).toEqual(['kill:1234:SIGTERM', 'kill:1234:SIGKILL', 'destroy']);
    expect(warned.find((w) => (w as { pid?: number }).pid === 1234)).toBeDefined();
  });

  test('skips kill when UI lock absent', async () => {
    const events: string[] = [];
    const onShutdown = buildIdleShutdownHandler({
      readUiLock: () => null,
      isAlive: () => true,
      killPid: (pid, sig) => events.push(`kill:${pid}:${sig}`),
      destroy: async () => {
        events.push('destroy');
      },
    });
    await onShutdown();
    expect(events).toEqual(['destroy']);
  });

  test('skips kill when UI process is dead (stale lock)', async () => {
    const events: string[] = [];
    const onShutdown = buildIdleShutdownHandler({
      readUiLock: () => ({ pid: 4242, port: 3000 }),
      isAlive: () => false,
      killPid: (pid, sig) => events.push(`kill:${pid}:${sig}`),
      destroy: async () => {
        events.push('destroy');
      },
    });
    await onShutdown();
    expect(events).toEqual(['destroy']);
  });

  test('still calls destroy when killPid throws', async () => {
    const events: string[] = [];
    const warned: object[] = [];
    const onShutdown = buildIdleShutdownHandler({
      readUiLock: () => ({ pid: 4242, port: 3000 }),
      isAlive: () => true,
      killPid: () => {
        throw new Error('EPERM');
      },
      destroy: async () => {
        events.push('destroy');
      },
      log: {
        info: () => {},
        warn: (obj) => warned.push(obj),
        error: () => {},
      },
    });
    await onShutdown();
    expect(events).toEqual(['destroy']);
    expect(warned[0]).toMatchObject({ pid: 4242 });
  });

  test('still calls destroy when readUiLock throws', async () => {
    const events: string[] = [];
    const onShutdown = buildIdleShutdownHandler({
      readUiLock: () => {
        throw new Error('lock read failed');
      },
      isAlive: () => true,
      killPid: () => {},
      destroy: async () => {
        events.push('destroy');
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await onShutdown();
    expect(events).toEqual(['destroy']);
  });
});

describe('spawnOkUi', () => {
  let tmpDir: string;
  let lockDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-start-spawnui-'));
    lockDir = resolve(tmpDir, '.ok', LOCAL_DIR);
  });
  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('creates lockDir if missing and opens last-spawn-error.log', () => {
    const calls: Array<{ cmd: string; args: readonly string[]; opts: object }> = [];
    spawnOkUi({
      lockDir,
      cwd: tmpDir,
      // biome-ignore lint/suspicious/noExplicitAny: minimal mock matches ChildProcess shape
      spawn: ((cmd: string, args: readonly string[], opts: any) => {
        calls.push({ cmd, args, opts });
        return { unref: () => {}, on: () => {}, kill: () => {} } as unknown as ReturnType<
          typeof spawnOkUi
        >;
      }) as never,
    });

    expect(existsSync(lockDir)).toBe(true);
    expect(existsSync(join(lockDir, 'last-spawn-error.log'))).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]?.cmd).toBe(process.execPath);
    const callArgs = calls[0]?.args ?? [];
    expect(callArgs[callArgs.length - 1]).toBe('ui');
  });

  test('passes detached + ignore stdio + cwd to spawn', () => {
    const calls: Array<{ opts: { detached?: boolean; cwd?: string; stdio?: unknown[] } }> = [];
    spawnOkUi({
      lockDir,
      cwd: tmpDir,
      spawn: ((_cmd: string, _args: readonly string[], opts: object) => {
        calls.push({ opts: opts as never });
        return { unref: () => {}, on: () => {}, kill: () => {} } as unknown as ReturnType<
          typeof spawnOkUi
        >;
      }) as never,
    });

    const opts = calls[0]?.opts;
    expect(opts?.detached).toBe(true);
    expect(opts?.cwd).toBe(tmpDir);
    expect(Array.isArray(opts?.stdio)).toBe(true);
    expect(opts?.stdio?.[0]).toBe('ignore');
    expect(opts?.stdio?.[1]).toBe('ignore');
    expect(typeof opts?.stdio?.[2]).toBe('number');
  });

  test('honors custom args (e.g. testable arg list)', () => {
    const calls: Array<{ args: readonly string[] }> = [];
    spawnOkUi({
      lockDir,
      cwd: tmpDir,
      args: ['ui', '--port', '9999'],
      spawn: ((_cmd: string, args: readonly string[]) => {
        calls.push({ args });
        return { unref: () => {}, on: () => {}, kill: () => {} } as unknown as ReturnType<
          typeof spawnOkUi
        >;
      }) as never,
    });
    expect(calls[0]?.args.slice(-3)).toEqual(['ui', '--port', '9999']);
  });

  test('strips PORT env from the spawned child (QA-007 — prevents same-port bind race)', () => {
    const originalPort = process.env.PORT;
    try {
      process.env.PORT = '51234';
      const calls: Array<{ env: NodeJS.ProcessEnv | undefined }> = [];
      spawnOkUi({
        lockDir,
        cwd: tmpDir,
        spawn: ((_cmd: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
          calls.push({ env: options.env });
          return {
            unref: () => {},
            on: () => {},
            kill: () => {},
          } as unknown as ReturnType<typeof spawnOkUi>;
        }) as never,
      });

      const childEnv = calls[0]?.env;
      expect(childEnv).toBeDefined();
      expect(childEnv?.PORT).toBeUndefined();
      expect(typeof childEnv?.PATH).toBe('string');
      expect(childEnv?.ELECTRON_RUN_AS_NODE).toBe('1');
    } finally {
      if (originalPort === undefined) {
        delete process.env.PORT;
      } else {
        process.env.PORT = originalPort;
      }
    }
  });

  test('truncates last-spawn-error.log on each invocation', () => {
    const errorLog = join(lockDir, 'last-spawn-error.log');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(errorLog, 'previous run error\n', 'utf-8');
    expect(readFileSync(errorLog, 'utf-8')).toBe('previous run error\n');

    spawnOkUi({
      lockDir,
      cwd: tmpDir,
      spawn: ((_cmd: string, _args: readonly string[]) =>
        ({ unref: () => {}, on: () => {}, kill: () => {} }) as unknown as ReturnType<
          typeof spawnOkUi
        >) as never,
    });

    expect(readFileSync(errorLog, 'utf-8')).toBe('');
  });
});


function makeTestConfig(): Config {
  return ConfigSchema.parse({});
}

const TEST_HOST = '127.0.0.1';

function fetchText(
  port: number,
  path: string,
): Promise<{
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}> {
  return new Promise((resolveFetch, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolveFetch({ status: res.statusCode ?? 0, body, headers: res.headers });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('resolveCollabPort (collab vs UI-sibling port suppression)', () => {
  test('explicit --port always wins', () => {
    expect(resolveCollabPort(5000, 6000, 39848)).toBe(5000);
    expect(resolveCollabPort(5000, undefined, undefined)).toBe(5000);
  });
  test('with --ui-port set, env PORT is suppressed (collab kernel-allocates)', () => {
    expect(resolveCollabPort(undefined, 39848, 39848)).toBeUndefined();
    expect(resolveCollabPort(undefined, 6000, 39848)).toBeUndefined();
  });
  test('without --ui-port, env PORT flows through to the collab server', () => {
    expect(resolveCollabPort(undefined, 6000, undefined)).toBe(6000);
  });
  test('nothing set → undefined (kernel-allocated)', () => {
    expect(resolveCollabPort(undefined, undefined, undefined)).toBeUndefined();
  });
});

describe('shouldConnectToExistingServer (main-checkout connect guard)', () => {
  test('true only when --ui-port set AND a live server.lock exists', () => {
    expect(shouldConnectToExistingServer(39848, { port: 49530 })).toBe(true);
  });
  test('false without --ui-port (plain terminal `ok start` keeps boot/exit-1)', () => {
    expect(shouldConnectToExistingServer(undefined, { port: 49530 })).toBe(false);
  });
  test('false when no live server (fresh worktree → boot)', () => {
    expect(shouldConnectToExistingServer(39848, null)).toBe(false);
    expect(shouldConnectToExistingServer(39848, { port: 0 })).toBe(false);
  });
});

describe('computeConnectExitCode (connect-sibling exit mapping)', () => {
  test('clean numeric exit passes through', () => {
    expect(computeConnectExitCode(0, null, false)).toBe(0);
    expect(computeConnectExitCode(3, null, false)).toBe(3);
  });
  test('forwarded teardown (intentional signal) → 0', () => {
    expect(computeConnectExitCode(null, 'SIGTERM', true)).toBe(0);
    expect(computeConnectExitCode(null, 'SIGINT', true)).toBe(0);
  });
  test('unexpected signal death (external kill) → 1', () => {
    expect(computeConnectExitCode(null, 'SIGKILL', false)).toBe(1);
    expect(computeConnectExitCode(null, 'SIGTERM', false)).toBe(1);
  });
  test('null code with no signal → 0 (defensive)', () => {
    expect(computeConnectExitCode(null, null, false)).toBe(0);
  });
});

describe('isServerLockCollision (D1/C3 gate)', () => {
  class FakeServerLockErr extends Error {}
  const fakeModule = {
    ServerLockCollisionError: FakeServerLockErr,
  } as unknown as typeof import('@inkeep/open-knowledge-server');

  test('true for a ServerLockCollisionError instance', () => {
    expect(isServerLockCollision(new FakeServerLockErr('held'), fakeModule)).toBe(true);
  });
  test('false for any other error', () => {
    expect(isServerLockCollision(new Error('boom'), fakeModule)).toBe(false);
    expect(isServerLockCollision('not-an-error', fakeModule)).toBe(false);
  });
  test('false (never throws) when the module lacks the class export', () => {
    const empty = {} as unknown as typeof import('@inkeep/open-knowledge-server');
    expect(isServerLockCollision(new Error('boom'), empty)).toBe(false);
  });
});

describe('connectUiSibling (D1/C3 connect fallback)', () => {
  function fakeChild(
    opts: { code?: number | null; signal?: NodeJS.Signals | null; error?: Error } = {},
  ) {
    return {
      on(ev: string, cb: (...args: unknown[]) => void) {
        if (ev === 'exit' && opts.error === undefined) {
          queueMicrotask(() => cb(opts.code ?? null, opts.signal ?? null));
        }
        if (ev === 'error' && opts.error !== undefined) {
          queueMicrotask(() => cb(opts.error));
        }
        return this;
      },
      kill() {},
      unref() {},
    };
  }

  test('spawns `ok ui --port <P>` foreground (stdio inherit, ELECTRON_RUN_AS_NODE, PORT stripped)', async () => {
    const calls: Array<{
      cmd: string;
      args: readonly string[];
      opts: { stdio?: unknown; cwd?: string; env?: NodeJS.ProcessEnv };
    }> = [];
    const fakeSpawn = ((cmd: string, args: readonly string[], opts: object) => {
      calls.push({ cmd, args, opts: opts as never });
      return fakeChild({ code: 0 });
    }) as never;

    const prevPort = process.env.PORT;
    process.env.PORT = '51234';
    try {
      await connectUiSibling({ cwd: '/tmp/wt', uiPort: 39848, spawn: fakeSpawn });
    } finally {
      if (prevPort === undefined) delete process.env.PORT;
      else process.env.PORT = prevPort;
    }

    expect(calls.length).toBe(1);
    expect(calls[0]?.cmd).toBe(process.execPath);
    expect(calls[0]?.args.slice(-3)).toEqual(['ui', '--port', '39848']);
    expect(calls[0]?.opts.stdio).toBe('inherit');
    expect(calls[0]?.opts.cwd).toBe('/tmp/wt');
    expect(calls[0]?.opts.env?.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(calls[0]?.opts.env?.PORT).toBeUndefined();
  });

  test('propagates a clean numeric child exit code to process.exitCode', async () => {
    const prev = process.exitCode;
    try {
      const fakeSpawn = (() => fakeChild({ code: 3 })) as never;
      await connectUiSibling({ cwd: '/tmp/wt', uiPort: 5173, spawn: fakeSpawn });
      expect(process.exitCode).toBe(3);
    } finally {
      process.exitCode = prev;
    }
  });

  test('maps an UNEXPECTED signal death (no forwarded teardown) to exit 1', async () => {
    const prev = process.exitCode;
    process.exitCode = 0;
    try {
      const fakeSpawn = (() => fakeChild({ code: null, signal: 'SIGKILL' })) as never;
      await connectUiSibling({ cwd: '/tmp/wt', uiPort: 5173, spawn: fakeSpawn });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = prev;
    }
  });

  test('maps a spawn `error` event to exit 1', async () => {
    const prev = process.exitCode;
    process.exitCode = 0;
    try {
      const fakeSpawn = (() => fakeChild({ error: new Error('ENOENT') })) as never;
      await connectUiSibling({ cwd: '/tmp/wt', uiPort: 5173, spawn: fakeSpawn });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = prev;
    }
  });
});

describe('bootStartServer (integration)', () => {
  let tmpDir: string;
  let booted: BootedStartServer | null = null;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-start-boot-'));
    const okDir = resolve(tmpDir, '.ok');
    mkdirSync(okDir, { recursive: true });
    writeFileSync(resolve(okDir, 'config.yml'), '', 'utf-8');
    writeFileSync(resolve(okDir, '.gitignore'), '', 'utf-8');
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    booted = null;
  });

  afterEach(async () => {
    if (booted) {
      try {
        await booted.destroy();
      } catch {
      }
      booted = null;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('GET / returns 404 with React-UI-served-by-ok-ui pointer', async () => {
    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
      skipUiAutoSpawn: true,
    });
    const res = await fetchText(booted.port, '/');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = JSON.parse(res.body);
    expect(body.type).toBe('urn:ok:error:not-found');
    expect(body.title).toBe('Not found.');
    expect(body.status).toBe(404);
    expect(body.detail).toContain('React UI is served by `ok ui`');
    expect(body.detail).toContain('/');
  });

  test('GET /assets/anything also returns the same pointer (no static fallthrough)', async () => {
    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
      skipUiAutoSpawn: true,
    });
    const res = await fetchText(booted.port, '/assets/main-abcdef.js');
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.type).toBe('urn:ok:error:not-found');
    expect(body.title).toBe('Not found.');
    expect(body.detail).toContain('React UI is served by `ok ui`');
    expect(body.detail).toContain('/assets/main-abcdef.js');
  });

  test('GET /api/document is routed through Hocuspocus onRequest (not the SPA pointer)', async () => {
    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
      skipUiAutoSpawn: true,
    });
    await booted.ready;

    const res = await fetchText(booted.port, '/api/document?docName=integration-test-doc');
    if (res.body.length > 0 && res.headers['content-type']?.toString().includes('json')) {
      const parsed = (() => {
        try {
          return JSON.parse(res.body);
        } catch {
          return null;
        }
      })();
      if (parsed && typeof parsed.error === 'string') {
        expect(parsed.error).not.toContain('React UI is served by `ok ui`');
      }
    }
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(600);
  });

  test('GET /api/nonexistent-route returns the API-route-not-found 404 (not the SPA pointer)', async () => {
    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
      skipUiAutoSpawn: true,
    });
    await booted.ready;

    const res = await fetchText(booted.port, '/api/totally-nonexistent-xyz');
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.type).toBe('urn:ok:error:not-found');
    expect(body.title).toBe('API endpoint not found.');
    expect(body.status).toBe(404);
    expect(typeof body.instance).toBe('string');
    expect(body.detail).toContain('/api/totally-nonexistent-xyz');
  });

  test('auto-spawn ok ui when ui.lock absent — invokes spawn with correct args', async () => {
    const spawnCalls: Array<{ cmd: string; args: readonly string[] }> = [];
    const fakeSpawn: typeof NativeSpawn = ((cmd: string, args: readonly string[]) => {
      spawnCalls.push({ cmd, args });
      return {
        unref: () => {},
        on: () => {},
        kill: () => {},
      } as unknown as ReturnType<typeof NativeSpawn>;
    }) as never;

    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
      spawn: fakeSpawn,
    });

    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0]?.cmd).toBe(process.execPath);
    const spawnCallArgs = spawnCalls[0]?.args ?? [];
    expect(spawnCallArgs[spawnCallArgs.length - 1]).toBe('ui');
    expect(booted.uiSpawnDecision).toEqual({ action: 'spawn', reason: 'absent' });
  });

  test('threads uiPort into the ok ui sibling spawn args (worktree-preview core)', async () => {
    const spawnCalls: Array<{ args: readonly string[] }> = [];
    const fakeSpawn: typeof NativeSpawn = ((_cmd: string, args: readonly string[]) => {
      spawnCalls.push({ args });
      return {
        unref: () => {},
        on: () => {},
        kill: () => {},
      } as unknown as ReturnType<typeof NativeSpawn>;
    }) as never;

    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
      uiPort: 39848,
      spawn: fakeSpawn,
    });

    expect(spawnCalls.length).toBe(1);
    expect(spawnCalls[0]?.args.slice(-3)).toEqual(['ui', '--port', '39848']);
  });

  test('skip auto-spawn when ui.lock alive (idempotent re-acquire path)', async () => {
    const lockDir = join(tmpDir, '.ok', LOCAL_DIR);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'ui.lock'),
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        port: 9876,
        startedAt: new Date().toISOString(),
        worktreeRoot: tmpDir,
      }),
    );

    const spawnCalls: Array<{ cmd: string }> = [];
    const fakeSpawn: typeof NativeSpawn = ((cmd: string) => {
      spawnCalls.push({ cmd });
      return {
        unref: () => {},
        on: () => {},
        kill: () => {},
      } as unknown as ReturnType<typeof NativeSpawn>;
    }) as never;

    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
      spawn: fakeSpawn,
    });

    expect(spawnCalls.length).toBe(0);
    expect(booted.uiSpawnDecision).toEqual({
      action: 'skip',
      reason: 'alive',
      pid: process.pid,
      port: 9876,
    });
  });

  test('skipUiAutoSpawn=true bypasses spawn even when ui.lock is absent', async () => {
    const spawnCalls: Array<{ cmd: string }> = [];
    const fakeSpawn: typeof NativeSpawn = ((cmd: string) => {
      spawnCalls.push({ cmd });
      return {
        unref: () => {},
        on: () => {},
        kill: () => {},
      } as unknown as ReturnType<typeof NativeSpawn>;
    }) as never;

    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
      skipUiAutoSpawn: true,
      spawn: fakeSpawn,
    });

    expect(spawnCalls.length).toBe(0);
    expect(booted.uiSpawnDecision).toEqual({ action: 'spawn', reason: 'absent' });
  });

  test('destroy() is idempotent — second call is a no-op', async () => {
    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
      skipUiAutoSpawn: true,
    });
    await booted.destroy();
    await booted.destroy();
    booted = null; // Prevent afterEach from calling destroy again — already done.
  });

  test('booted.port reflects the kernel-assigned port (server.port=0)', async () => {
    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
      skipUiAutoSpawn: true,
    });
    expect(booted.port).toBeGreaterThan(0);
    expect(booted.port).toBeLessThan(65536);
  });

  test('D-034: /collab/keepalive accepts a bare WS upgrade without routing to Hocuspocus', async () => {
    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
      skipUiAutoSpawn: true,
    });

    const ws = new WebSocket(`ws://127.0.0.1:${booted.port}/collab/keepalive?pid=${process.pid}`);
    try {
      await new Promise<void>((done, fail) => {
        const onOpen = () => {
          ws.removeEventListener('error', onError);
          done();
        };
        const onError = () => {
          ws.removeEventListener('open', onOpen);
          fail(new Error('keepalive WS did not open'));
        };
        ws.addEventListener('open', onOpen, { once: true });
        ws.addEventListener('error', onError, { once: true });
      });
      expect(ws.readyState).toBe(1); // OPEN

      await wait(100);
      expect(ws.readyState).toBe(1);
    } finally {
      ws.close();
    }
  });

  test('invokes repairMcpConfigsFn with the project cwd before bootServer', async () => {
    const captured: { projectDir: string }[] = [];
    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
      skipUiAutoSpawn: true,
      repairMcpConfigsFn: (opts) => {
        captured.push(opts as { projectDir: string });
      },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].projectDir).toBe(tmpDir);
  });

  test('continues booting even when repairMcpConfigsFn throws', async () => {
    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
      skipUiAutoSpawn: true,
      repairMcpConfigsFn: () => {
        throw new Error('synthetic repair failure');
      },
    });
    expect(booted.port).toBeGreaterThan(0);
  });

  test('invokes repairLaunchJsonFn with the project cwd before bootServer', async () => {
    const captured: { projectDir: string }[] = [];
    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
      skipUiAutoSpawn: true,
      repairLaunchJsonFn: (opts) => {
        captured.push(opts as { projectDir: string });
      },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].projectDir).toBe(tmpDir);
  });

  test('continues booting even when repairLaunchJsonFn throws', async () => {
    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
      skipUiAutoSpawn: true,
      repairLaunchJsonFn: () => {
        throw new Error('synthetic launch-json repair failure');
      },
    });
    expect(booted.port).toBeGreaterThan(0);
  });

  test('invokes repairSkillsFn with the project cwd before bootServer', async () => {
    const captured: { projectDir: string; reclaimDisableEnv: string | null }[] = [];
    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
      skipUiAutoSpawn: true,
      repairSkillsFn: async (opts) => {
        captured.push(opts as { projectDir: string; reclaimDisableEnv: string | null });
      },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].projectDir).toBe(tmpDir);
  });

  test('continues booting even when repairSkillsFn throws', async () => {
    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
      skipUiAutoSpawn: true,
      repairSkillsFn: () => {
        throw new Error('synthetic skill repair failure');
      },
    });
    expect(booted.port).toBeGreaterThan(0);
  });

  test('AC-C4: OK_RECLAIM_DISABLE=1 forwards reclaimDisableEnv to all three sweep fns', async () => {
    const prevEnv = process.env.OK_RECLAIM_DISABLE;
    process.env.OK_RECLAIM_DISABLE = '1';
    const mcpCaptures: Array<{ reclaimDisableEnv: string | null }> = [];
    const launchCaptures: Array<{ reclaimDisableEnv: string | null }> = [];
    const skillCaptures: Array<{ reclaimDisableEnv: string | null }> = [];
    try {
      booted = await bootStartServer({
        config: makeTestConfig(),
        cwd: tmpDir,
        host: TEST_HOST,
        skipAutoInit: true,
        skipUiAutoSpawn: true,
        repairMcpConfigsFn: (opts) => {
          mcpCaptures.push(opts as { reclaimDisableEnv: string | null });
        },
        repairLaunchJsonFn: (opts) => {
          launchCaptures.push(opts as { reclaimDisableEnv: string | null });
        },
        repairSkillsFn: async (opts) => {
          skillCaptures.push(opts as { reclaimDisableEnv: string | null });
        },
      });
    } finally {
      if (prevEnv === undefined) delete process.env.OK_RECLAIM_DISABLE;
      else process.env.OK_RECLAIM_DISABLE = prevEnv;
    }

    expect(mcpCaptures[0]?.reclaimDisableEnv).toBe('1');
    expect(launchCaptures[0]?.reclaimDisableEnv).toBe('1');
    expect(skillCaptures[0]?.reclaimDisableEnv).toBe('1');
  });

  test('default (no OK_RECLAIM_DISABLE) forwards reclaimDisableEnv=null to all three sweeps', async () => {
    const prevEnv = process.env.OK_RECLAIM_DISABLE;
    delete process.env.OK_RECLAIM_DISABLE;
    const captured: Array<{ reclaimDisableEnv: string | null }> = [];
    try {
      booted = await bootStartServer({
        config: makeTestConfig(),
        cwd: tmpDir,
        host: TEST_HOST,
        skipAutoInit: true,
        skipUiAutoSpawn: true,
        repairMcpConfigsFn: (opts) => {
          captured.push(opts as { reclaimDisableEnv: string | null });
        },
        repairLaunchJsonFn: (opts) => {
          captured.push(opts as { reclaimDisableEnv: string | null });
        },
        repairSkillsFn: async (opts) => {
          captured.push(opts as { reclaimDisableEnv: string | null });
        },
      });
    } finally {
      if (prevEnv !== undefined) process.env.OK_RECLAIM_DISABLE = prevEnv;
    }
    expect(captured).toHaveLength(3);
    for (const c of captured) expect(c.reclaimDisableEnv).toBeNull();
  });


  test('serveContentAssets: false (default) — content paths return the SPA-pointer 404', async () => {
    writeFileSync(join(tmpDir, 'fixture-asset.png'), 'fake-png-bytes', 'utf-8');

    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
      skipUiAutoSpawn: true,
    });

    const res = await fetchText(booted.port, '/fixture-asset.png');
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.detail).toContain('React UI is served by `ok ui`');
  });

  test('serveContentAssets: true — content asset is served from the server origin', async () => {
    const assetBytes = `fake-png-bytes-${Math.random()}`;
    writeFileSync(join(tmpDir, 'fixture-asset.png'), assetBytes, 'utf-8');

    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
      skipUiAutoSpawn: true,
      serveContentAssets: true,
    });

    const res = await fetchText(booted.port, '/fixture-asset.png');
    expect(res.status).toBe(200);
    expect(res.body).toBe(assetBytes);
    const disposition = res.headers['content-disposition'];
    expect(typeof disposition === 'string' ? disposition : '').toContain('inline');
  });

  test('reactShellDistDir — server serves the shell on /, auto-suppresses ok ui sibling', async () => {
    const shellDir = await mkdtemp(resolve(tmpdir(), 'ok-start-shell-'));
    const shellHtml = '<!doctype html><html><body>react-shell-test-sentinel</body></html>';
    writeFileSync(join(shellDir, 'index.html'), shellHtml, 'utf-8');

    const spawnCalls: Array<{ cmd: string }> = [];
    const fakeSpawn: typeof NativeSpawn = ((cmd: string) => {
      spawnCalls.push({ cmd });
      return {
        unref: () => {},
        on: () => {},
        kill: () => {},
      } as unknown as ReturnType<typeof NativeSpawn>;
    }) as never;

    try {
      booted = await bootStartServer({
        config: makeTestConfig(),
        cwd: tmpDir,
        host: TEST_HOST,
        skipAutoInit: true,
        spawn: fakeSpawn,
        reactShellDistDir: shellDir,
      });

      const rootRes = await fetchText(booted.port, '/');
      expect(rootRes.status).toBe(200);
      expect(rootRes.body).toContain('react-shell-test-sentinel');

      const deepRes = await fetchText(booted.port, '/some/deep/route');
      expect(deepRes.status).toBe(200);
      expect(deepRes.body).toContain('react-shell-test-sentinel');

      expect(spawnCalls.length).toBe(0);

      const apiRes = await fetchText(booted.port, '/api/totally-nonexistent-xyz');
      expect(apiRes.status).toBe(404);
      const apiBody = JSON.parse(apiRes.body);
      expect(apiBody.title).toBe('API endpoint not found.');
    } finally {
      await rm(shellDir, { recursive: true, force: true });
    }
  });

  test('--serve-content-assets and --react-shell-dist-dir compose additively', async () => {
    writeFileSync(join(tmpDir, 'fixture-image.png'), 'fake-png-bytes', 'utf-8');
    const shellDir = await mkdtemp(resolve(tmpdir(), 'ok-start-shell-both-'));
    writeFileSync(
      join(shellDir, 'index.html'),
      '<!doctype html><html><body>compose-test-sentinel</body></html>',
      'utf-8',
    );

    try {
      booted = await bootStartServer({
        config: makeTestConfig(),
        cwd: tmpDir,
        host: TEST_HOST,
        skipAutoInit: true,
        skipUiAutoSpawn: true,
        serveContentAssets: true,
        reactShellDistDir: shellDir,
      });

      const assetRes = await fetchText(booted.port, '/fixture-image.png');
      expect(assetRes.status).toBe(200);
      expect(assetRes.body).toBe('fake-png-bytes');

      const rootRes = await fetchText(booted.port, '/');
      expect(rootRes.status).toBe(200);
      expect(rootRes.body).toContain('compose-test-sentinel');
    } finally {
      await rm(shellDir, { recursive: true, force: true });
    }
  });
});

describe('bootStartServer — no auto git-init from ok start (US-004)', () => {
  let tmpDir: string;
  let booted: BootedStartServer | null = null;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-start-git-'));
    const okDir = resolve(tmpDir, '.ok');
    mkdirSync(okDir, { recursive: true });
    writeFileSync(resolve(okDir, 'config.yml'), '', 'utf-8');
    writeFileSync(resolve(okDir, '.gitignore'), '', 'utf-8');
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    booted = null;
  });

  afterEach(async () => {
    if (booted) {
      try {
        await booted.destroy();
      } catch {
      }
      booted = null;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('fresh tmpdir (no .git/) → ok start does NOT create .git/HEAD', async () => {
    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: false,
      skipUiAutoSpawn: true,
    });

    expect(existsSync(join(tmpDir, '.git/HEAD'))).toBe(false);
  });

  test('missing git binary does not prevent ok start from booting', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '/nonexistent-path';
    try {
      booted = await bootStartServer({
        config: makeTestConfig(),
        cwd: tmpDir,
        host: TEST_HOST,
        skipAutoInit: false,
        skipUiAutoSpawn: true,
      });
      expect(booted.degraded).toContain('shadow-repo');
    } finally {
      process.env.PATH = originalPath;
    }
  });
});


describe('bootStartServer — rejects with init-required when .ok/config.yml is absent', () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-start-no-scaffold-'));
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('fresh dir (no .ok/) → bootStartServer throws OkDirMissingError', async () => {
    await expect(
      bootStartServer({
        config: makeTestConfig(),
        cwd: tmpDir,
        host: TEST_HOST,
        skipAutoInit: false,
        skipUiAutoSpawn: true,
      }),
    ).rejects.toBeInstanceOf(OkDirMissingError);
  });

  test('fresh dir (no .ok/) → OkDirMissingError message contains "ok init"', async () => {
    await expect(
      bootStartServer({
        config: makeTestConfig(),
        cwd: tmpDir,
        host: TEST_HOST,
        skipAutoInit: false,
        skipUiAutoSpawn: true,
      }),
    ).rejects.toThrow('ok init');

    expect(existsSync(join(tmpDir, '.ok'))).toBe(false);
  });

  test('fresh dir (no .ok/) → bootStartServer does not create config.yml', async () => {
    await expect(
      bootStartServer({
        config: makeTestConfig(),
        cwd: tmpDir,
        host: TEST_HOST,
        skipAutoInit: false,
        skipUiAutoSpawn: true,
      }),
    ).rejects.toBeInstanceOf(OkDirMissingError);
    expect(existsSync(join(tmpDir, '.ok', 'config.yml'))).toBe(false);
  });

  test('bare .ok/ without config.yml is NOT a project root — bootStartServer still throws', async () => {
    mkdirSync(join(tmpDir, '.ok'), { recursive: true });
    await expect(
      bootStartServer({
        config: makeTestConfig(),
        cwd: tmpDir,
        host: TEST_HOST,
        skipAutoInit: false,
        skipUiAutoSpawn: true,
      }),
    ).rejects.toBeInstanceOf(OkDirMissingError);
    expect(existsSync(join(tmpDir, '.ok', 'config.yml'))).toBe(false);
  });

  test('skipAutoInit: true bypasses the CLI guard — server requires config.yml to be pre-seeded', async () => {
    const okDir = join(tmpDir, '.ok');
    mkdirSync(okDir, { recursive: true });
    writeFileSync(join(okDir, 'config.yml'), '', 'utf-8');
    writeFileSync(join(okDir, '.gitignore'), '', 'utf-8');

    let booted: BootedStartServer | null = null;
    try {
      booted = await bootStartServer({
        config: makeTestConfig(),
        cwd: tmpDir,
        host: TEST_HOST,
        skipAutoInit: true,
        skipUiAutoSpawn: true,
      });
      expect(booted.port).toBeGreaterThan(0);
    } finally {
      if (booted) await booted.destroy();
    }
  });
});


describe('awaitUiSiblingPort', () => {
  test('returns the bound port immediately when ui.lock has port > 0 on first read', async () => {
    const port = await awaitUiSiblingPort({
      readUiLock: () => ({ port: 51887 }),
      now: () => 0,
      sleep: async () => {},
      timeoutMs: 3000,
      pollIntervalMs: 50,
    });
    expect(port).toBe(51887);
  });

  test('returns null when the lock never populates before the timeout', async () => {
    let t = 0;
    const port = await awaitUiSiblingPort({
      readUiLock: () => null,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      timeoutMs: 200,
      pollIntervalMs: 50,
    });
    expect(port).toBeNull();
  });

  test('skips port=0 sentinel (child is binding) and returns once port > 0', async () => {
    let t = 0;
    let reads = 0;
    const port = await awaitUiSiblingPort({
      readUiLock: () => {
        reads++;
        if (reads === 1) return null; //                lock not written yet
        if (reads === 2) return { port: 0 }; //         acquired, not bound
        return { port: 9999 }; //                        bound
      },
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      timeoutMs: 1000,
      pollIntervalMs: 50,
    });
    expect(port).toBe(9999);
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  test('reads once more after the loop exits, catching a lock that lands in the grace window', async () => {
    let t = 0;
    let reads = 0;
    const port = await awaitUiSiblingPort({
      readUiLock: () => {
        reads++;
        return reads >= 3 ? { port: 4444 } : null;
      },
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      timeoutMs: 100,
      pollIntervalMs: 50,
    });
    expect(port).toBe(4444);
  });
});


describe('bootStartServer — resolvedUiPort tracks the port ok ui actually binds', () => {
  let tmpDir: string;
  let booted: BootedStartServer | null = null;
  let uiHandle: UiServerHandle | null = null;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-start-banner-'));
    const okDir = resolve(tmpDir, '.ok');
    mkdirSync(okDir, { recursive: true });
    writeFileSync(resolve(okDir, 'config.yml'), '', 'utf-8');
    writeFileSync(resolve(okDir, '.gitignore'), '', 'utf-8');
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    booted = null;
    uiHandle = null;
  });

  afterEach(async () => {
    if (booted) {
      try {
        await booted.destroy();
      } catch {
      }
      booted = null;
    }
    if (uiHandle) {
      uiHandle.release();
      await closeHttpServers(uiHandle.httpServers);
      uiHandle = null;
    }
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('auto-spawn path: resolvedUiPort matches the in-process ok ui that the fake spawn brought up', async () => {
    const cfg = ConfigSchema.parse({});
    const fakeSpawn: typeof NativeSpawn = ((_cmd: string, args: readonly string[]) => {
      const lastArg = args[args.length - 1];
      if (lastArg === 'ui') {
        void startUiServer({
          config: cfg,
          cwd: tmpDir,
          port: 0,
          host: '127.0.0.1',
          safetyNetMs: 0,
        }).then((handle) => {
          uiHandle = handle;
        });
      }
      return {
        unref: () => {},
        on: () => {},
        kill: () => {},
      } as unknown as ReturnType<typeof NativeSpawn>;
    }) as never;

    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
      spawn: fakeSpawn,
      uiBindTimeoutMs: 10_000,
    });

    expect(booted.uiSpawnDecision).toEqual({ action: 'spawn', reason: 'absent' });
    expect(booted.resolvedUiPort).not.toBeNull();
    expect(booted.resolvedUiPort).not.toBe(3000);
    const handleDeadline = Date.now() + 5_000;
    while (uiHandle === null) {
      if (Date.now() > handleDeadline) {
        throw new Error('in-process UI handle never settled within 5s');
      }
      await wait(10);
    }
    expect(booted.resolvedUiPort).toBe(uiHandle.port);

    const configRes = await fetch(`http://127.0.0.1:${booted.resolvedUiPort}/api/config`);
    expect(configRes.status).toBe(200);
    const configBody = (await configRes.json()) as { port: number };
    expect(configBody.port).toBe(booted.resolvedUiPort);
  });

  test('skip path: resolvedUiPort reflects the pre-existing ok ui lock port', async () => {
    const lockDir = join(tmpDir, '.ok', LOCAL_DIR);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'ui.lock'),
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        port: 57890,
        startedAt: new Date().toISOString(),
        worktreeRoot: tmpDir,
      }),
    );

    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
    });

    expect(booted.uiSpawnDecision).toEqual({
      action: 'skip',
      reason: 'alive',
      pid: process.pid,
      port: 57890,
    });
    expect(booted.resolvedUiPort).toBe(57890);
  });

  test('spawn-skipped path: resolvedUiPort is null when skipUiAutoSpawn=true and no prior sibling', async () => {
    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
      skipUiAutoSpawn: true,
    });

    expect(booted.uiSpawnDecision).toEqual({ action: 'spawn', reason: 'absent' });
    expect(booted.resolvedUiPort).toBeNull();
  });

  test('timeout path: resolvedUiPort is null when the spawned UI never binds in time', async () => {
    const silentSpawn: typeof NativeSpawn = ((_cmd: string, _args: readonly string[]) => {
      return {
        unref: () => {},
        on: () => {},
        kill: () => {},
      } as unknown as ReturnType<typeof NativeSpawn>;
    }) as never;

    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
      spawn: silentSpawn,
      uiBindTimeoutMs: 200,
    });

    expect(booted.uiSpawnDecision).toEqual({ action: 'spawn', reason: 'absent' });
    expect(booted.resolvedUiPort).toBeNull();
  });
});

describe('startCommand — --mode flag wiring', () => {
  function fakeConfig() {
    return makeTestConfig();
  }

  function quietCommand() {
    const cmd = startCommand(fakeConfig);
    cmd.exitOverride();
    cmd.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    return cmd;
  }

  test('--mode <value> rejects values outside the browser|app enum (FR13)', () => {
    const cmd = quietCommand();
    expect(() => cmd.parse(['--mode', 'desktop'], { from: 'user' })).toThrow(
      /--mode must be 'browser' or 'app'/,
    );
  });

  test("--mode 'browser' parses successfully (no exit)", () => {
    const cmd = quietCommand();
    let helpDisplayed = false;
    try {
      cmd.parse(['--mode', 'browser', '--help'], { from: 'user' });
    } catch (err) {
      helpDisplayed = (err as { code?: string }).code === 'commander.helpDisplayed';
    }
    expect(helpDisplayed).toBe(true);
  });

  test('--mode=app + --open exits with code 2 (FR6 mutual exclusion)', async () => {
    const cmd = quietCommand();

    let capturedExitCode: number | undefined;
    let capturedStderr = '';
    const originalExit = process.exit;
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.exit = ((code?: number) => {
      capturedExitCode = code;
      throw new Error('exit-stub');
    }) as never;
    process.stderr.write = ((chunk: unknown) => {
      capturedStderr += String(chunk);
      return true;
    }) as never;

    try {
      await cmd.parseAsync(['--mode', 'app', '--open'], { from: 'user' });
    } catch (err) {
      if ((err as Error).message !== 'exit-stub') throw err;
    } finally {
      process.exit = originalExit;
      process.stderr.write = originalStderrWrite;
    }

    expect(capturedExitCode).toBe(2);
    expect(capturedStderr).toContain('--mode=app');
    expect(capturedStderr).toContain('--open');
  });

  test('--mode=app with detection unavailable exits 1 + emits a contextual notFoundMessage (FR5)', async () => {
    const previousForceBrowser = process.env.OK_FORCE_BROWSER;
    process.env.OK_FORCE_BROWSER = '1';

    const cmd = quietCommand();

    let capturedExitCode: number | undefined;
    let capturedStderr = '';
    const originalExit = process.exit;
    const originalConsoleError = console.error;
    process.exit = ((code?: number) => {
      capturedExitCode = code;
      throw new Error('exit-stub');
    }) as never;
    console.error = (...args: unknown[]) => {
      capturedStderr += `${args.map(String).join(' ')}\n`;
    };

    try {
      await cmd.parseAsync(['--mode', 'app'], { from: 'user' });
    } catch (err) {
      if ((err as Error).message !== 'exit-stub') throw err;
    } finally {
      process.exit = originalExit;
      console.error = originalConsoleError;
      if (previousForceBrowser === undefined) {
        delete process.env.OK_FORCE_BROWSER;
      } else {
        process.env.OK_FORCE_BROWSER = previousForceBrowser;
      }
    }

    expect(capturedExitCode).toBe(1);
    expect(capturedStderr).toContain('OK_FORCE_BROWSER');
    expect(capturedStderr).toMatch(/disabled|unset/i);
    expect(capturedStderr).not.toContain('not found');
  });
});

describe('tryDescribeLockCollision', () => {
  function fakeServerModule(opts: {
    meta?: { kind?: string; pid?: number; port?: number; hostname?: string } | null;
    throwOnRead?: boolean;
  }) {
    class ServerLockCollisionError extends Error {}
    return {
      ServerLockCollisionError,
      readServerLock: () => {
        if (opts.throwOnRead) throw new Error('synthetic read failure');
        return opts.meta;
      },
    } as unknown as typeof import('@inkeep/open-knowledge-server');
  }

  test('non-lock-collision error → null (caller falls back to generic)', () => {
    const fm = fakeServerModule({ meta: null });
    const result = tryDescribeLockCollision(new TypeError('unrelated'), '/tmp', fm);
    expect(result).toBeNull();
  });

  test("kind='interactive' → desktop-running message", () => {
    const fm = fakeServerModule({ meta: { kind: 'interactive', pid: 42, port: 3000 } });
    const err = new fm.ServerLockCollisionError();
    const result = tryDescribeLockCollision(err, '/tmp/proj', fm);
    expect(result).toContain('desktop is currently running');
    expect(result).toContain('--cwd');
  });

  test("kind='mcp-spawned' → MCP idle-shutdown message", () => {
    const fm = fakeServerModule({ meta: { kind: 'mcp-spawned', pid: 99, port: 3001 } });
    const err = new fm.ServerLockCollisionError();
    const result = tryDescribeLockCollision(err, '/tmp/proj', fm);
    expect(result).toContain('MCP-spawned');
    expect(result).toContain('idle-shutdown');
  });

  test('meta returned but kind absent → generic already-running message', () => {
    const fm = fakeServerModule({ meta: { pid: 1, port: 3000 } });
    const err = new fm.ServerLockCollisionError();
    const result = tryDescribeLockCollision(err, '/tmp/proj', fm);
    expect(result).toContain('already running');
    expect(result).toContain('ok status');
  });

  test('meta=null → generic already-running message', () => {
    const fm = fakeServerModule({ meta: null });
    const err = new fm.ServerLockCollisionError();
    const result = tryDescribeLockCollision(err, '/tmp/proj', fm);
    expect(result).toContain('already running');
  });

  test('readServerLock throws → null (defense in depth)', () => {
    const fm = fakeServerModule({ throwOnRead: true });
    const err = new fm.ServerLockCollisionError();
    const result = tryDescribeLockCollision(err, '/tmp/proj', fm);
    expect(result).toBeNull();
  });

  test('serverModule.ServerLockCollisionError missing → null (back-compat)', () => {
    const fm = {
      readServerLock: () => null,
    } as unknown as typeof import('@inkeep/open-knowledge-server');
    const err = new Error('any');
    const result = tryDescribeLockCollision(err, '/tmp/proj', fm);
    expect(result).toBeNull();
  });
});

describe('withEphemeralTempDirReap', () => {
  test('runs the inner handler, then removes the temp projectDir', async () => {
    const order: string[] = [];
    const handler = async () => {
      order.push('handler');
    };
    const removed: string[] = [];
    const wrapped = withEphemeralTempDirReap(handler, '/tmp/ok-ephemeral-x', async (dir) => {
      order.push('rm');
      removed.push(dir);
    });
    await wrapped();
    expect(order).toEqual(['handler', 'rm']);
    expect(removed).toEqual(['/tmp/ok-ephemeral-x']);
  });

  test('swallows a rm failure (best-effort) — the handler still completes', async () => {
    let handled = false;
    const wrapped = withEphemeralTempDirReap(
      async () => {
        handled = true;
      },
      '/tmp/ok-ephemeral-y',
      async () => {
        throw new Error('EBUSY');
      },
    );
    await expect(wrapped()).resolves.toBeUndefined();
    expect(handled).toBe(true);
  });
  test('reaps the temp dir even when the inner handler throws (finally)', async () => {
    const removed: string[] = [];
    const wrapped = withEphemeralTempDirReap(
      async () => {
        throw new Error('destroy failed');
      },
      '/tmp/ok-ephemeral-throw',
      async (dir) => {
        removed.push(dir);
      },
    );
    await expect(wrapped()).rejects.toThrow('destroy failed');
    expect(removed).toEqual(['/tmp/ok-ephemeral-throw']);
  });
});
