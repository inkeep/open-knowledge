import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stdSerializers } from 'pino';
import type { Dispatcher } from 'undici';
import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import { getLogger } from '../logger.ts';
import {
  ACP_AGENT_EDITOR_IDS,
  AcpRegistry,
  FEATURED_AGENT_IDS,
  loadCustomAgents,
  normalizeAgentDisplayName,
  registryPlatformKey,
} from './registry.ts';

const log = getLogger('acp-registry-test');

describe('per-agent tables', () => {
  test('features the same six agents in the same display order', () => {
    expect(FEATURED_AGENT_IDS).toEqual([
      'claude-acp',
      'codex-acp',
      'gemini',
      'cursor',
      'github-copilot-cli',
      'opencode',
    ]);
  });

  test('maps the same four agents to the editor wiring their harness loads', () => {
    expect(ACP_AGENT_EDITOR_IDS).toEqual({
      'claude-acp': 'claude',
      'codex-acp': 'codex',
      opencode: 'opencode',
      'pi-acp': 'pi',
    });
  });

  test('leaves cursor unmapped, so session setup keeps injecting for it', () => {
    expect(ACP_AGENT_EDITOR_IDS.cursor).toBeUndefined();
  });
});

const CATALOG = JSON.stringify({
  version: 1,
  agents: [
    {
      id: 'gemini',
      name: 'Gemini CLI',
      version: '1.0.0',
      license: 'Apache-2.0',
      distribution: { npx: { package: '@google/gemini-cli@1.0.0', args: ['--acp'] } },
    },
    { id: 'broken' },
  ],
});

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'acp-registry-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function startTunnelRecorder(): Promise<{ url: string; tunnelTargets: string[] }> {
  const tunnelTargets: string[] = [];
  const proxy = createServer();
  proxy.on('connect', (request, socket) => {
    tunnelTargets.push(request.url ?? '');
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
  return { url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, tunnelTargets };
}

async function catalogDispatcher(): Promise<Dispatcher | undefined> {
  const dispatchers: (Dispatcher | undefined)[] = [];
  await new AcpRegistry({
    localDir: tmp(),
    log,
    fetchImpl: async (_url, init?: RequestInit & { dispatcher?: Dispatcher }) => {
      dispatchers.push(init?.dispatcher);
      return new Response(CATALOG, { status: 200 });
    },
  }).getCatalog();
  expect(dispatchers).toHaveLength(1);
  return dispatchers[0];
}

async function expectTunnelledThrough(
  dispatcher: Dispatcher | undefined,
  proxy: { tunnelTargets: string[] },
): Promise<void> {
  expect(dispatcher).toBeDefined();
  const init = { dispatcher };
  await expect(fetch('https://127.0.0.1:65000/', init)).rejects.toThrow();
  expect(proxy.tunnelTargets).toEqual(['127.0.0.1:65000']);
}

function stubProxyEnv(proxyUrl: string): void {
  for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    vi.stubEnv(name, proxyUrl);
  }
  vi.stubEnv('NO_PROXY', '');
  vi.stubEnv('no_proxy', '');
  vi.stubEnv('NODE_USE_ENV_PROXY', undefined);
  onTestFinished(() => vi.unstubAllEnvs());
}

describe('AcpRegistry', () => {
  test('parses the catalog, drops malformed entries, writes the disk cache', async () => {
    const localDir = tmp();
    const registry = new AcpRegistry({
      localDir,
      log,
      fetchImpl: (async () => new Response(CATALOG, { status: 200 })) as typeof fetch,
    });
    const result = await registry.getCatalog();
    expect(result.stale).toBe(false);
    expect(result.agents.map((a) => a.id)).toEqual(['gemini']);
    const cached = await Bun.file(join(localDir, 'acp-registry-cache.json')).text();
    expect(cached).toBe(CATALOG);
  });

  test('serves the disk cache when the CDN is unreachable', async () => {
    const localDir = tmp();
    writeFileSync(join(localDir, 'acp-registry-cache.json'), CATALOG);
    const registry = new AcpRegistry({
      localDir,
      log,
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as typeof fetch,
    });
    const result = await registry.getCatalog();
    expect(result.stale).toBe(true);
    expect(result.agents[0]?.id).toBe('gemini');
  });

  test('throws when offline with no cache', async () => {
    const registry = new AcpRegistry({
      localDir: tmp(),
      log,
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as typeof fetch,
    });
    await expect(registry.getCatalog()).rejects.toThrow('offline');
  });
  test('dispatches the catalog request through the proxy the environment names', async () => {
    const proxy = await startTunnelRecorder();
    stubProxyEnv(proxy.url);

    await expectTunnelledThrough(await catalogDispatcher(), proxy);
  });

  test('an unusable http_proxy does not disable a usable HTTPS_PROXY', async () => {
    const proxy = await startTunnelRecorder();
    stubProxyEnv(proxy.url);
    vi.stubEnv('http_proxy', 'socks5://proxy.corp:1080');
    vi.stubEnv('HTTP_PROXY', 'socks5://proxy.corp:1080');

    await expectTunnelledThrough(await catalogDispatcher(), proxy);
  });

  test('treats a proxy value without a scheme as an http:// proxy', async () => {
    const proxy = await startTunnelRecorder();
    stubProxyEnv(proxy.url.replace('http://', ''));

    await expectTunnelledThrough(await catalogDispatcher(), proxy);
  });

  test('falls back to HTTP_PROXY when no HTTPS proxy is set', async () => {
    const proxy = await startTunnelRecorder();
    stubProxyEnv(proxy.url);
    for (const name of ['https_proxy', 'HTTPS_PROXY', 'http_proxy']) vi.stubEnv(name, undefined);

    await expectTunnelledThrough(await catalogDispatcher(), proxy);
  });

  test.each(['0', 'false'])(
    'NODE_USE_ENV_PROXY=%s keeps the catalog request off the proxy',
    async (mode) => {
      stubProxyEnv('http://127.0.0.1:9');
      vi.stubEnv('NODE_USE_ENV_PROXY', mode);

      expect(await catalogDispatcher()).toBeUndefined();
    },
  );

  test.each(['socks5://proxy.corp:1080', 'ftp://proxy.corp:21'])(
    'a proxy value %s leaves the catalog request direct and names the variable',
    async (value) => {
      stubProxyEnv(value);
      const warn = vi.spyOn(log, 'warn');
      onTestFinished(() => warn.mockRestore());
      const fetchImpl = vi.fn<typeof fetch>(async () => new Response(CATALOG, { status: 200 }));

      const result = await new AcpRegistry({ localDir: tmp(), log, fetchImpl }).getCatalog();

      expect(result).toMatchObject({ stale: false, agents: [{ id: 'gemini' }] });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ dispatcher: undefined });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[1]).toContain('https_proxy');
    },
  );

  test('an unusable proxy value is not written to the log', async () => {
    stubProxyEnv('http://user:s3cr#t@proxy.corp:3128');
    const warn = vi.spyOn(log, 'warn');
    onTestFinished(() => warn.mockRestore());

    await new AcpRegistry({
      localDir: tmp(),
      log,
      fetchImpl: async () => new Response(CATALOG),
    }).getCatalog();

    const logged = warn.mock.calls
      .map(
        ([data, message]) =>
          `${JSON.stringify(data, (_key, value) =>
            value instanceof Error ? stdSerializers.err(value) : value,
          )} ${message}`,
      )
      .join('\n');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(logged).toContain('https_proxy is not a usable proxy URL');
    expect(logged).not.toContain('s3cr');
  });
});

describe('normalizeAgentDisplayName', () => {
  test('title-cases a fully lowercase name', () => {
    expect(normalizeAgentDisplayName('cursor', 'cursor')).toBe('Cursor');
    expect(normalizeAgentDisplayName('qwen-code', 'qwen code')).toBe('Qwen Code');
  });

  test('keeps branded capitalization verbatim', () => {
    expect(normalizeAgentDisplayName('github-copilot-cli', 'GitHub Copilot')).toBe(
      'GitHub Copilot',
    );
    expect(normalizeAgentDisplayName('vtcode', 'VT Code')).toBe('VT Code');
    expect(normalizeAgentDisplayName('sigit', 'siGit Code')).toBe('siGit Code');
    expect(normalizeAgentDisplayName('pi-acp', 'pi ACP')).toBe('pi ACP');
  });

  test('leaves intentionally-lowercase brands alone', () => {
    expect(normalizeAgentDisplayName('goose', 'goose')).toBe('goose');
    expect(normalizeAgentDisplayName('fast-agent', 'fast-agent')).toBe('fast-agent');
    expect(normalizeAgentDisplayName('crow-cli', 'crow-cli')).toBe('crow-cli');
  });

  test('falls back to the id for an empty name', () => {
    expect(normalizeAgentDisplayName('cursor', '   ')).toBe('cursor');
  });

  test('applies at catalog ingest so every consumer sees one spelling', async () => {
    const payload = JSON.stringify({
      agents: [
        { id: 'cursor', name: 'cursor', version: '1.0.0', distribution: {} },
        { id: 'github-copilot-cli', name: 'GitHub Copilot', version: '1.0.0', distribution: {} },
        { id: 'goose', name: 'goose', version: '1.0.0', distribution: {} },
      ],
    });
    const registry = new AcpRegistry({
      localDir: tmp(),
      log,
      fetchImpl: (async () => new Response(payload, { status: 200 })) as typeof fetch,
    });
    const { agents } = await registry.getCatalog();
    expect(agents.map((a) => a.name)).toEqual(['Cursor', 'GitHub Copilot', 'goose']);
  });
});

describe('loadCustomAgents', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('returns valid entries, drops malformed ones, tolerates a missing file', async () => {
    const localDir = tmp();
    expect(await loadCustomAgents(localDir, log)).toEqual([]);
    writeFileSync(
      join(localDir, 'acp-agents.json'),
      JSON.stringify([
        { id: 'my-agent', name: 'Mine', command: 'node', args: ['agent.js'] },
        { id: 'bad id!', name: 'Nope', command: 'x' },
        { id: 'no-command', name: 'Nope' },
      ]),
    );
    const agents = await loadCustomAgents(localDir, log);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.id).toBe('my-agent');
  });

  test('a rejected entry is logged by index, id and reason, never with its env values', async () => {
    const localDir = tmp();
    const warn = vi.spyOn(log, 'warn');
    writeFileSync(
      join(localDir, 'acp-agents.json'),
      JSON.stringify([
        { id: 'bad id!', name: 'Nope', command: 'x', env: { OPENAI_API_KEY: 'sk-live-secret' } },
      ]),
    );
    expect(await loadCustomAgents(localDir, log)).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toEqual({
      index: 0,
      id: 'bad id!',
      problem: expect.stringContaining('id'),
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sk-live-secret');
  });

  test('each field rule rejects on its own and names itself as the reason', async () => {
    const localDir = tmp();
    const warn = vi.spyOn(log, 'warn');
    writeFileSync(
      join(localDir, 'acp-agents.json'),
      JSON.stringify([
        { id: 'bad-name', name: 5, command: 'x' },
        { id: 'bad-command', name: 'n', command: '' },
        { id: 'bad-args', name: 'n', command: 'x', args: ['a', 1] },
        { id: 'bad-env', name: 'n', command: 'x', env: { KEY: 1 } },
        { id: 'fine', name: 'n', command: 'x', args: ['a'], env: { KEY: 'v' } },
      ]),
    );
    const agents = await loadCustomAgents(localDir, log);
    expect(agents.map((a) => a.id)).toEqual(['fine']);
    expect(warn.mock.calls.map((call) => call[0])).toEqual([
      { index: 0, id: 'bad-name', problem: expect.stringContaining('name') },
      { index: 1, id: 'bad-command', problem: expect.stringContaining('command') },
      { index: 2, id: 'bad-args', problem: expect.stringContaining('args') },
      { index: 3, id: 'bad-env', problem: expect.stringContaining('env') },
    ]);
  });

  test('a parse failure is logged without any text from the file', async () => {
    const localDir = tmp();
    const warn = vi.spyOn(log, 'warn');
    writeFileSync(
      join(localDir, 'acp-agents.json'),
      '[{"id":"x","name":"x","command":"x","env":{"OPENAI_API_KEY":"sk-live-secret"} oops}]',
    );
    expect(await loadCustomAgents(localDir, log)).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toEqual({ error: 'SyntaxError', position: expect.any(Number) });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sk-live-secret');
  });

  test('a file whose top level is not an array is ignored with a warning, like invalid JSON', async () => {
    const localDir = tmp();
    const warn = vi.spyOn(log, 'warn');
    writeFileSync(
      join(localDir, 'acp-agents.json'),
      JSON.stringify({ id: 'solo', name: 'Solo', command: 'solo' }),
    );
    expect(await loadCustomAgents(localDir, log)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('JSON array'));
    warn.mockClear();
    writeFileSync(join(localDir, 'acp-agents.json'), '{not json');
    expect(await loadCustomAgents(localDir, log)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('not valid JSON'));
  });
});

describe('registryPlatformKey', () => {
  test('returns a supported key on this host', () => {
    expect(registryPlatformKey()).toMatch(/^(darwin|linux|windows)-(aarch64|x86_64)$/);
  });
});
