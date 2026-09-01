import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { OK_HOSTED_AGENT_ENV } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test } from 'vitest';
import type { AgentSessionManager } from '../agent-sessions.ts';
import { getLogger } from '../logger.ts';
import { MCP_HOSTED_AGENT_HEADER } from '../mcp/agent-identity.ts';
import { agentSpawnPath } from './launch.ts';
import { AcpPermissionStore } from './permissions.ts';
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
): BuildMcpServersSeam {
  const localDir = tmp();
  const manager = new AcpThreadManager({
    ...pi,
    contentDir: tmp(),
    localDir,
    globalDir: null,
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
    log,
    resolveLoginShellPath: async () => null,
  });
  managers.push(manager);
  return manager as unknown as BuildMcpServersSeam;
}

const record = (source: 'registry' | 'custom', id: string) => ({
  agentRef: { source, id },
  cwd: '/tmp/acp-injection-skip-project',
  info: { threadId: 'thread-1' },
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

describe('buildMcpServers × pi-acp', () => {
  const PI_LOADABLE = {
    bridgePath: '/tmp/acp-injection-skip-project/.pi/extensions/open-knowledge.ts',
    bridge: 'own-current' as const,
    trust: 'trusted' as const,
    bridgeLoadable: true,
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
        bridgePath: PI_LOADABLE.bridgePath,
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
