/**
 * `buildMcpServers` duplicate-injection guard: when the
 * `probeHarnessManagedMcpEntry` seam reports that the agent's own harness
 * already loads OK's managed editor-config entry, session setup injects NO
 * `open-knowledge` server; every other outcome (miss, unmapped agent, custom
 * agent, probe throw, unwired seam) keeps the existing injection.
 */

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
    // Hermetic by default: every launch now merges the login shell's PATH, and
    // a test must not spawn the developer's own shell to find out what it is.
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

  // The env marker cannot travel over HTTP, so the hosted-agent fact rides a
  // header. Without it an HTTP-capable panel agent reaches `preview_url` on
  // the shared server, where the steer can't be computed, and gets the bare
  // URL this whole change exists to suppress.
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

  // On this branch we name the command, so the marker can be guaranteed
  // rather than left to inheritance through the agent process. PATH rides on
  // the entry too — env-sanitizing harnesses may hand the child none, and an
  // env-shim command then can't find node.
  test('the injected stdio server carries the hosted-agent marker and PATH', async () => {
    const m = makeManager(() => null);
    const { servers, hostedMarker } = await m.buildMcpServers(record('registry', 'claude-acp'), {});
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: 'open-knowledge' });
    const env = (servers[0] as { env: Array<{ name: string; value: string }> }).env;
    expect(env).toContainEqual({ name: OK_HOSTED_AGENT_ENV, value: '1' });
    expect(hostedMarker).toBe('stdio-entry-env');
  });

  // Adapters that deliver entry env spread it LAST over the child's inherited
  // env, so a declared PATH REPLACES rather than supplements — pinning it to
  // the server's own would narrow the MCP child under a Dock-launched Desktop,
  // whose server runs on launchd's minimal PATH while the agent gets the
  // repaired one. The bar is "never narrower than the agent's", so the entry
  // has to carry the agent spawn PATH verbatim.
  test('the injected stdio PATH is the agent spawn PATH, not the server process PATH', async () => {
    const m = makeManager(() => null);
    const { servers } = await m.buildMcpServers(record('registry', 'claude-acp'), {});
    const env = (servers[0] as { env: Array<{ name: string; value: string }> }).env;
    const declared = env.find((e) => e.name === 'PATH')?.value;
    expect(declared).toBe(agentSpawnPath());
    // …and the agent PATH is append-only over the inherited one, so every
    // entry the server itself can see survives into the child.
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

  // Cursor keeps its OK config entry behind an approval step whose state we
  // can't read, so a present entry is no evidence the agent will have the
  // tools. Standing down there produced silent zero-tool sessions.
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

/**
 * The marker is deterministic only on the entries OK writes. A skip-branch
 * connection is reported `unknown` rather than silently defaulting to "not
 * hosted": the harness spawns OK's managed entry itself, and the marker cannot
 * be stamped into that config because the user's ordinary non-hosted use of the
 * editor loads the very same entry.
 */
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

/**
 * Pi accepts the `mcpServers` array and silently drops it — it has no MCP
 * client — so injection is suppressed unconditionally for it, seams or no
 * seams. Its tools ride OK's managed bridge extension in the project instead;
 * the consent flow that provisions one lives in the Pi bridge suite (it needs
 * a real thread record to append events to).
 */
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

  // The dev server wires neither seam. OK cannot see the bridge, so it must
  // not claim the thread has no tools — `ok init` may well have wired the
  // project — and it must not prompt for a write it has no way to make.
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

  // Prompting for consent OK cannot act on is worse than staying quiet, so a
  // probe-only wiring reports the honest "no tools" and never asks.
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

  // The registry map is the one place the pairing is stated: a custom agent
  // that happens to be called `pi-acp` is not Pi.
  test('a custom agent named like the registry entry still gets normal injection', async () => {
    const m = makeManager(() => null, undefined, { probePiAcpBridge: () => PI_LOADABLE });
    const { servers } = await m.buildMcpServers(record('custom', 'pi-acp'), HTTP_INIT);
    expect(servers).toHaveLength(1);
  });
});
