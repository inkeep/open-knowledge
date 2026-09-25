import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { OK_HOSTED_AGENT_ENV } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test } from 'vitest';
import type { AgentSessionManager } from '../agent-sessions.ts';
import { resolveOnPath } from '../git-preflight.ts';
import { getLogger } from '../logger.ts';
import { MCP_HOSTED_AGENT_HEADER } from '../mcp/agent-identity.ts';
import { resolveBrowserNpx } from './browser-mcp.ts';
import { agentSpawnPath } from './launch.ts';
import { AcpPermissionStore, readAgentBrowserTools } from './permissions.ts';
import { AcpRegistry } from './registry.ts';
import {
  AcpThreadManager,
  type AcpThreadManagerOptions,
  type HarnessManagedMcpEntryHit,
  type OkMcpHostedMarker,
} from './thread-manager.ts';

const log = getLogger('acp-injection-skip-test');

const fakeSessionManager = {
  getSession: async () => {
    throw new Error('not used');
  },
  closeAllForAgent: async () => {},
} as unknown as AgentSessionManager;

let dirs: string[] = [];
let managers: AcpThreadManager[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'acp-injection-skip-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.allSettled(managers.map((m) => m.destroy()));
  managers = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

type BuildMcpServersSeam = {
  buildMcpServers: (
    record: {
      agentRef: { source: 'registry' | 'custom'; id: string };
      cwd: string;
      info: { threadId: string };
    },
    init: { agentCapabilities?: { mcpCapabilities?: { http?: boolean } } },
  ) => Promise<{
    servers: Array<{
      name: string;
      type?: string;
      env?: Array<{ name: string; value: string }>;
      headers?: Array<{ name: string; value: string }>;
    }>;
    hostedMarker: OkMcpHostedMarker;
    browserUnavailable: 'no-node' | 'failed' | null;
  }>;
};

function makeManager(
  probe?: AcpThreadManagerOptions['probeHarnessManagedMcpEntry'],
  stdio: AcpThreadManagerOptions['getMcpStdioCommand'] = () => ({
    command: 'open-knowledge',
    args: ['mcp', '--port', '4242'],
  }),
  pi?: {
    probePiAcpBridge?: AcpThreadManagerOptions['probePiAcpBridge'];
    ensurePiAcpBridge?: AcpThreadManagerOptions['ensurePiAcpBridge'];
  },
  browser?: {
    enabled: AcpThreadManagerOptions['agentBrowserTools'];
    resolveNpx?: AcpThreadManagerOptions['resolveBrowserNpx'];
    localDir?: string;
    globalDir?: string | null;
  },
): BuildMcpServersSeam {
  const localDir = browser?.localDir ?? tmp();
  const globalDir =
    browser === undefined ? null : browser.globalDir === undefined ? tmp() : browser.globalDir;
  const manager = new AcpThreadManager({
    ...pi,
    contentDir: tmp(),
    localDir,
    globalDir,
    registry: new AcpRegistry({
      localDir,
      log,
      fetchImpl: (async () => {
        throw new Error('offline test');
      }) as typeof fetch,
    }),
    permissions: new AcpPermissionStore(localDir, log),
    sessionManager: fakeSessionManager,
    isExcludedPath: () => false,
    isIgnoredPath: () => false,
    getServerUrl: () => 'http://127.0.0.1:4242',
    getMcpStdioCommand: stdio,
    probeHarnessManagedMcpEntry: probe,
    agentBrowserTools: browser?.enabled,
    resolveBrowserNpx: browser?.resolveNpx,
    log,
    resolveLoginShellPath: async () => null,
  });
  managers.push(manager);
  return manager as unknown as BuildMcpServersSeam;
}

const THREAD_ID = '6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f';

const PROJECT = '/tmp/acp-injection-skip-project';

const record = (source: 'registry' | 'custom', id: string) => ({
  agentRef: { source, id },
  cwd: PROJECT,
  info: { threadId: THREAD_ID },
});

const HTTP_INIT = { agentCapabilities: { mcpCapabilities: { http: true } } };

const hit: HarnessManagedMcpEntryHit = {
  editorId: 'codex',
  scope: 'project',
  configPath: '/tmp/acp-injection-skip-project/.codex/config.toml',
};

describe('buildMcpServers × probeHarnessManagedMcpEntry', () => {
  test('skips injection entirely on a probe hit (http-capable and stdio agents)', async () => {
    const m = makeManager(() => hit);
    expect((await m.buildMcpServers(record('registry', 'codex-acp'), HTTP_INIT)).servers).toEqual(
      [],
    );
    expect((await m.buildMcpServers(record('registry', 'claude-acp'), {})).servers).toEqual([]);
  });

  test('injects on a probe miss', async () => {
    const m = makeManager(() => null);
    const { servers } = await m.buildMcpServers(record('registry', 'codex-acp'), HTTP_INIT);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: 'open-knowledge', type: 'http' });
  });

  test('the injected HTTP server carries the hosted-agent header', async () => {
    const m = makeManager(() => null);
    const { servers, hostedMarker } = await m.buildMcpServers(
      record('registry', 'codex-acp'),
      HTTP_INIT,
    );
    expect(servers[0]).toMatchObject({
      type: 'http',
      headers: [{ name: MCP_HOSTED_AGENT_HEADER, value: '1' }],
    });
    expect(hostedMarker).toBe('http-header');
  });

  test('the injected stdio server carries the hosted-agent marker and PATH', async () => {
    const m = makeManager(() => null);
    const { servers, hostedMarker } = await m.buildMcpServers(record('registry', 'claude-acp'), {});
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: 'open-knowledge' });
    const env = (servers[0] as { env: Array<{ name: string; value: string }> }).env;
    expect(env).toContainEqual({ name: OK_HOSTED_AGENT_ENV, value: '1' });
    expect(hostedMarker).toBe('stdio-entry-env');
  });

  test('the injected stdio PATH is the agent spawn PATH, not the server process PATH', async () => {
    const m = makeManager(() => null);
    const { servers } = await m.buildMcpServers(record('registry', 'claude-acp'), {});
    const env = (servers[0] as { env: Array<{ name: string; value: string }> }).env;
    const declared = env.find((e) => e.name === 'PATH')?.value;
    expect(declared).toBe(agentSpawnPath());
    const declaredDirs = new Set((declared ?? '').split(delimiter));
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      if (dir !== '') expect(declaredDirs.has(dir)).toBe(true);
    }
  });

  test('never probes for custom agents or registry agents without an OK config surface', async () => {
    let calls = 0;
    const m = makeManager(() => {
      calls += 1;
      return hit;
    });
    expect((await m.buildMcpServers(record('custom', 'my-agent'), HTTP_INIT)).servers).toHaveLength(
      1,
    );
    expect((await m.buildMcpServers(record('registry', 'gemini'), HTTP_INIT)).servers).toHaveLength(
      1,
    );
    expect(calls).toBe(0);
  });

  test('always injects for Cursor, even when its config carries OK’s entry', async () => {
    let calls = 0;
    const m = makeManager(() => {
      calls += 1;
      return { ...hit, editorId: 'cursor' as const };
    });
    const { servers, hostedMarker } = await m.buildMcpServers(record('registry', 'cursor'), {
      agentCapabilities: { mcpCapabilities: { http: true } },
    });
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: 'open-knowledge', type: 'http' });
    expect(hostedMarker).toBe('http-header');
    expect(calls).toBe(0);
  });

  test('fail-open: a throwing probe still injects', async () => {
    const m = makeManager(() => {
      throw new Error('probe exploded');
    });
    const { servers } = await m.buildMcpServers(record('registry', 'claude-acp'), {});
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: 'open-knowledge', command: 'open-knowledge' });
  });

  test('unwired seam keeps unconditional injection', async () => {
    const m = makeManager(undefined);
    expect((await m.buildMcpServers(record('registry', 'codex-acp'), HTTP_INIT)).servers).toEqual([
      expect.objectContaining({ name: 'open-knowledge' }),
    ]);
  });
});

describe('buildMcpServers hosted-marker outcomes', () => {
  test('a skip-branch thread reports `unknown`, not a false negative', async () => {
    const m = makeManager(() => hit);
    expect((await m.buildMcpServers(record('registry', 'codex-acp'), HTTP_INIT)).hostedMarker).toBe(
      'unknown',
    );
    expect((await m.buildMcpServers(record('registry', 'claude-acp'), {})).hostedMarker).toBe(
      'unknown',
    );
  });

  test('an agent with no usable transport reports `none` and gets no servers', async () => {
    const m = makeManager(
      () => null,
      () => null,
    );
    const { servers, hostedMarker } = await m.buildMcpServers(record('registry', 'claude-acp'), {});
    expect(servers).toEqual([]);
    expect(hostedMarker).toBe('none');
  });
});

describe.skipIf(process.platform === 'win32')('buildMcpServers × agentBrowserTools', () => {
  const fakeNpx = () => {
    const dir = tmp();
    writeFileSync(join(dir, 'npx'), '');
    writeFileSync(join(dir, 'node'), '');
    return { npx: join(dir, 'npx'), path: dir };
  };
  const names = async (m: BuildMcpServersSeam, id: string, init = HTTP_INIT) =>
    (await m.buildMcpServers(record('registry', id), init)).servers.map((s) => s.name);
  const unavailable = async (m: BuildMcpServersSeam, id = 'claude-acp') =>
    (await m.buildMcpServers(record('registry', id), HTTP_INIT)).browserUnavailable;

  test('adds the browser after OK tools, relayed through the node beside the resolved npx, from its own folder', async () => {
    const localDir = tmp();
    const globalDir = tmp();
    const npx = fakeNpx();
    const seen: Array<readonly (string | null | undefined)[]> = [];
    const m = makeManager(undefined, undefined, undefined, {
      enabled: () => true,
      resolveNpx: (candidates) => {
        seen.push(candidates);
        return npx;
      },
      localDir,
      globalDir,
    });
    const { servers } = await m.buildMcpServers(record('registry', 'claude-acp'), {});
    expect(servers.map((s) => s.name)).toEqual(['open-knowledge', 'ok-browser']);
    const browser = servers[1] as { command?: string; args?: string[]; env?: unknown };
    expect(browser.command).toBe(join(npx.path, 'node'));
    const chat = join(globalDir, 'agent-browser', THREAD_ID);
    expect(browser.args?.slice(2, 7)).toEqual([
      join(chat, 'npm'),
      join(chat, 'files'),
      npx.npx,
      '--prefix',
      join(chat, 'npm'),
    ]);
    expect(browser.args).toContain('--no-webmcp');
    expect(browser.args?.join(' ')).toContain(`--output-dir ${join(chat, 'files')}`);
    expect(browser.args?.join(' ')).not.toContain(localDir);
    expect(browser.env).toEqual([{ name: 'PATH', value: npx.path }]);
    expect(seen[0]?.at(-1)).toBe(agentSpawnPath());
  });

  test('the injected npx resolves on the PATH it is handed', async () => {
    const npx = resolveOnPath('npx', agentSpawnPath());
    if (npx === null) return;
    const m = makeManager(undefined, undefined, undefined, { enabled: () => true });
    const { servers } = await m.buildMcpServers(record('registry', 'claude-acp'), HTTP_INIT);
    const browser = servers.find((s) => s.name === 'ok-browser') as
      | { args: string[]; env: Array<{ name: string; value: string }> }
      | undefined;
    const path = browser?.env.find((e) => e.name === 'PATH')?.value;
    expect(browser?.args[4]).toBe(resolveOnPath('npx', path));
  });

  test('adds the browser even when the harness already loads OK tools', async () => {
    const npx = fakeNpx();
    const m = makeManager(() => hit, undefined, undefined, {
      enabled: () => true,
      resolveNpx: () => npx,
    });
    expect(await names(m, 'codex-acp')).toEqual(['ok-browser']);
  });

  test('leaves the browser out when it is off, unset, npx is missing, or there is no per-user folder', async () => {
    const npx = fakeNpx();
    const off = makeManager(undefined, undefined, undefined, {
      enabled: () => false,
      resolveNpx: () => npx,
    });
    const noNpx = makeManager(undefined, undefined, undefined, {
      enabled: () => true,
      resolveNpx: () => null,
    });
    const noGlobalDir = makeManager(undefined, undefined, undefined, {
      enabled: () => true,
      resolveNpx: () => npx,
      globalDir: null,
    });
    expect(await names(off, 'claude-acp')).toEqual(['open-knowledge']);
    expect(await names(makeManager(), 'claude-acp')).toEqual(['open-knowledge']);
    expect(await names(noNpx, 'claude-acp')).toEqual(['open-knowledge']);
    expect(await names(noGlobalDir, 'claude-acp')).toEqual(['open-knowledge']);
    expect(await unavailable(off)).toBeNull();
    expect(await unavailable(makeManager())).toBeNull();
    expect(await unavailable(noNpx)).toBe('no-node');
    expect(await unavailable(noGlobalDir)).toBe('failed');
  });

  test('gives the browser only to Claude Code and Codex chats, whose adapters name the tool each call runs', async () => {
    const npx = fakeNpx();
    const on = makeManager(undefined, undefined, undefined, {
      enabled: () => true,
      resolveNpx: () => npx,
    });
    expect(await names(on, 'claude-acp')).toEqual(['open-knowledge', 'ok-browser']);
    expect(await names(on, 'codex-acp')).toEqual(['open-knowledge', 'ok-browser']);
    for (const id of ['gemini', 'cursor', 'opencode', 'github-copilot-cli']) {
      expect(await names(on, id)).toEqual(['open-knowledge']);
    }
    expect(await names(on, 'pi-acp')).toEqual([]);
    const custom = await on.buildMcpServers(record('custom', 'claude-acp'), HTTP_INIT);
    expect(custom.servers.map((s) => s.name)).toEqual(['open-knowledge']);
  });

  test('refuses an npx inside the project, or one with no node beside it, and tries the next PATH', async () => {
    const tried: string[] = [];
    const bare = tmp();
    const safe = fakeNpx();
    const m = makeManager(undefined, undefined, undefined, {
      enabled: () => true,
      resolveNpx: (_candidates, _resolveCommand, accept) =>
        resolveBrowserNpx(
          [join(PROJECT, 'node_modules', '.bin'), bare, safe.path],
          (name, path) => {
            tried.push(path);
            return join(path, name);
          },
          accept,
        ),
    });
    const { servers } = await m.buildMcpServers(record('registry', 'claude-acp'), HTTP_INIT);
    const browser = servers.find((s) => s.name === 'ok-browser') as { args?: string[] } | undefined;
    expect(browser?.args?.[4]).toBe(safe.npx);
    expect(tried).toEqual([join(PROJECT, 'node_modules', '.bin'), bare, safe.path]);

    const onlyProject = makeManager(undefined, undefined, undefined, {
      enabled: () => true,
      resolveNpx: (_candidates, _resolveCommand, accept) =>
        resolveBrowserNpx([join(PROJECT, 'bin')], (name, path) => join(path, name), accept),
    });
    expect(await names(onlyProject, 'claude-acp')).toEqual(['open-knowledge']);
    expect(await unavailable(onlyProject)).toBe('no-node');
    expect(await unavailable(m)).toBeNull();
  });

  test('a failure preparing the browser still starts the chat with OK tools', async () => {
    const globalDir = tmp();
    writeFileSync(join(globalDir, 'agent-browser'), 'not a folder');
    const npx = fakeNpx();
    const m = makeManager(undefined, undefined, undefined, {
      enabled: () => true,
      resolveNpx: () => npx,
      globalDir,
    });
    expect(await names(m, 'claude-acp')).toEqual(['open-knowledge']);
    expect(await unavailable(m)).toBe('failed');
  });

  test('follows agents.browserTools in the user config file', async () => {
    const home = tmp();
    const projectDir = tmp();
    const npx = fakeNpx();
    const m = makeManager(undefined, undefined, undefined, {
      enabled: () => readAgentBrowserTools(projectDir, home),
      resolveNpx: () => npx,
    });
    expect(await names(m, 'claude-acp')).toEqual(['open-knowledge']);
    mkdirSync(join(home, '.ok'), { recursive: true });
    writeFileSync(join(home, '.ok', 'global.yml'), 'agents:\n  browserTools: true\n');
    expect(await names(m, 'claude-acp')).toEqual(['open-knowledge', 'ok-browser']);
    writeFileSync(join(home, '.ok', 'global.yml'), 'agents:\n  browserTools: false\n');
    expect(await names(m, 'claude-acp')).toEqual(['open-knowledge']);
  });
});

describe('buildMcpServers × pi-acp', () => {
  const PI_LOADABLE = {
    project: 'ready' as const,
    cwd: '/tmp/acp-injection-skip-project',
    canonicalCwd: '/tmp/acp-injection-skip-project',
    bridgePath: '/tmp/acp-injection-skip-project/.pi/extensions/open-knowledge.ts',
    trustPath: '/tmp/acp-injection-skip-home/.pi/agent/trust.json',
    bridge: 'own-current' as const,
    trust: 'trusted' as const,
    bridgeLoadable: true,
    otherExtensions: [],
  };

  test('never injects for pi, even with an http-capable init and a working stdio command', async () => {
    const m = makeManager(() => null, undefined, { probePiAcpBridge: () => PI_LOADABLE });
    expect((await m.buildMcpServers(record('registry', 'pi-acp'), HTTP_INIT)).servers).toEqual([]);
    expect((await m.buildMcpServers(record('registry', 'pi-acp'), {})).servers).toEqual([]);
  });

  test('a loadable bridge reports `unknown` — the bridge spawns the server, not us', async () => {
    const m = makeManager(() => null, undefined, { probePiAcpBridge: () => PI_LOADABLE });
    expect((await m.buildMcpServers(record('registry', 'pi-acp'), HTTP_INIT)).hostedMarker).toBe(
      'unknown',
    );
  });

  test('unwired seams suppress injection and report `unknown`, not `none`', async () => {
    const m = makeManager(() => null);
    const { servers, hostedMarker } = await m.buildMcpServers(
      record('registry', 'pi-acp'),
      HTTP_INIT,
    );
    expect(servers).toEqual([]);
    expect(hostedMarker).toBe('unknown');
  });

  test('a throwing probe degrades to `unknown` rather than failing session setup', async () => {
    const m = makeManager(() => null, undefined, {
      probePiAcpBridge: () => {
        throw new Error('probe exploded');
      },
    });
    expect((await m.buildMcpServers(record('registry', 'pi-acp'), HTTP_INIT)).hostedMarker).toBe(
      'unknown',
    );
  });

  test('an unprovisioned bridge with no ensure seam reports `none` without prompting', async () => {
    const m = makeManager(() => null, undefined, {
      probePiAcpBridge: () => ({
        ...PI_LOADABLE,
        bridge: 'absent',
        trust: 'untrusted',
        bridgeLoadable: false,
      }),
    });
    const { servers, hostedMarker } = await m.buildMcpServers(
      record('registry', 'pi-acp'),
      HTTP_INIT,
    );
    expect(servers).toEqual([]);
    expect(hostedMarker).toBe('none');
  });

  test('a custom agent named like the registry entry still gets normal injection', async () => {
    const m = makeManager(() => null, undefined, { probePiAcpBridge: () => PI_LOADABLE });
    const { servers } = await m.buildMcpServers(record('custom', 'pi-acp'), HTTP_INIT);
    expect(servers).toHaveLength(1);
  });
});
