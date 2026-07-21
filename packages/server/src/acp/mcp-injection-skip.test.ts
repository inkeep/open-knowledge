/**
 * `buildMcpServers` duplicate-injection guard: when the
 * `probeHarnessManagedMcpEntry` seam reports that the agent's own harness
 * already loads OK's managed editor-config entry, session setup injects NO
 * `open-knowledge` server; every other outcome (miss, unmapped agent, custom
 * agent, probe throw, unwired seam) keeps the existing injection.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { AgentSessionManager } from '../agent-sessions.ts';
import { getLogger } from '../logger.ts';
import { AcpPermissionStore } from './permissions.ts';
import { AcpRegistry } from './registry.ts';
import {
  AcpThreadManager,
  type AcpThreadManagerOptions,
  type HarnessManagedMcpEntryHit,
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
  ) => Promise<Array<{ name: string; type?: string }>>;
};

function makeManager(
  probe?: AcpThreadManagerOptions['probeHarnessManagedMcpEntry'],
): BuildMcpServersSeam {
  const localDir = tmp();
  const manager = new AcpThreadManager({
    contentDir: tmp(),
    localDir,
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
    getMcpStdioCommand: () => ({ command: 'open-knowledge', args: ['mcp', '--port', '4242'] }),
    probeHarnessManagedMcpEntry: probe,
    log,
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
    expect(await m.buildMcpServers(record('registry', 'codex-acp'), HTTP_INIT)).toEqual([]);
    expect(await m.buildMcpServers(record('registry', 'claude-acp'), {})).toEqual([]);
  });

  test('injects on a probe miss', async () => {
    const m = makeManager(() => null);
    const servers = await m.buildMcpServers(record('registry', 'codex-acp'), HTTP_INIT);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: 'open-knowledge', type: 'http' });
  });

  test('never probes for custom agents or registry agents without an OK config surface', async () => {
    let calls = 0;
    const m = makeManager(() => {
      calls += 1;
      return hit;
    });
    expect(await m.buildMcpServers(record('custom', 'my-agent'), HTTP_INIT)).toHaveLength(1);
    expect(await m.buildMcpServers(record('registry', 'gemini'), HTTP_INIT)).toHaveLength(1);
    expect(calls).toBe(0);
  });

  test('fail-open: a throwing probe still injects', async () => {
    const m = makeManager(() => {
      throw new Error('probe exploded');
    });
    const servers = await m.buildMcpServers(record('registry', 'claude-acp'), {});
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({ name: 'open-knowledge', command: 'open-knowledge' });
  });

  test('unwired seam keeps unconditional injection', async () => {
    const m = makeManager(undefined);
    expect(await m.buildMcpServers(record('registry', 'codex-acp'), HTTP_INIT)).toHaveLength(1);
  });
});
