import type { spawn as NativeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import {
  applyConfigOverlay,
  idleShutdownToMs,
  requiresExternalConsent,
  resolveEnvConfigLayer,
  resolveServerRuntimeConfig,
} from '@inkeep/open-knowledge-core';
import { type Config, ConfigSchema } from '@inkeep/open-knowledge-server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type BootedStartServer,
  bootStartServer,
  coerceRemoteBindHost,
  deriveServerProcessTitle,
  expandRemoteAlias,
  formatServerReuseNotice,
  formatShutdownNotice,
  isLoopbackHost,
  isServerLockCollision,
  OkDirMissingError,
  parseIdleShutdownFlag,
  parseOnlyModule,
  parsePublicUrlFlag,
  resolveBundledReactShellDir,
  resolveCollabPort,
  resolveHost,
  resolveServerReuse,
  resolveStartConsoleLevel,
  resolveStartShellDir,
  scopeRemoteAliasConsentToBind,
  shouldOpenBrowser,
  shouldWarnHostOverridesMultiBind,
  startCommand,
  tryDescribeLockCollision,
  withEphemeralTempDirReap,
  withIdleShutdownProcessExit,
} from './start.ts';

describe('resolveHost', () => {
  test('returns --host flag when --bind is absent (second priority, after --bind)', () => {
    expect(resolveHost({ host: '0.0.0.0' }, { HOST: '127.0.0.2' })).toBe('0.0.0.0');
  });

  test('falls back to HOST env when --host is absent', () => {
    expect(resolveHost({}, { HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });

  test('falls back to DEFAULT_SERVER_HOST (numeric IPv4 loopback) when both flag and env are absent', () => {
    // Numeric `127.0.0.1`, NOT the `localhost` hostname: on Windows
    // `localhost` binds `::1` only while clients connect to `127.0.0.1`,
    // so the MCP-autostarted server was unreachable. A numeric default
    // skips DNS and binds the same family on every platform.
    expect(resolveHost({}, {})).toBe('127.0.0.1');
  });

  test('explicit undefined --host falls through to env (precedence: flag > env > default)', () => {
    expect(resolveHost({ host: undefined }, { HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });
});

describe('coerceRemoteBindHost', () => {
  test('no-op when remote access is disabled', () => {
    expect(coerceRemoteBindHost('::1', false)).toEqual({ host: '::1', coerced: false });
    expect(coerceRemoteBindHost('localhost', false)).toEqual({
      host: 'localhost',
      coerced: false,
    });
  });

  test('coerces IPv6/hostname binds to 127.0.0.1 in remote mode (tunnel proxy target)', () => {
    for (const host of ['::', '::1', '[::1]', 'localhost']) {
      expect(coerceRemoteBindHost(host, true)).toEqual({ host: '127.0.0.1', coerced: true });
    }
  });

  test('leaves loopback binds alone in remote mode', () => {
    expect(coerceRemoteBindHost('127.0.0.1', true)).toEqual({
      host: '127.0.0.1',
      coerced: false,
    });
  });

  test('coerces all-interfaces binds to loopback in remote mode', () => {
    expect(coerceRemoteBindHost('0.0.0.0', true)).toEqual({ host: '127.0.0.1', coerced: true });
  });
});

describe('expandRemoteAlias — --remote is a thin alias over the server.* keys', () => {
  const TUNNEL_URL = 'https://myproject.ngrok.app';

  /** Narrow to the ok:true arm or fail the test with a useful message. */
  function expectExpanded(alias: ReturnType<typeof expandRemoteAlias>) {
    if (alias === null || !alias.ok) {
      throw new Error(`expected a successful expansion, got ${JSON.stringify(alias)}`);
    }
    return alias;
  }

  test('expands to exactly the ratified keys — publicUrl + allowExternal + idleShutdown off', () => {
    expect(expandRemoteAlias(TUNNEL_URL, undefined)).toEqual({
      ok: true,
      url: TUNNEL_URL,
      serverOverlay: { publicUrl: TUNNEL_URL, allowExternal: true, idleShutdown: 'off' },
    });
  });

  test('resolves an identical server runtime to the equivalent --public-url invocation', () => {
    const config = makeTestConfig();
    const alias = expectExpanded(expandRemoteAlias(TUNNEL_URL, undefined));
    // What runStartCommand overlays for `ok start --remote <url>` …
    const aliasRuntime = resolveServerRuntimeConfig(
      applyConfigOverlay(config, {
        server: { bind: ['127.0.0.1'], ...alias.serverOverlay },
      }) as Config,
    );
    // … versus the ratified spelling of the same deployment:
    // `OK_ALLOW_EXTERNAL=1 OK_IDLE_SHUTDOWN=off ok start --public-url <url> --bind 127.0.0.1`.
    const env = resolveEnvConfigLayer({ OK_ALLOW_EXTERNAL: '1', OK_IDLE_SHUTDOWN: 'off' });
    const explicitRuntime = resolveServerRuntimeConfig(
      applyConfigOverlay(applyConfigOverlay(config, env.layer), {
        server: { bind: ['127.0.0.1'], publicUrl: TUNNEL_URL },
      }) as Config,
    );
    expect(aliasRuntime).toEqual(explicitRuntime);
    // The load-bearing shape: successor-key publicUrl (drives the ingress
    // policy + issued URLs), consent armed, loopback-only bind.
    expect(aliasRuntime.publicUrlSource).toBe('server');
    expect(aliasRuntime.allowExternal).toBe(true);
    expect(aliasRuntime.loopbackOnly).toBe(true);
    expect(aliasRuntime.idleShutdown).toBe('off');
  });

  test('a dormant remote.url in config does NOT arm anything without the flag', () => {
    expect(expandRemoteAlias(undefined, TUNNEL_URL)).toBeNull();
    expect(expandRemoteAlias(false, TUNNEL_URL)).toBeNull();
  });

  test('bare --remote pulls the url from config; an inline url wins over config', () => {
    expect(expectExpanded(expandRemoteAlias(true, TUNNEL_URL)).url).toBe(TUNNEL_URL);
    expect(expectExpanded(expandRemoteAlias('https://inline.example.com', TUNNEL_URL)).url).toBe(
      'https://inline.example.com',
    );
  });

  test('trailing slashes are stripped, matching the legacy resolver', () => {
    const alias = expectExpanded(expandRemoteAlias(`${TUNNEL_URL}/`, undefined));
    expect(alias.url).toBe(TUNNEL_URL);
    expect(alias.serverOverlay.publicUrl).toBe(TUNNEL_URL);
  });

  test('missing url anywhere refuses with the fix instruction', () => {
    const alias = expandRemoteAlias(true, undefined);
    expect(alias?.ok).toBe(false);
    if (alias === null || alias.ok) throw new Error('expected refusal');
    expect(alias.errorMessage).toContain('--remote requires a public tunnel URL');
  });

  test('non-URL and plain-http urls refuse — the legacy https-only rule is preserved', () => {
    const garbage = expandRemoteAlias('not a url', undefined);
    if (garbage === null || garbage.ok) throw new Error('expected refusal');
    expect(garbage.errorMessage).toContain('not a valid URL');
    const http = expandRemoteAlias('http://myproject.ngrok.app', undefined);
    if (http === null || http.ok) throw new Error('expected refusal');
    expect(http.errorMessage).toContain('must be https');
  });
});

describe('scopeRemoteAliasConsentToBind — self-consent is loopback-scoped', () => {
  const overlay = {
    publicUrl: 'https://myproject.ngrok.app',
    allowExternal: true,
    idleShutdown: 'off',
  } as const;

  test('a loopback bind keeps the alias self-consent', () => {
    expect(scopeRemoteAliasConsentToBind(overlay, ['127.0.0.1'])).toEqual(overlay);
    expect(scopeRemoteAliasConsentToBind(overlay, ['::1'])).toEqual(overlay);
  });

  test('a non-loopback bind drops allowExternal so the interlock refuses as it did pre-alias', () => {
    // `ok start --remote <url>` on a project with `server.bind: [<lan-ip>]`
    // exited 78 before the alias (the flag never consented to a bind that is
    // reachable AROUND the tunnel). The scoped overlay must not smuggle that
    // consent in.
    const scoped = scopeRemoteAliasConsentToBind(overlay, ['192.168.1.5']);
    expect('allowExternal' in scoped).toBe(false);
    expect(scoped.publicUrl).toBe(overlay.publicUrl);
    const runtime = resolveServerRuntimeConfig(
      applyConfigOverlay(makeTestConfig(), {
        server: { bind: ['192.168.1.5'], ...scoped },
      }) as Config,
    );
    expect(runtime.allowExternal).toBe(false);
    expect(requiresExternalConsent(runtime)).toBe(true);
  });

  test('a mixed loopback + non-loopback bind list also drops allowExternal (every, not some)', () => {
    expect(
      'allowExternal' in scopeRemoteAliasConsentToBind(overlay, ['127.0.0.1', '192.168.1.5']),
    ).toBe(false);
  });
});

describe('parsePublicUrlFlag', () => {
  test('accepts http and https origins (http covers tailnet/LAN deployments)', () => {
    expect(parsePublicUrlFlag('https://kb.example.com')).toBe('https://kb.example.com');
    expect(parsePublicUrlFlag('http://laptop.tail:55222')).toBe('http://laptop.tail:55222');
  });

  test('rejects garbage and non-http(s) schemes', () => {
    expect(() => parsePublicUrlFlag('not a url')).toThrow(/not a valid URL/);
    expect(() => parsePublicUrlFlag('ftp://kb.example.com')).toThrow(/http\(s\) origin/);
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
    // Embedded control byte + DEL: both must be stripped.
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
    // Prefix length is 'open-knowledge-server '.length = 22; truncated suffix
    // capped at 64 chars → total ≤ 22 + 64 = 86.
    expect(result.length).toBeLessThanOrEqual(86);
    expect(result.startsWith('open-knowledge-server ')).toBe(true);
    expect(result.length).toBe(22 + 64);
  });

  test('trims leading/trailing whitespace from the project name', () => {
    // basename() preserves the trailing dot/space-equivalents; the trim is
    // belt-and-braces against pathological project names. Pre-trim, the name
    // would be '  spaced  '; post-trim, 'spaced'.
    // node:path's basename doesn't surface leading spaces in typical paths,
    // but unusual filesystems (case-insensitive HFS+, FAT trailing-space
    // tolerance) make this defensive guard worthwhile.
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

// ----------------------------------------------------------------------------
// bootStartServer (integration)
// ----------------------------------------------------------------------------
//
// These exercise the composed boot path the Commander action wraps:
//   - HTTP server bound on the configured/kernel port
//   - GET / returns 404 with the React-UI-served-by-ok-ui pointer (no static
//     asset serving from `ok start` after the lifecycle split)
//   - /api/* dispatches via Hocuspocus onRequest hook (proves API routes
//     survive the split — not falling through to the SPA pointer)
//   - Auto-spawn-of-ok-ui-sibling fires when ui.lock is absent
//   - Auto-spawn skips when ui.lock is alive (idempotent re-acquire path)
//
// Each test gets a unique tmpdir and disposes via `booted.destroy()` in
// afterEach. PinoLogger is silent in NODE_ENV=test by default; no override needed.

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

describe('resolveCollabPort (env PORT suppression)', () => {
  test('explicit --port always wins', () => {
    expect(resolveCollabPort(4111, 5555, true)).toBe(4111);
    expect(resolveCollabPort(4111, 5555, false)).toBe(4111);
  });

  test('env PORT flows through for a plain local start', () => {
    expect(resolveCollabPort(undefined, 5555, false)).toBe(5555);
  });

  test('remote mode drops env PORT (PaaS edge-proxy injection)', () => {
    expect(resolveCollabPort(undefined, 5555, true)).toBeUndefined();
  });
});

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
    // Bun lacks process._getActiveHandles — the production path. The exit
    // must still fire, and the log must mark the empty summary as a data
    // gap rather than a clean state.
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
    // Pre-listen check needs <contentDir>/.ok/config.yml present. These tests
    // pass `skipAutoInit: true` so the CLI's `initContent` autoInitFn doesn't
    // scaffold one for us — seed manually.
    const okDir = resolve(tmpDir, '.ok');
    mkdirSync(okDir, { recursive: true });
    writeFileSync(resolve(okDir, 'config.yml'), '', 'utf-8');
    writeFileSync(resolve(okDir, '.gitignore'), '', 'utf-8');
    // Isolate HOME so the MCP config repair sweep (`os.homedir()` lookup
    // inside `repairMcpConfigs`) targets an empty tempdir instead of the
    // developer's real `~/.claude.json` / `~/.cursor/mcp.json` / …
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    booted = null;
  });

  afterEach(async () => {
    if (booted) {
      try {
        await booted.destroy();
      } catch {
        // Tests may have already triggered destroy via assertion failure paths;
        // the destroy itself is idempotent so the second call is a no-op.
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
      // PinoLogger is silent in NODE_ENV=test by default; no override needed.
    });
    const res = await fetchText(booted.port, '/');
    expect(res.status).toBe(404);
    // RFC 9457 problem+json — boot.ts non-/api/ fallback.
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = JSON.parse(res.body);
    expect(body.type).toBe('urn:ok:error:not-found');
    expect(body.title).toBe('Not found.');
    expect(body.status).toBe(404);
    expect(body.detail).toContain('This server is running without the web UI');
    expect(body.detail).toContain('/');
  });

  test('idleThresholdMs: null (--idle-shutdown off) threads through and boots (not the 30-min default)', async () => {
    // Load-bearing distinction: bootStartServer uses an explicit `=== undefined`
    // check, not `??`, so `null` disables idle shutdown rather than falling back
    // to DEFAULT_IDLE_THRESHOLD_MS. A refactor to `?? DEFAULT` would silently
    // re-enable the 30-min timer under `--idle-shutdown off`. Boot succeeding
    // with `null` proves the value is accepted and threaded to bootServer,
    // whose own `idleShutdownMs: null` contract disables the timer.
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
    // Pre-split the SPA fell through to dist/public/. Post-split there is no
    // static handler in `ok start` at all — every non-/api path returns the
    // pointer. This is the behavior the lifecycle split promises.
    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
      // PinoLogger is silent in NODE_ENV=test by default; no override needed.
    });
    const res = await fetchText(booted.port, '/assets/main-abcdef.js');
    expect(res.status).toBe(404);
    // RFC 9457 problem+json — same boot.ts fallback.
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
      // PinoLogger is silent in NODE_ENV=test by default; no override needed.
    });
    await booted.ready;

    // /api/document is the canonical health-check endpoint exposed by the API
    // extension. The exact response body depends on persistence's docName
    // semantics, but importantly the response MUST NOT be the
    // 'This server is running without the web UI' pointer — that would mean the request
    // fell through to the catch-all branch instead of hitting the API hook.
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
    // Status is whatever the API extension chose — we accept 200, 404, or any
    // 4xx; the assertion is purely 'not a 404 with the SPA pointer payload'.
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(600);
  });

  test('GET /api/nonexistent-route returns the API-route-not-found 404 (not the SPA pointer)', async () => {
    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
      // PinoLogger is silent in NODE_ENV=test by default; no override needed.
    });
    await booted.ready;

    const res = await fetchText(booted.port, '/api/totally-nonexistent-xyz');
    expect(res.status).toBe(404);
    // RFC 9457 problem+json — emitted by api-extension.ts's
    // dispatch fallback.
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
      // PinoLogger is silent in NODE_ENV=test by default; no override needed.
    });
    await booted.destroy();
    // Second call must not throw; it short-circuits via the internal guard.
    await booted.destroy();
    booted = null; // Prevent afterEach from calling destroy again — already done.
  });

  test('booted.port reflects the kernel-assigned port (server.port=0)', async () => {
    booted = await bootStartServer({
      config: makeTestConfig(),
      cwd: tmpDir,
      host: TEST_HOST,
      skipAutoInit: true,
      // PinoLogger is silent in NODE_ENV=test by default; no override needed.
    });
    expect(booted.port).toBeGreaterThan(0);
    expect(booted.port).toBeLessThan(65536);
  });

  test('D-034: /collab/keepalive accepts a bare WS upgrade without routing to Hocuspocus', async () => {
    // The MCP keep-alive path is served by a special upgrade branch in
    // start.ts that completes the WS handshake without handing off to
    // Hocuspocus. The WS has no docName, no Y.Doc — it exists purely so
    // the idle-shutdown primitive (which counts `/collab*` upgrades) sees
    // MCP as an active WebSocket client. Without this test, a future
    // refactor could silently route /collab/keepalive to Hocuspocus and
    // the WS would close immediately when Hocuspocus couldn't resolve a
    // docName, defeating the keep-alive.
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
      expect(ws.readyState).toBe(1); // OPEN

      // The WS should stay open — not get closed by the server after the
      // handshake. We wait 100ms and re-check readyState.
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
    // Repair sweep is best-effort; a failing host-config edit should never
    // prevent the collab server from starting up.
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
    // Sibling fail-soft contract — launch.json repair must never block boot.
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

  // --- content-asset serving (default-on) + --react-shell-dist-dir opt-in ---

  test('default — content assets are served from the server origin', async () => {
    // Nested path mirrors the attach-mode desktop shape: the renderer rewrites
    // `/<contentDir-relative>` inline-image srcs onto the lock holder's origin,
    // so a server booted with NO flags (MCP-autostarted, terminal `ok start`)
    // must serve them or attached windows render broken images.
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
    // PNGs are inline-renderable; Content-Disposition should be inline.
    const disposition = res.headers['content-disposition'];
    expect(typeof disposition === 'string' ? disposition : '').toContain('inline');
  });

  test('serveContentAssets: false — content paths return the SPA-pointer 404', async () => {
    // Explicit opt-out: no /<contentDir-relative> middleware, so the request
    // falls through to the "This server is running without the web UI" pointer.
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
    // Build a synthetic React-shell dist: just an index.html that sirv
    // (with single: true) serves on / and as the SPA fallback for unknown
    // routes.
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
        // Intentionally NOT skipping UI auto-spawn — the point of this test
        // is that --react-shell-dist-dir suppresses the sibling spawn
        // automatically.
        spawn: fakeSpawn,
        reactShellDistDir: shellDir,
      });

      // (a) Shell is served on /
      const rootRes = await fetchText(booted.port, '/');
      expect(rootRes.status).toBe(200);
      expect(rootRes.body).toContain('react-shell-test-sentinel');

      // (b) SPA fallback — unknown deep links return index.html (single: true)
      const deepRes = await fetchText(booted.port, '/some/deep/route');
      expect(deepRes.status).toBe(200);
      expect(deepRes.body).toContain('react-shell-test-sentinel');

      // (c) sibling spawn was auto-suppressed
      expect(spawnCalls.length).toBe(0);

      // (d) /api/* still routed (not shadowed by SPA)
      const apiRes = await fetchText(booted.port, '/api/totally-nonexistent-xyz');
      expect(apiRes.status).toBe(404);
      const apiBody = JSON.parse(apiRes.body);
      expect(apiBody.title).toBe('API endpoint not found.');
    } finally {
      await rm(shellDir, { recursive: true, force: true });
    }
  });

  test('--serve-content-assets and --react-shell-dist-dir compose additively', async () => {
    // Desktop-spawn-mode shape: both flags set → server is single-origin for
    // API, collab, content assets, AND the React shell. Today's utility's
    // behavior, now expressible via the CLI surface.
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

      // Content asset served (precedence over SPA fallback)
      const assetRes = await fetchText(booted.port, '/fixture-image.png');
      expect(assetRes.status).toBe(200);
      expect(assetRes.body).toBe('fake-png-bytes');

      // React shell served on /
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
    // ok start requires .ok/ to exist (no longer scaffolds it).
    // Pre-seed so these tests can reach the git / shadow-repo assertions.
    const okDir = resolve(tmpDir, '.ok');
    mkdirSync(okDir, { recursive: true });
    writeFileSync(resolve(okDir, 'config.yml'), '', 'utf-8');
    writeFileSync(resolve(okDir, '.gitignore'), '', 'utf-8');
    // Isolate HOME so the MCP repair sweep targets an empty tempdir.
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    booted = null;
  });

  afterEach(async () => {
    if (booted) {
      try {
        await booted.destroy();
      } catch {
        // idempotent
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
    });

    // ok start never runs git init — .git/HEAD must not exist
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
      // The shadow-repo init runs in async boot (`initAsync`); `degraded` is only
      // stable after `ready` resolves. Await it while PATH is still narrowed so
      // the git spawn fails inside the window rather than after the finally
      // restores PATH (an unawaited read races the async init).
      await booted.ready;
      // shadow-repo init fails (no git binary) but server boots in degraded mode
      expect(booted.degraded).toContain('shadow-repo');
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

// ----------------------------------------------------------------------------
// bootStartServer — no scaffold when .ok/config.yml is absent
// ----------------------------------------------------------------------------

describe('bootStartServer — rejects with init-required when .ok/config.yml is absent', () => {
  let tmpDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(resolve(tmpdir(), 'ok-start-no-scaffold-'));
    // Intentionally no .ok/config.yml — the test asserts ok start refuses to scaffold.
    // HOME-isolated for the `skipAutoInit: true` test below: that test bypasses
    // the okDir guard so the MCP repair sweep runs against `os.homedir()` — if
    // unisolated, it would read/repair the developer's real ~/.claude.json.
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

    // .ok/ must not have been created — no silent scaffolding
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
    // Mimics a nested folder-rule sidecar (`set_folder_rule` / `write_template`
    // create `<folder>/.ok/` with no `config.yml`). The CLI guard must not
    // accept it as a valid project root.
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
    // The CLI guard is bypassed, but the server's own pre-listen check still
    // requires .ok/config.yml. Pre-seed it so the boot can complete.
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

// startCommand --mode flag.
// These exercise the Commander wiring at the public CLI surface — the
// validator (parseStartMode), the --mode=app + --open mutual-exclusion
// guard (→ exit 2), and the --mode=app + no-bundle error path
// (→ exit 1). The launch-when-detected path is covered by
// desktop-dispatch.test.ts (detectDesktop matrix + launchDesktop spawn
// shape); replicating it here would require monkey-patching the
// module-level `nativeSpawn` import for no added confidence.
describe('startCommand — --mode flag wiring', () => {
  function fakeConfig() {
    return makeTestConfig();
  }

  /** Silence Commander's own help / usage prints during these tests. */
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
    // Sanity check that the validator accepts the documented values.
    // We strip the action by parsing with --help, which short-circuits
    // before the action runs but still validates options.
    const cmd = quietCommand();
    // --help triggers a (HelpDisplayed) exit override throw — the value
    // we care about is that --mode browser was parsed without throwing
    // an InvalidArgumentError before --help took effect.
    let helpDisplayed = false;
    try {
      cmd.parse(['--mode', 'browser', '--help'], { from: 'user' });
    } catch (err) {
      // Commander throws CommanderError(code='commander.helpDisplayed') on
      // --help under exitOverride; any other code means the validator failed.
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
    // OK_FORCE_BROWSER=1 makes detectDesktop deterministically return false
    // with reason='force-browser'. The contextual notFoundMessage(reason)
    // surfaces the force-browser-specific guidance, NOT the bundle-missing
    // message — verifying the reason-aware error path landed correctly.
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
    // Force-browser reason → its specific message (not the generic
    // "Desktop app not found"). Crucially this proves the contextual
    // refactor: the user sees an actionable message naming the env var
    // they set, instead of a misleading "not found" claim.
    expect(capturedStderr).toContain('OK_FORCE_BROWSER');
    expect(capturedStderr).toMatch(/disabled|unset/i);
    expect(capturedStderr).not.toContain('not found');
  });
});

// Holder-specific lock-collision messages — covers the 5 paths in
// tryDescribeLockCollision: non-collision → null, kind=interactive →
// desktop message, kind=mcp-spawned → MCP message, meta=null → generic,
// readServerLock throws → null fallback.
describe('tryDescribeLockCollision', () => {
  /** Synthetic ServerLockCollisionError + readServerLock + ServerLockMetadata. */
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
      // Stub the rest of the public surface to satisfy the type cast.
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
    // Failure to read metadata MUST NOT block the original error path —
    // returning null lets the caller fall back to the generic message.
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

describe('resolveHost — --bind precedence', () => {
  test('--bind wins over the deprecated --host alias and env', () => {
    expect(resolveHost({ bind: ['0.0.0.0'], host: '127.0.0.2' }, { HOST: '127.0.0.3' })).toBe(
      '0.0.0.0',
    );
  });

  test('empty bind list falls through to --host', () => {
    expect(resolveHost({ bind: [], host: '127.0.0.2' }, {})).toBe('127.0.0.2');
  });
});

describe('parseOnlyModule', () => {
  test('accepts ui and server', () => {
    expect(parseOnlyModule('ui')).toBe('ui');
    expect(parseOnlyModule('server')).toBe('server');
  });

  test('rejects anything else', () => {
    expect(() => parseOnlyModule('api')).toThrow(/--only must be/);
  });
});

describe('resolveBundledReactShellDir (candidate-path probe)', () => {
  test('returns the first candidate that exists', () => {
    // Injected existsFn accepts any path — asserts the probe returns the FIRST
    // hit (the published `dist/public` slot is tried before the monorepo paths).
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
    legacyOpen: false,
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

  test('deprecated --open force-opens even without a TTY (pre-flip contract)', () => {
    expect(shouldOpenBrowser({ ...base, legacyOpen: true, isTTY: false })).toBe(true);
  });

  test('no TTY (spawned/CI) stays quiet', () => {
    expect(shouldOpenBrowser({ ...base, isTTY: false })).toBe(false);
  });

  test('non-loopback bind stays quiet', () => {
    expect(shouldOpenBrowser({ ...base, host: '0.0.0.0' })).toBe(false);
  });

  test('remote mode stays quiet', () => {
    expect(shouldOpenBrowser({ ...base, remoteEnabled: true })).toBe(false);
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

  // Guard-ordering regressions: --open must not override the "nothing to open"
  // or "explicit no" suppressions (only the TTY / loopback gates).
  test('--open does NOT open a dead tab at a shell-less --only server', () => {
    expect(shouldOpenBrowser({ ...base, legacyOpen: true, only: 'server', servesUi: false })).toBe(
      false,
    );
  });

  test('--open does NOT open when no shell was served', () => {
    expect(shouldOpenBrowser({ ...base, legacyOpen: true, servesUi: false })).toBe(false);
  });

  test('--no-open-browser wins over --open (explicit no)', () => {
    expect(shouldOpenBrowser({ ...base, legacyOpen: true, openBrowser: false })).toBe(false);
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
      readUiLock: () => null,
    });
    expect(info).toEqual({
      url: 'http://127.0.0.1:24550',
      kind: 'interactive',
      pid: 42,
      servesUi: true,
    });
  });

  test('sibling topology (no ui capability): reports the live ui.lock advertisement', async () => {
    const info = await resolveServerReuse({
      ...immediate,
      readServerLock: () => ({
        pid: 42,
        port: 24_550,
        url: 'http://127.0.0.1:24550',
        capabilities: ['http', 'ws'],
      }),
      readUiLock: () => ({ pid: 43, port: 39_847 }),
    });
    expect(info?.url).toBe('http://localhost:39847');
    expect(info?.servesUi).toBe(false);
  });

  test('sibling topology: prefers the ui.lock url when present (IPv6 bind, not localhost)', async () => {
    const info = await resolveServerReuse({
      ...immediate,
      readServerLock: () => ({ pid: 42, port: 24_550, capabilities: ['http', 'ws'] }),
      readUiLock: () => ({ pid: 43, port: 39_847, url: 'http://[::1]:39847' }),
    });
    expect(info?.url).toBe('http://[::1]:39847');
    expect(info?.servesUi).toBe(false);
  });

  test('no ui anywhere: falls back to the server address', async () => {
    const info = await resolveServerReuse({
      ...immediate,
      readServerLock: () => ({ pid: 42, port: 24_550 }),
      readUiLock: () => null,
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
      readUiLock: () => null,
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
      readUiLock: () => null,
    });
    expect(info).toBeNull();
  });

  test('sentinel that never binds times out to null', async () => {
    let clock = 0;
    const info = await resolveServerReuse({
      readServerLock: () => ({ pid: 42, port: 0 }),
      readUiLock: () => null,
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
      readUiLock: () => null,
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
    // The flag deliberately stays a string through Commander — returning `null`
    // here would be silently coerced to `''` by Commander and read downstream
    // as a 0 ms threshold (idle-shutdown fires on boot).
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
  // Exercises the REAL option registration end-to-end. Before the fix,
  // parseIdleShutdownFlag returned `null` for 'off'; Commander coerced that to
  // `''`, which `bootStartServer` read as a 0 ms idle threshold and the server
  // self-terminated on boot. A parseIdleShutdownFlag unit test cannot catch
  // this — the mangling happens inside Commander, not the parser.
  async function captureParsedOpts(argv: string[]): Promise<Record<string, unknown>> {
    const cmd = startCommand(() => makeTestConfig());
    cmd.exitOverride();
    cmd.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    // Replace the boot action with a capture (last .action wins in Commander)
    // so parsing does not stand up a server.
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
  function quietCommand() {
    const cmd = startCommand(() => makeTestConfig());
    cmd.exitOverride();
    cmd.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    return cmd;
  }

  /**
   * Parse argv against the real `startCommand` action with process.exit +
   * stderr stubbed, returning the captured exit code and stderr. Each guard
   * exits before any server boot, so no teardown is needed.
   */
  async function captureGuard(
    argv: string[],
  ): Promise<{ code: number | undefined; stderr: string }> {
    const cmd = quietCommand();
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

  // The wave3 "multiple --bind exit 2" guard test was removed here —
  // multi-address bind is now real (guard dropped in start.ts; behavior
  // covered by the multi-bind boot tests in boot.test.ts).

  test('--server-url without --only ui exits 2', async () => {
    const { code, stderr } = await captureGuard(['--server-url', 'http://127.0.0.1:24550']);
    expect(code).toBe(2);
    expect(stderr).toContain('--server-url');
  });

  test('--only ui without --server-url exits 2', async () => {
    const { code, stderr } = await captureGuard(['--only', 'ui']);
    expect(code).toBe(2);
    expect(stderr).toContain('--server-url');
  });

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

  test('--only ui + --mode app exits 2 (would silently drop --mode app)', async () => {
    const { code, stderr } = await captureGuard([
      '--only',
      'ui',
      '--server-url',
      'http://127.0.0.1:24550',
      '--mode',
      'app',
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain('--mode app');
  });

  test('--only ui + --remote exits 2 (would silently drop --remote)', async () => {
    const { code, stderr } = await captureGuard([
      '--only',
      'ui',
      '--server-url',
      'http://127.0.0.1:24550',
      '--remote',
      'https://tunnel.example.com',
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain('--remote');
  });

  test('--single-file + --remote exits 2 (no consented root to expose)', async () => {
    const { code, stderr } = await captureGuard([
      '--single-file',
      '/tmp/note.md',
      '--remote',
      'https://tunnel.example.com',
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain('--single-file');
  });

  test('--remote + --public-url exits 2 (the alias IS a public-url; one must win)', async () => {
    const { code, stderr } = await captureGuard([
      '--remote',
      'https://tunnel.example.com',
      '--public-url',
      'https://kb.example.com',
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain('--public-url');
  });

  /**
   * The pre-boot `--remote` refusals print via console.warn/console.error
   * (vitest intercepts the console, so `captureGuard`'s stderr stub never
   * sees them) — collect both streams via spies alongside the exit code.
   */
  async function captureRemoteRefusal(
    argv: string[],
  ): Promise<{ code: number | undefined; output: string }> {
    const lines: string[] = [];
    const record = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(record);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(record);
    try {
      const { code, stderr } = await captureGuard(argv);
      return { code, output: `${stderr}\n${lines.join('\n')}` };
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  }

  test('--remote without a url anywhere exits 78 and names the successor keys in the deprecation notice', async () => {
    const { code, output } = await captureRemoteRefusal(['--remote']);
    expect(code).toBe(78);
    expect(output).toContain('--remote requires a public tunnel URL');
    // The deprecation notice fires even on the refusal path — EXACTLY once —
    // and names every key the alias pins (--public-url / --bind /
    // OK_ALLOW_EXTERNAL / OK_IDLE_SHUTDOWN=off), so an operator learns the
    // full ratified spelling from the same run that errors. Omitting the
    // idle-shutdown key would hand migrators a server that tears itself down
    // after 30 idle minutes under a live remote MCP client.
    expect(output.split('--remote is deprecated').length - 1).toBe(1);
    expect(output).toContain('--public-url');
    expect(output).toContain('--bind');
    expect(output).toContain('OK_ALLOW_EXTERNAL');
    expect(output).toContain('OK_IDLE_SHUTDOWN=off');
  });

  test('--remote with a plain-http url exits 78 (legacy https-only rule preserved)', async () => {
    const { code, output } = await captureRemoteRefusal(['--remote', 'http://tunnel.example.com']);
    expect(code).toBe(78);
    expect(output).toContain('must be https');
  });

  test('--only ui prints the deprecation notice even on the missing --server-url refusal', async () => {
    // Same contract as the --remote notice: the operator learns the
    // successor spelling (`ok start`) from the same run that errors, exactly
    // once, on stderr.
    const { code, output } = await captureRemoteRefusal(['--only', 'ui']);
    expect(code).toBe(2);
    expect(output).toContain("'--only ui' requires '--server-url");
    expect(output.split('`--only ui` is deprecated').length - 1).toBe(1);
    expect(output).toContain('ok start');
  });
});
