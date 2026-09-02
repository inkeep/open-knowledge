import type { spawn as NativeSpawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { idleShutdownToMs } from '@inkeep/open-knowledge-core';
import { type Config, ConfigSchema } from '@inkeep/open-knowledge-server';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  type BootedStartServer,
  bootStartServer,
  deriveServerProcessTitle,
  EphemeralProjectDirNotThrowawayError,
  formatServerReuseNotice,
  formatShutdownNotice,
  isLoopbackHost,
  isReapableEphemeralProjectDir,
  isServerLockCollision,
  OkDirMissingError,
  parseExternalUrlFlag,
  parseIdleShutdownFlag,
  parseOnlyModule,
  resolveBundledReactShellDir,
  resolveHost,
  resolveServerReuse,
  resolveStartConfig,
  resolveStartConsoleLevel,
  resolveStartShellDir,
  shouldOpenBrowser,
  shouldWarnHostOverridesMultiBind,
  startCommand,
  tryDescribeLockCollision,
  withEphemeralTempDirReap,
  withIdleShutdownProcessExit,
} from './start.ts';

describe('resolveHost', () => {
  test('falls back to HOST env when --bind is absent', () => {
    expect(resolveHost({}, { HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });

  test('falls back to DEFAULT_SERVER_HOST (numeric IPv4 loopback) when both flag and env are absent', () => {
    expect(resolveHost({}, {})).toBe('127.0.0.1');
  });
});

describe('parseExternalUrlFlag', () => {
  test('accepts http and https origins (http covers tailnet/LAN deployments)', () => {
    expect(parseExternalUrlFlag('https://kb.example.com')).toBe('https://kb.example.com');
    expect(parseExternalUrlFlag('http://laptop.tail:55222')).toBe('http://laptop.tail:55222');
  });

  test('rejects garbage and non-http(s) schemes', () => {
    expect(() => parseExternalUrlFlag('not a url')).toThrow(/not a valid URL/);
    expect(() => parseExternalUrlFlag('ftp://kb.example.com')).toThrow(/http\(s\) origin/);
  });

  test('flag errors name the flag the user typed', () => {
    expect(() => parseExternalUrlFlag('not a url')).toThrow(/--external-url/);
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

describe('withIdleShutdownProcessExit (idle-path zombie prevention)', () => {
  test('exits 0 after the handler completes, logging an open-handle summary', async () => {
    const order: string[] = [];
    const logged: object[] = [];
    let exitCode: number | undefined;
    const wrapped = withIdleShutdownProcessExit(
      async () => {
        order.push('handler');
      },
      {
        log: {
          info: (obj) => {
            logged.push(obj);
          },
          error: () => {},
        },
        exit: (code) => {
          order.push('exit');
          exitCode = code;
        },
        getActiveHandles: () => [new (class Socket {})(), new (class Socket {})(), null],
      },
    );
    await wrapped();
    expect(order).toEqual(['handler', 'exit']);
    expect(exitCode).toBe(0);
    const event = logged.find((o) => (o as { event?: string }).event === 'idle-shutdown-exit') as
      | { openHandles: Record<string, number> }
      | undefined;
    expect(event).toBeDefined();
    expect(event?.openHandles.Socket).toBe(2);
  });

  test('reports handlesAvailable: false when the runtime cannot enumerate handles (Bun)', async () => {
    const logged: object[] = [];
    let exitCode: number | undefined;
    const wrapped = withIdleShutdownProcessExit(async () => {}, {
      log: {
        info: (obj) => {
          logged.push(obj);
        },
        error: () => {},
      },
      exit: (code) => {
        exitCode = code;
      },
      getActiveHandles: () => null,
    });
    await wrapped();
    expect(exitCode).toBe(0);
    const event = logged.find((o) => (o as { event?: string }).event === 'idle-shutdown-exit') as
      | { openHandles: Record<string, number>; handlesAvailable: boolean }
      | undefined;
    expect(event?.handlesAvailable).toBe(false);
    expect(event?.openHandles).toEqual({});
  });

  test('exits 1 when the handler throws — a failed teardown must not zombify', async () => {
    let exitCode: number | undefined;
    const wrapped = withIdleShutdownProcessExit(
      async () => {
        throw new Error('destroy blew up');
      },
      {
        exit: (code) => {
          exitCode = code;
        },
        getActiveHandles: () => [],
      },
    );
    await wrapped();
    expect(exitCode).toBe(1);
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
      } catch {}
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
    });
    const res = await fetchText(booted.port, '/');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = JSON.parse(res.body);
    expect(body.type).toBe('urn:ok:error:not-found');
    expect(body.title).toBe('Not found.');
    expect(body.status).toBe(404);
    expect(body.detail).toContain('This server is running without the web UI');
    expect(body.detail).toContain('/');
  });

  test('idleThresholdMs: null (--idle-shutdown off) threads through and boots (not the 30-min default)', async () => {
    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
      idleThresholdMs: null,
    });
    expect(booted.port).toBeGreaterThan(0);
    await booted.ready;
  });

  test('GET /assets/anything also returns the same pointer (no static fallthrough)', async () => {
    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
    });
    const res = await fetchText(booted.port, '/assets/main-abcdef.js');
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.type).toBe('urn:ok:error:not-found');
    expect(body.title).toBe('Not found.');
    expect(body.detail).toContain('This server is running without the web UI');
    expect(body.detail).toContain('/assets/main-abcdef.js');
  });

  test('GET /api/document is routed through Hocuspocus onRequest (not the SPA pointer)', async () => {
    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
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
        expect(parsed.error).not.toContain('This server is running without the web UI');
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

  test('destroy() is idempotent — second call is a no-op', async () => {
    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
    });
    await booted.destroy();
    await booted.destroy();
    booted = null;
  });

  test('booted.port reflects the kernel-assigned port (server.port=0)', async () => {
    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
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
      expect(ws.readyState).toBe(1);

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

  test('default — content assets are served from the server origin', async () => {
    const assetBytes = `fake-png-bytes-${Math.random()}`;
    mkdirSync(join(tmpDir, 'specs', 'nested'), { recursive: true });
    writeFileSync(join(tmpDir, 'specs', 'nested', 'mockup.png'), assetBytes, 'utf-8');

    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
    });

    const res = await fetchText(booted.port, '/specs/nested/mockup.png');
    expect(res.status).toBe(200);
    expect(res.body).toBe(assetBytes);
    const disposition = res.headers['content-disposition'];
    expect(typeof disposition === 'string' ? disposition : '').toContain('inline');
  });

  test('serveContentAssets: false — content paths return the SPA-pointer 404', async () => {
    writeFileSync(join(tmpDir, 'fixture-asset.png'), 'fake-png-bytes', 'utf-8');

    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
      serveContentAssets: false,
    });

    const res = await fetchText(booted.port, '/fixture-asset.png');
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.detail).toContain('This server is running without the web UI');
  });

  test('reactShellDistDir — server serves the shell on /', async () => {
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

  test('--single-file with no projectDir self-provisions a throwaway root — cwd is never consumed', async () => {
    const looseDir = await mkdtemp(resolve(tmpdir(), 'ok-start-loose-'));
    const sentinel = join(tmpDir, 'IMPORTANT.md');
    writeFileSync(sentinel, 'keep me', 'utf-8');
    try {
      writeFileSync(join(looseDir, 'note.md'), '# loose note\n', 'utf-8');
      booted = await bootStartServer({
        config: makeTestConfig(),
        cwd: tmpDir,
        host: TEST_HOST,
        skipAutoInit: true,
        singleFile: join(looseDir, 'note.md'),
      });
      await booted.ready;

      const ephemeralRoot = dirname(dirname(booted.lockDir));
      expect(ephemeralRoot).not.toBe(tmpDir);
      expect(booted.lockDir.startsWith(tmpDir)).toBe(false);
      expect(basename(ephemeralRoot).startsWith('ok-ephemeral-')).toBe(true);
      expect(existsSync(join(ephemeralRoot, '.ok', 'config.yml'))).toBe(true);

      await booted.destroy();
      booted = null;
      expect(existsSync(ephemeralRoot)).toBe(false);
      expect(existsSync(sentinel)).toBe(true);
      expect(existsSync(join(tmpDir, '.ok', 'config.yml'))).toBe(true);
    } finally {
      await rm(looseDir, { recursive: true, force: true });
    }
  });

  test('--single-file with a provided empty --project-dir seeds the synthesized config and boots', async () => {
    const looseDir = await mkdtemp(resolve(tmpdir(), 'ok-start-loose-'));
    const providedDir = await mkdtemp(resolve(tmpdir(), 'ok-ephemeral-'));
    try {
      writeFileSync(join(looseDir, 'note.md'), '# loose note\n', 'utf-8');
      booted = await bootStartServer({
        config: makeTestConfig(),
        cwd: tmpDir,
        host: TEST_HOST,
        skipAutoInit: true,
        singleFile: join(looseDir, 'note.md'),
        projectDir: providedDir,
      });
      await booted.ready;
      expect(existsSync(join(providedDir, '.ok', 'config.yml'))).toBe(true);
      expect(existsSync(join(providedDir, '.ok', '.gitignore'))).toBe(true);

      await booted.destroy();
      booted = null;
      expect(existsSync(providedDir)).toBe(true);
    } finally {
      await rm(looseDir, { recursive: true, force: true });
      await rm(providedDir, { recursive: true, force: true });
    }
  });

  test('--single-file with an ordinary bare --project-dir is refused, not seeded', async () => {
    const looseDir = await mkdtemp(resolve(tmpdir(), 'ok-start-loose-'));
    const ordinaryDir = await mkdtemp(resolve(tmpdir(), 'ok-start-ordinary-'));
    try {
      writeFileSync(join(looseDir, 'note.md'), '# loose note\n', 'utf-8');
      await expect(
        bootStartServer({
          config: makeTestConfig(),
          cwd: tmpDir,
          host: TEST_HOST,
          skipAutoInit: true,
          singleFile: join(looseDir, 'note.md'),
          projectDir: ordinaryDir,
        }),
      ).rejects.toThrow(EphemeralProjectDirNotThrowawayError);
      expect(existsSync(join(ordinaryDir, '.ok'))).toBe(false);
    } finally {
      await rm(looseDir, { recursive: true, force: true });
      await rm(ordinaryDir, { recursive: true, force: true });
    }
  });

  test('--single-file with an initialized real project as --project-dir is refused untouched', async () => {
    const looseDir = await mkdtemp(resolve(tmpdir(), 'ok-start-loose-'));
    const realProject = await mkdtemp(resolve(tmpdir(), 'ok-start-realproj-'));
    try {
      writeFileSync(join(looseDir, 'note.md'), '# loose note\n', 'utf-8');
      mkdirSync(join(realProject, '.ok'), { recursive: true });
      writeFileSync(join(realProject, '.ok', 'config.yml'), 'content:\n  dir: .\n', 'utf-8');
      writeFileSync(join(realProject, 'KEEP.md'), 'keep me', 'utf-8');
      await expect(
        bootStartServer({
          config: makeTestConfig(),
          cwd: tmpDir,
          host: TEST_HOST,
          skipAutoInit: true,
          singleFile: join(looseDir, 'note.md'),
          projectDir: realProject,
        }),
      ).rejects.toThrow(EphemeralProjectDirNotThrowawayError);
      expect(existsSync(join(realProject, 'KEEP.md'))).toBe(true);
      expect(existsSync(join(realProject, '.ok', 'local'))).toBe(false);
    } finally {
      await rm(looseDir, { recursive: true, force: true });
      await rm(realProject, { recursive: true, force: true });
    }
  });

  test('boot failure after self-provisioning reaps the freshly created ephemeral dir', async () => {
    const looseDir = await mkdtemp(resolve(tmpdir(), 'ok-start-loose-'));
    const privateTmp = await mkdtemp(resolve(tmpdir(), 'ok-start-privtmp-'));
    const prevTmpdirEnv = process.env.TMPDIR;
    const { createServer } = await import('node:http');
    const blocker = createServer(() => {});
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const addr = blocker.address();
    const blockedPort = typeof addr === 'object' && addr !== null ? addr.port : 0;
    try {
      writeFileSync(join(looseDir, 'note.md'), '# loose note\n', 'utf-8');
      process.env.TMPDIR = privateTmp;
      await expect(
        bootStartServer({
          config: makeTestConfig(),
          cwd: tmpDir,
          host: TEST_HOST,
          skipAutoInit: true,
          singleFile: join(looseDir, 'note.md'),
          port: blockedPort,
        }),
      ).rejects.toThrow();
      expect(readdirSync(privateTmp).filter((n) => n.startsWith('ok-ephemeral-'))).toEqual([]);
    } finally {
      if (prevTmpdirEnv === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = prevTmpdirEnv;
      await new Promise<void>((r) => blocker.close(() => r()));
      await rm(looseDir, { recursive: true, force: true });
      await rm(privateTmp, { recursive: true, force: true });
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
      } catch {}
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
      });
      await booted.ready;
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
      });
      expect(booted.port).toBeGreaterThan(0);
    } finally {
      if (booted) await booted.destroy();
    }
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
      resolveLockDir: (projectDir: string) => join(projectDir, '.ok', 'local'),
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

  test("kind='interactive' → generic message (covers terminal AND desktop holders)", () => {
    const fm = fakeServerModule({ meta: { kind: 'interactive', pid: 42, port: 3000 } });
    const err = new fm.ServerLockCollisionError();
    const result = tryDescribeLockCollision(err, '/tmp/proj', fm);
    expect(result).toContain('already running');
    expect(result).not.toContain('desktop');
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

describe('resolveStartConfig (ephemeral config isolation)', () => {
  test('single-file sessions drop the project config but keep the user-global layer', () => {
    const projectConfig = ConfigSchema.parse({ server: { port: 4242 } });
    const userConfig = ConfigSchema.parse({ server: { port: 5151 } });
    const resolved = resolveStartConfig(projectConfig, '/tmp/note.md', () => userConfig);
    expect(resolved.server?.port).toBe(5151);
    expect(resolved).not.toBe(projectConfig);
  });

  test('plain ok start keeps the loaded project config untouched', () => {
    const projectConfig = ConfigSchema.parse({ server: { port: 4242 } });
    let userReads = 0;
    const resolved = resolveStartConfig(projectConfig, undefined, () => {
      userReads += 1;
      return ConfigSchema.parse({});
    });
    expect(resolved).toBe(projectConfig);
    expect(userReads).toBe(0);
  });
});

describe('isReapableEphemeralProjectDir', () => {
  test('accepts a direct ok-ephemeral-* child of os.tmpdir()', () => {
    expect(isReapableEphemeralProjectDir(join(tmpdir(), 'ok-ephemeral-abc123'))).toBe(true);
  });

  test('rejects a dir outside the temp root, whatever its name', () => {
    expect(isReapableEphemeralProjectDir('/Users/someone/my-project')).toBe(false);
  });

  test('rejects a temp-root child without the ok-ephemeral- prefix', () => {
    expect(isReapableEphemeralProjectDir(join(tmpdir(), 'my-scratch-project'))).toBe(false);
  });

  test('rejects an ok-ephemeral-* dir nested deeper than the temp root', () => {
    expect(isReapableEphemeralProjectDir(join(tmpdir(), 'nested', 'ok-ephemeral-x'))).toBe(false);
  });

  test('pierces temp-root symlinks via the injected realpath (macOS /tmp → /private/tmp)', () => {
    const realpathFn = (p: string): string =>
      p === '/tmp' || p.startsWith('/tmp/') ? p.replace(/^\/tmp/, '/private/tmp') : p;
    expect(
      isReapableEphemeralProjectDir('/tmp/ok-ephemeral-x', {
        tmpdirFn: () => '/private/tmp',
        realpathFn,
      }),
    ).toBe(true);
  });

  test('resolves a symlink leaf: an ok-ephemeral-* link pointing elsewhere is refused', () => {
    const targetDir = mkdtempSync(join(tmpdir(), 'ok-start-symtarget-'));
    const link = join(tmpdir(), `ok-ephemeral-link-${basename(targetDir)}`);
    symlinkSync(targetDir, link);
    try {
      expect(isReapableEphemeralProjectDir(link)).toBe(false);
    } finally {
      rmSync(link, { force: true });
      rmSync(targetDir, { recursive: true, force: true });
    }
  });

  test('accepts a real mkdtemp ok-ephemeral-* dir on this OS (symlinked temp prefix and all)', () => {
    const real = mkdtempSync(join(tmpdir(), 'ok-ephemeral-'));
    try {
      expect(isReapableEphemeralProjectDir(real)).toBe(true);
    } finally {
      rmSync(real, { recursive: true, force: true });
    }
  });
});

describe('withEphemeralTempDirReap', () => {
  const reapable = join(tmpdir(), 'ok-ephemeral-x');

  test('runs the inner handler, then removes the temp projectDir', async () => {
    const order: string[] = [];
    const handler = async () => {
      order.push('handler');
    };
    const removed: string[] = [];
    const wrapped = withEphemeralTempDirReap(handler, reapable, async (dir) => {
      order.push('rm');
      removed.push(dir);
    });
    await wrapped();
    expect(order).toEqual(['handler', 'rm']);
    expect(removed).toEqual([reapable]);
  });

  test('swallows a rm failure (best-effort) — the handler still completes', async () => {
    let handled = false;
    const wrapped = withEphemeralTempDirReap(
      async () => {
        handled = true;
      },
      reapable,
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
      reapable,
      async (dir) => {
        removed.push(dir);
      },
    );
    await expect(wrapped()).rejects.toThrow('destroy failed');
    expect(removed).toEqual([reapable]);
  });

  test('REFUSES to rm a non-throwaway target — the containment backstop', async () => {
    const removed: string[] = [];
    let handled = false;
    const wrapped = withEphemeralTempDirReap(
      async () => {
        handled = true;
      },
      '/Users/someone/my-project',
      async (dir) => {
        removed.push(dir);
      },
    );
    await wrapped();
    expect(handled).toBe(true);
    expect(removed).toEqual([]);
  });
});

describe('resolveHost — --bind precedence', () => {
  test('--bind wins over env', () => {
    expect(resolveHost({ bind: ['0.0.0.0'] }, { HOST: '127.0.0.3' })).toBe('0.0.0.0');
  });

  test('empty bind list falls through to env', () => {
    expect(resolveHost({ bind: [] }, { HOST: '127.0.0.2' })).toBe('127.0.0.2');
  });
});

describe('parseOnlyModule', () => {
  test('accepts server', () => {
    expect(parseOnlyModule('server')).toBe('server');
  });

  test('rejects ui (retired with ui.lock) and anything else', () => {
    expect(() => parseOnlyModule('ui')).toThrow(/--only must be/);
    expect(() => parseOnlyModule('api')).toThrow(/--only must be/);
  });
});

describe('resolveBundledReactShellDir (candidate-path probe)', () => {
  test('returns the first candidate that exists', () => {
    const dir = resolveBundledReactShellDir(() => true);
    expect(dir).not.toBeUndefined();
    expect(dir?.endsWith('public')).toBe(true);
  });

  test('returns undefined when no candidate exists (→ API/MCP-only degrade)', () => {
    expect(resolveBundledReactShellDir(() => false)).toBeUndefined();
  });
});

describe('resolveStartShellDir (the Wave 3 default-flip decision)', () => {
  const bundled = () => '/bundled/dist';
  const noBundle = () => undefined;

  test('default: resolves the bundled shell — the flip', () => {
    expect(
      resolveStartShellDir({
        explicitDir: undefined,
        only: undefined,
        findBundledDir: bundled,
      }),
    ).toEqual({ dir: '/bundled/dist', missingBundle: false });
  });

  test('explicit --react-shell-dist-dir always wins', () => {
    expect(
      resolveStartShellDir({
        explicitDir: '/explicit',
        only: undefined,
        findBundledDir: noBundle,
      }).dir,
    ).toBe('/explicit');
  });

  test('--only server opts out of the UI module entirely', () => {
    expect(
      resolveStartShellDir({
        explicitDir: undefined,
        only: 'server',
        findBundledDir: bundled,
      }),
    ).toEqual({ dir: undefined, missingBundle: false });
  });

  test('missing bundle degrades (API/MCP-only) and is flagged for the warning', () => {
    expect(
      resolveStartShellDir({
        explicitDir: undefined,
        only: undefined,
        findBundledDir: noBundle,
      }),
    ).toEqual({ dir: undefined, missingBundle: true });
  });
});

describe('isLoopbackHost', () => {
  test('loopback shapes', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
  });

  test('non-loopback shapes', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
    expect(isLoopbackHost('192.168.1.5')).toBe(false);
  });
});

describe('shouldOpenBrowser (interactive-loopback default open)', () => {
  const base = {
    openBrowser: true,
    explicitOn: false,
    host: '127.0.0.1',
    isTTY: true,
    ephemeral: false,
    only: undefined,
    servesUi: true,
  } as const;

  test('interactive loopback start serving the UI opens by default', () => {
    expect(shouldOpenBrowser({ ...base })).toBe(true);
  });

  test('explicit openBrowser=true (config/env) lifts the loopback-bind condition', () => {
    expect(shouldOpenBrowser({ ...base, host: '100.64.0.7', explicitOn: true })).toBe(true);
  });

  test('explicit openBrowser=true still never opens without a TTY (container safety)', () => {
    expect(shouldOpenBrowser({ ...base, explicitOn: true, isTTY: false })).toBe(false);
  });

  test('--no-open-browser suppresses', () => {
    expect(shouldOpenBrowser({ ...base, openBrowser: false })).toBe(false);
  });

  test('no TTY (spawned/CI) stays quiet', () => {
    expect(shouldOpenBrowser({ ...base, isTTY: false })).toBe(false);
  });

  test('non-loopback bind stays quiet', () => {
    expect(shouldOpenBrowser({ ...base, host: '0.0.0.0' })).toBe(false);
  });

  test('ephemeral single-file stays quiet (owns its own open flow)', () => {
    expect(shouldOpenBrowser({ ...base, ephemeral: true })).toBe(false);
  });

  test('--only server stays quiet', () => {
    expect(shouldOpenBrowser({ ...base, only: 'server' })).toBe(false);
  });

  test('a start that ended up serving no shell stays quiet', () => {
    expect(shouldOpenBrowser({ ...base, servesUi: false })).toBe(false);
  });
});

describe('resolveServerReuse (spawn-or-reuse)', () => {
  const immediate = { now: () => 0, sleep: async () => {}, timeoutMs: 1000, pollIntervalMs: 10 };

  test('ui-capable holder: reports the lock v2 url (the canonical one-URL contract)', async () => {
    const info = await resolveServerReuse({
      ...immediate,
      readServerLock: () => ({
        pid: 42,
        port: 24_550,
        url: 'http://127.0.0.1:24550',
        kind: 'interactive',
        capabilities: ['http', 'ws', 'ui'],
      }),
    });
    expect(info).toEqual({
      url: 'http://127.0.0.1:24550',
      kind: 'interactive',
      pid: 42,
      servesUi: true,
    });
  });

  test('explicit no-ui holder (--only server): reports the server address, servesUi false', async () => {
    const info = await resolveServerReuse({
      ...immediate,
      readServerLock: () => ({
        pid: 42,
        port: 24_550,
        url: 'http://127.0.0.1:24550',
        capabilities: ['http', 'ws'],
      }),
    });
    expect(info?.url).toBe('http://127.0.0.1:24550');
    expect(info?.servesUi).toBe(false);
  });

  test('no ui anywhere: falls back to the server address', async () => {
    const info = await resolveServerReuse({
      ...immediate,
      readServerLock: () => ({ pid: 42, port: 24_550 }),
    });
    expect(info?.url).toBe('http://127.0.0.1:24550');
  });

  test('polls through the pre-listen port-0 sentinel to the bound port', async () => {
    let clock = 0;
    let reads = 0;
    const info = await resolveServerReuse({
      readServerLock: () => {
        reads += 1;
        return reads < 3
          ? { pid: 42, port: 0 }
          : {
              pid: 42,
              port: 24_550,
              url: 'http://127.0.0.1:24550',
              capabilities: ['http', 'ws', 'ui'],
            };
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      timeoutMs: 1000,
      pollIntervalMs: 10,
    });
    expect(info?.url).toBe('http://127.0.0.1:24550');
  });

  test('draining holder yields null (caller falls back to the error path)', async () => {
    const info = await resolveServerReuse({
      ...immediate,
      readServerLock: () => ({ pid: 42, port: 24_550, draining: true }),
    });
    expect(info).toBeNull();
  });

  test('sentinel that never binds times out to null', async () => {
    let clock = 0;
    const info = await resolveServerReuse({
      readServerLock: () => ({ pid: 42, port: 0 }),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      timeoutMs: 100,
      pollIntervalMs: 10,
    });
    expect(info).toBeNull();
  });

  test('missing lock yields null', async () => {
    const info = await resolveServerReuse({
      ...immediate,
      readServerLock: () => null,
    });
    expect(info).toBeNull();
  });
});

describe('formatServerReuseNotice', () => {
  test("kind='interactive' gets the neutral copy — it covers terminal AND desktop holders", () => {
    const lines = formatServerReuseNotice({
      url: 'http://127.0.0.1:1',
      kind: 'interactive',
      pid: 7,
      servesUi: true,
    });
    expect(lines[0]).toContain('already running');
    expect(lines[0]).not.toContain('desktop');
    expect(lines.join('\n')).toContain('http://127.0.0.1:1');
  });

  test('names the mcp-spawned holder and the generic holder', () => {
    expect(
      formatServerReuseNotice({ url: 'u', kind: 'mcp-spawned', pid: 7, servesUi: true })[0],
    ).toContain('MCP-spawned');
    expect(formatServerReuseNotice({ url: 'u', pid: 7, servesUi: false })[0]).toContain(
      'already running',
    );
  });
});

describe('shouldWarnHostOverridesMultiBind', () => {
  const base = { flagBindSet: false, okBindSet: false, hostEnvSet: true, fileBindCount: 2 };
  test('warns when HOST alone drives the bind over a multi-element file list', () => {
    expect(shouldWarnHostOverridesMultiBind(base)).toBe(true);
  });
  test('boundary: a single-element (or empty) file bind does NOT warn (> 1, not >= 1)', () => {
    expect(shouldWarnHostOverridesMultiBind({ ...base, fileBindCount: 1 })).toBe(false);
    expect(shouldWarnHostOverridesMultiBind({ ...base, fileBindCount: 0 })).toBe(false);
  });
  test('does not warn when a flag or OK_BIND is the bind source (HOST is not)', () => {
    expect(shouldWarnHostOverridesMultiBind({ ...base, flagBindSet: true })).toBe(false);
    expect(shouldWarnHostOverridesMultiBind({ ...base, okBindSet: true })).toBe(false);
  });
  test('does not warn when HOST is unset', () => {
    expect(shouldWarnHostOverridesMultiBind({ ...base, hostEnvSet: false })).toBe(false);
  });
});

describe('parseIdleShutdownFlag (--idle-shutdown, Table 3 semantics)', () => {
  test("'off' is preserved as a string (idleShutdownToMs maps it to null)", () => {
    expect(parseIdleShutdownFlag('off')).toBe('off');
    expect(idleShutdownToMs(parseIdleShutdownFlag('off'))).toBeNull();
  });

  test('valid durations pass through as strings (converted to ms at the boundary)', () => {
    expect(parseIdleShutdownFlag('90s')).toBe('90s');
    expect(parseIdleShutdownFlag('30m')).toBe('30m');
    expect(parseIdleShutdownFlag('2h')).toBe('2h');
    expect(idleShutdownToMs(parseIdleShutdownFlag('90s'))).toBe(90_000);
    expect(idleShutdownToMs(parseIdleShutdownFlag('2h'))).toBe(7_200_000);
  });

  test('rejects unitless, zero-led, and unknown-unit values', () => {
    for (const bad of ['30', '0s', '05m', '1d', 'forever', '']) {
      expect(() => parseIdleShutdownFlag(bad)).toThrow(/--idle-shutdown/);
    }
  });
});

describe('--idle-shutdown threading through Commander (regression)', () => {
  async function captureParsedOpts(argv: string[]): Promise<Record<string, unknown>> {
    const cmd = startCommand(() => makeTestConfig());
    cmd.exitOverride();
    cmd.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    let captured: Record<string, unknown> = {};
    cmd.action((opts: Record<string, unknown>) => {
      captured = opts;
    });
    await cmd.parseAsync(argv, { from: 'user' });
    return captured;
  }

  test('--idle-shutdown off survives Commander and resolves to null (no idle shutdown)', async () => {
    const opts = await captureParsedOpts(['--idle-shutdown', 'off']);
    expect(opts.idleShutdown).toBe('off');
    expect(idleShutdownToMs(opts.idleShutdown as string)).toBeNull();
  });

  test('--idle-shutdown 90s survives Commander and resolves to 90000 ms', async () => {
    const opts = await captureParsedOpts(['--idle-shutdown', '90s']);
    expect(opts.idleShutdown).toBe('90s');
    expect(idleShutdownToMs(opts.idleShutdown as string)).toBe(90_000);
  });

  test('no --idle-shutdown flag leaves the value undefined (derived default applies)', async () => {
    const opts = await captureParsedOpts([]);
    expect(opts.idleShutdown).toBeUndefined();
  });
});

describe('startCommand — flag-conflict guards (exit 2)', () => {
  function quietCommand(config?: Config) {
    const cmd = startCommand(() => config ?? makeTestConfig());
    cmd.exitOverride();
    cmd.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    return cmd;
  }

  async function captureGuard(
    argv: string[],
    config?: Config,
  ): Promise<{ code: number | undefined; stderr: string }> {
    const cmd = quietCommand(config);
    let code: number | undefined;
    let stderr = '';
    const originalExit = process.exit;
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.exit = ((c?: number) => {
      code = c;
      throw new Error('exit-stub');
    }) as never;
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as never;
    try {
      await cmd.parseAsync(argv, { from: 'user' });
    } catch (err) {
      if ((err as Error).message !== 'exit-stub') throw err;
    } finally {
      process.exit = originalExit;
      process.stderr.write = originalWrite;
    }
    return { code, stderr };
  }

  test('--only server + --react-shell-dist-dir exits 2', async () => {
    const { code, stderr } = await captureGuard([
      '--only',
      'server',
      '--react-shell-dist-dir',
      '/tmp/shell',
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain('--react-shell-dist-dir');
  });
});
