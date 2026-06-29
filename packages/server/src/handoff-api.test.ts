import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { setTimeout as wait } from 'node:timers/promises';
import {
  createInstalledAgentsProbe,
  createOsProbe,
  type ExecFileLike,
  handleInstalledAgents,
  INSTALLED_AGENTS_CACHE_TTL_MS,
  INSTALLED_AGENTS_SCHEMES,
  type InstalledAgentScheme,
  isLocalWebHost,
} from './handoff-api.ts';
import { listenOnLoopback } from './loopback-rig-test-helpers.ts';

describe('createInstalledAgentsProbe', () => {
  test('returns a record with exactly claude/codex/cursor keys', async () => {
    const probe = createInstalledAgentsProbe({ probe: async () => true });
    const result = await probe.probeAll();
    expect(Object.keys(result).sort()).toEqual(['claude', 'codex', 'cursor']);
    expect(result).toEqual({ claude: true, codex: true, cursor: true });
  });

  test('3 calls within TTL produce 1 probe per scheme (cache hit)', async () => {
    const counts: Record<string, number> = {};
    const probeFn = async (scheme: InstalledAgentScheme) => {
      counts[scheme] = (counts[scheme] ?? 0) + 1;
      return true;
    };

    let clockNow = 1_000_000; // arbitrary starting epoch
    const { probeAll } = createInstalledAgentsProbe({ probe: probeFn, now: () => clockNow });

    await probeAll();
    clockNow += 1000; // +1s
    await probeAll();
    clockNow += 58_000; // +58s (still within 60s TTL)
    await probeAll();

    expect(counts).toEqual({ claude: 1, codex: 1, cursor: 1 });
  });

  test('calls after TTL expiration trigger re-probe', async () => {
    const counts: Record<string, number> = {};
    const probeFn = async (scheme: InstalledAgentScheme) => {
      counts[scheme] = (counts[scheme] ?? 0) + 1;
      return true;
    };

    let clockNow = 0;
    const { probeAll } = createInstalledAgentsProbe({ probe: probeFn, now: () => clockNow });

    await probeAll();
    clockNow += INSTALLED_AGENTS_CACHE_TTL_MS + 1;
    await probeAll();

    expect(counts).toEqual({ claude: 2, codex: 2, cursor: 2 });
  });

  test('concurrent calls coalesce into a single probe per scheme', async () => {
    const counts: Record<string, number> = {};
    const probeFn = async (scheme: InstalledAgentScheme) => {
      counts[scheme] = (counts[scheme] ?? 0) + 1;
      await wait(0);
      return true;
    };
    const { probeAll } = createInstalledAgentsProbe({ probe: probeFn });
    await Promise.all([probeAll(), probeAll(), probeAll(), probeAll(), probeAll()]);
    expect(counts).toEqual({ claude: 1, codex: 1, cursor: 1 });
  });

  test('probe rejection resolves to false and caches the false for the TTL', async () => {
    let calls = 0;
    const probeFn = async () => {
      calls++;
      throw new Error('probe timeout');
    };
    let clockNow = 0;
    const { probeWithCache } = createInstalledAgentsProbe({
      probe: probeFn,
      now: () => clockNow,
    });
    expect(await probeWithCache('claude')).toBe(false);
    clockNow += 10_000; // well within TTL
    expect(await probeWithCache('claude')).toBe(false);
    expect(calls).toBe(1);
  });

  test('ttlMs override is respected', async () => {
    const counts: Record<string, number> = {};
    const probeFn = async (scheme: InstalledAgentScheme) => {
      counts[scheme] = (counts[scheme] ?? 0) + 1;
      return false;
    };
    let clockNow = 0;
    const { probeWithCache } = createInstalledAgentsProbe({
      probe: probeFn,
      now: () => clockNow,
      ttlMs: 5_000,
    });
    await probeWithCache('cursor');
    clockNow += 5_001;
    await probeWithCache('cursor');
    expect(counts.cursor).toBe(2);
  });
});

describe('handleInstalledAgents', () => {
  function createMockReq(
    method: string,
    headers: Record<string, string> = {},
  ): import('node:http').IncomingMessage {
    return { method, headers } as import('node:http').IncomingMessage;
  }

  function createMockRes(): {
    res: import('node:http').ServerResponse;
    writeHead: { status?: number; headers?: Record<string, string> };
    body: string;
  } {
    const writeHead: { status?: number; headers?: Record<string, string> } = {};
    let body = '';
    const res = {
      writeHead(status: number, headers: Record<string, string>) {
        writeHead.status = status;
        writeHead.headers = headers;
      },
      end(chunk?: string) {
        body = chunk ?? '';
      },
    } as unknown as import('node:http').ServerResponse;
    return {
      res,
      writeHead,
      get body() {
        return body;
      },
    };
  }

  test('GET returns 200 with flat boolean record body', async () => {
    const probeAll = async () => ({ claude: true, codex: false, cursor: true }) as const;
    const mock = createMockRes();
    await handleInstalledAgents(createMockReq('GET'), mock.res, probeAll);
    expect(mock.writeHead.status).toBe(200);
    expect(mock.writeHead.headers?.['Content-Type']).toBe('application/json');
    expect(JSON.parse(mock.body)).toEqual({ claude: true, codex: false, cursor: true });
  });

  test('POST returns 405 + RFC 9457 problem+json', async () => {
    const probeAll = async () => ({ claude: false, codex: false, cursor: false });
    const mock = createMockRes();
    await handleInstalledAgents(createMockReq('POST'), mock.res, probeAll);
    expect(mock.writeHead.status).toBe(405);
    expect(mock.writeHead.headers?.['Content-Type']).toBe('application/problem+json');
    expect(mock.writeHead.headers?.Allow).toBe('GET');
    const body = JSON.parse(mock.body) as Record<string, unknown>;
    expect(body.type).toBe('urn:ok:error:method-not-allowed');
    expect(body.status).toBe(405);
    expect(typeof body.title).toBe('string');
  });

  test('PUT returns 405', async () => {
    const probeAll = async () => ({ claude: false, codex: false, cursor: false });
    const mock = createMockRes();
    await handleInstalledAgents(createMockReq('PUT'), mock.res, probeAll);
    expect(mock.writeHead.status).toBe(405);
  });

  test('DELETE returns 405', async () => {
    const probeAll = async () => ({ claude: false, codex: false, cursor: false });
    const mock = createMockRes();
    await handleInstalledAgents(createMockReq('DELETE'), mock.res, probeAll);
    expect(mock.writeHead.status).toBe(405);
  });

  test('probe throw inside probeAll returns 500 + RFC 9457 problem+json (defensive — normally unreachable)', async () => {
    const probeAll = async () => {
      throw new Error('unexpected');
    };
    const mock = createMockRes();
    await handleInstalledAgents(createMockReq('GET'), mock.res, probeAll);
    expect(mock.writeHead.status).toBe(500);
    expect(mock.writeHead.headers?.['Content-Type']).toBe('application/problem+json');
    const body = JSON.parse(mock.body) as Record<string, unknown>;
    expect(body.type).toBe('urn:ok:error:internal-server-error');
    expect(body.status).toBe(500);
  });

  test('D47 capability-tier: remote-web Host → all-true and probe NOT called', async () => {
    let probeCalled = false;
    const probeAll = async () => {
      probeCalled = true;
      return { claude: false, codex: false, cursor: false };
    };
    const mock = createMockRes();
    await handleInstalledAgents(
      createMockReq('GET', { host: 'example.com:5173' }),
      mock.res,
      probeAll,
    );
    expect(mock.writeHead.status).toBe(200);
    expect(JSON.parse(mock.body)).toEqual({ claude: true, codex: true, cursor: true });
    expect(probeCalled).toBe(false);
  });

  test('D47 capability-tier: local-web Host → real probe results', async () => {
    let probeCalled = false;
    const probeAll = async () => {
      probeCalled = true;
      return { claude: true, codex: false, cursor: true };
    };
    const mock = createMockRes();
    await handleInstalledAgents(
      createMockReq('GET', { host: 'localhost:5173' }),
      mock.res,
      probeAll,
    );
    expect(mock.writeHead.status).toBe(200);
    expect(JSON.parse(mock.body)).toEqual({ claude: true, codex: false, cursor: true });
    expect(probeCalled).toBe(true);
  });
});

describe('createOsProbe', () => {
  type ExecCall = { cmd: string; args: readonly string[] };

  function makeExecFake(responses: Record<string, { err?: Error | null; stdout?: string }>): {
    exec: ExecFileLike;
    calls: ExecCall[];
  } {
    const calls: ExecCall[] = [];
    const exec: ExecFileLike = (file, args, _opts, cb) => {
      calls.push({ cmd: file, args });
      const key = Object.keys(responses).find((k) => k === file) ?? file;
      const resp = responses[key] ?? {};
      queueMicrotask(() => {
        cb(resp.err ?? null, resp.stdout ?? '', '');
      });
    };
    return { exec, calls };
  }

  test('macOS probe uses osascript with app-name mapping per scheme', async () => {
    const { exec, calls } = makeExecFake({ osascript: { stdout: 'com.anthropic.claude' } });
    const probe = createOsProbe('darwin', exec);
    expect(await probe('claude')).toBe(true);
    expect(calls[0]?.cmd).toBe('osascript');
    expect(calls[0]?.args).toEqual(['-e', 'id of app "Claude"']);
  });

  test('macOS probe returns false when every candidate name errors (app not installed)', async () => {
    const err = Object.assign(new Error('exit 1'), { code: 1 });
    const { exec, calls } = makeExecFake({ osascript: { err } });
    const probe = createOsProbe('darwin', exec);
    expect(await probe('codex')).toBe(false);
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  test('macOS codex scheme tries "Codex" first, falls back to "OpenAI Codex"', async () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    let callIndex = 0;
    const exec: ExecFileLike = (file, args, _opts, cb) => {
      calls.push({ cmd: file, args });
      const index = callIndex++;
      queueMicrotask(() => {
        if (index === 0) {
          cb(Object.assign(new Error('exit 1'), { code: 1 }), '', '');
        } else {
          cb(null, 'com.openai.codex\n', '');
        }
      });
    };
    const probe = createOsProbe('darwin', exec);
    expect(await probe('codex')).toBe(true);
    expect(calls[0]?.args).toEqual(['-e', 'id of app "Codex"']);
    expect(calls[1]?.args).toEqual(['-e', 'id of app "OpenAI Codex"']);
  });

  test('macOS codex scheme resolves on first candidate when "Codex" matches', async () => {
    const { exec, calls } = makeExecFake({ osascript: { stdout: 'com.openai.codex' } });
    const probe = createOsProbe('darwin', exec);
    expect(await probe('codex')).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]?.args).toEqual(['-e', 'id of app "Codex"']);
  });

  test('Windows probe uses reg query HKCR\\<scheme> (merged user+machine view)', async () => {
    const { exec, calls } = makeExecFake({ reg: {} });
    const probe = createOsProbe('win32', exec);
    expect(await probe('cursor')).toBe(true);
    expect(calls[0]?.cmd).toBe('reg');
    expect(calls[0]?.args).toEqual(['query', 'HKCR\\cursor', '/ve']);
  });

  test('Windows probe returns false when reg query non-zero exit', async () => {
    const err = Object.assign(new Error('exit 1'), { code: 1 });
    const { exec } = makeExecFake({ reg: { err } });
    const probe = createOsProbe('win32', exec);
    expect(await probe('claude')).toBe(false);
  });

  test('Linux probe uses xdg-mime query default x-scheme-handler/<scheme>', async () => {
    const { exec, calls } = makeExecFake({
      'xdg-mime': { stdout: 'anthropic-claude.desktop' },
    });
    const probe = createOsProbe('linux', exec);
    expect(await probe('claude')).toBe(true);
    expect(calls[0]?.cmd).toBe('xdg-mime');
    expect(calls[0]?.args).toEqual(['query', 'default', 'x-scheme-handler/claude']);
  });

  test('Linux probe empty stdout → false', async () => {
    const { exec } = makeExecFake({ 'xdg-mime': { stdout: '' } });
    const probe = createOsProbe('linux', exec);
    expect(await probe('cursor')).toBe(false);
  });

  test('Linux probe whitespace-only stdout → false', async () => {
    const { exec } = makeExecFake({ 'xdg-mime': { stdout: '   \n\t\n' } });
    const probe = createOsProbe('linux', exec);
    expect(await probe('cursor')).toBe(false);
  });

  test('Linux probe exec error → false (conservative default)', async () => {
    const err = Object.assign(new Error('command not found'), { code: 'ENOENT' });
    const { exec } = makeExecFake({ 'xdg-mime': { err } });
    const probe = createOsProbe('linux', exec);
    expect(await probe('claude')).toBe(false);
  });

  test('unknown platform falls back to Linux xdg-mime path', async () => {
    const { exec, calls } = makeExecFake({ 'xdg-mime': { stdout: 'foo.desktop' } });
    const probe = createOsProbe('aix' as NodeJS.Platform, exec);
    expect(await probe('cursor')).toBe(true);
    expect(calls[0]?.cmd).toBe('xdg-mime');
  });
});

describe('isLocalWebHost — capability-tier Host detection (D47)', () => {
  function reqWith(headers: Record<string, string>): import('node:http').IncomingMessage {
    return { headers } as unknown as import('node:http').IncomingMessage;
  }

  test('Host: localhost:5173 → local-web', () => {
    expect(isLocalWebHost(reqWith({ host: 'localhost:5173' }))).toBe(true);
  });

  test('Host: 127.0.0.1:5173 → local-web', () => {
    expect(isLocalWebHost(reqWith({ host: '127.0.0.1:5173' }))).toBe(true);
  });

  test('Host: [::1]:5173 (IPv6 bracketed) → local-web', () => {
    expect(isLocalWebHost(reqWith({ host: '[::1]:5173' }))).toBe(true);
  });

  test('Host: localhost (no port) → local-web', () => {
    expect(isLocalWebHost(reqWith({ host: 'localhost' }))).toBe(true);
  });

  test('Host: example.com:5173 → remote-web', () => {
    expect(isLocalWebHost(reqWith({ host: 'example.com:5173' }))).toBe(false);
  });

  test('Host: 192.168.1.100:5173 → remote-web (LAN address, not loopback)', () => {
    expect(isLocalWebHost(reqWith({ host: '192.168.1.100:5173' }))).toBe(false);
  });

  test('Host: 127.0.0.1.evil.com → remote-web (rebinding-style hostname is NOT loopback)', () => {
    expect(isLocalWebHost(reqWith({ host: '127.0.0.1.evil.com:5173' }))).toBe(false);
  });

  test('no Host header but Origin: http://localhost → local-web (Origin fallback)', () => {
    expect(isLocalWebHost(reqWith({ origin: 'http://localhost:5173' }))).toBe(true);
  });

  test('no Host header but Origin: https://example.com → remote-web', () => {
    expect(isLocalWebHost(reqWith({ origin: 'https://example.com' }))).toBe(false);
  });

  test('no Host and no Origin → local-web (conservative default; route gate already required loopback socket)', () => {
    expect(isLocalWebHost(reqWith({}))).toBe(true);
  });

  test('malformed Host falls back to Origin when present', () => {
    expect(
      isLocalWebHost(reqWith({ host: '::::not-a-host::::', origin: 'http://localhost' })),
    ).toBe(true);
  });

  test('malformed Origin → remote-web (conservative — non-loopback)', () => {
    expect(isLocalWebHost(reqWith({ origin: 'not a url at all' }))).toBe(false);
  });

  test('empty Host string falls back to Origin', () => {
    expect(isLocalWebHost(reqWith({ host: '', origin: 'http://127.0.0.1:5173' }))).toBe(true);
  });
});

describe('GET /api/installed-agents (integration — real HTTP + real createApiExtension)', () => {
  let tmpDir: string;
  let contentDir: string;
  let server: import('node:http').Server;
  let port: number;
  let probeCalls: Record<string, number>;

  beforeEach(async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { mkdirSync } = await import('node:fs');
    tmpDir = await mkdtemp(join(tmpdir(), 'installed-agents-'));
    contentDir = join(tmpDir, 'content');
    mkdirSync(contentDir, { recursive: true });

    probeCalls = {};

    const { Hocuspocus } = await import('@hocuspocus/server');
    const { AgentSessionManager } = await import('./agent-sessions.ts');
    const { createApiExtension } = await import('./api-extension.ts');

    const hocuspocus = new Hocuspocus({ quiet: true });
    const sessionManager = new AgentSessionManager(hocuspocus);

    const ext = createApiExtension({
      hocuspocus,
      sessionManager,
      contentDir,
      getFileIndex: () => new Map(),
      installedAgentsProbe: async (scheme) => {
        probeCalls[scheme] = (probeCalls[scheme] ?? 0) + 1;
        return scheme === 'claude' || scheme === 'cursor';
      },
    });

    const { createServer } = await import('node:http');
    server = createServer((req, res) => {
      // biome-ignore lint/suspicious/noExplicitAny: test harness
      hocuspocus.hooks('onRequest', { request: req, response: res } as any).catch(() => {
        if (!res.writableEnded) {
          res.writeHead(500);
          res.end('Error');
        }
      });
    });

    hocuspocus.configuration.extensions.push(ext);

    ({ port } = await listenOnLoopback(server));
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('GET returns 200 + flat boolean record matching injected probe', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/installed-agents`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body).toEqual({ claude: true, codex: false, cursor: true });
  });

  test('3 GETs within cache TTL trigger exactly 1 probe per scheme', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/api/installed-agents`);
      expect(res.status).toBe(200);
    }
    expect(probeCalls).toEqual({ claude: 1, codex: 1, cursor: 1 });
  });

  test('POST returns 405 + RFC 9457 problem+json with Allow: GET', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/installed-agents`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('Content-Type')).toBe('application/problem+json');
    expect(res.headers.get('Allow')).toBe('GET');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.type).toBe('urn:ok:error:method-not-allowed');
    expect(body.status).toBe(405);
    expect(typeof body.title).toBe('string');
  });

  test('schemes constant is exactly the three product targets', () => {
    expect([...INSTALLED_AGENTS_SCHEMES]).toEqual(['claude', 'codex', 'cursor']);
  });

  test('rejects cross-origin requests (DNS-rebinding / malicious-page defense)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/installed-agents`, {
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('Content-Type')).toBe('application/problem+json');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.type).toBe('urn:ok:error:invalid-origin');
    expect(body.status).toBe(403);
  });

  test('accepts same-origin browser requests (Origin: http://127.0.0.1)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/installed-agents`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ claude: true, codex: false, cursor: true });
  });


  test('remote-web (Host: example.com) → all-true and probe NOT called', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/installed-agents`, {
      headers: {
        Host: 'example.com:5173',
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ claude: true, codex: true, cursor: true });
    expect(probeCalls).toEqual({});
  });

  test('remote-web (Host: 192.168.1.100) → all-true (LAN-bound dev server case)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/installed-agents`, {
      headers: { Host: '192.168.1.100:5173' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claude: true, codex: true, cursor: true });
    expect(probeCalls).toEqual({});
  });

  test('local-web Host: 127.0.0.1 → real probe results', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/installed-agents`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claude: true, codex: false, cursor: true });
    expect(probeCalls).toEqual({ claude: 1, codex: 1, cursor: 1 });
  });

  test('remote-web requests are NOT cached against later local-web requests', async () => {
    const remote = await fetch(`http://127.0.0.1:${port}/api/installed-agents`, {
      headers: { Host: 'example.com:5173' },
    });
    expect(await remote.json()).toEqual({ claude: true, codex: true, cursor: true });
    expect(probeCalls).toEqual({});

    const local = await fetch(`http://127.0.0.1:${port}/api/installed-agents`);
    expect(await local.json()).toEqual({ claude: true, codex: false, cursor: true });
    expect(probeCalls).toEqual({ claude: 1, codex: 1, cursor: 1 });
  });
});
