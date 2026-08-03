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
import { OK_HOSTED_AGENT_ENV } from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test } from 'vitest';
import type { AgentSessionManager } from '../agent-sessions.ts';
import { getLogger } from '../logger.ts';
import { MCP_HOSTED_AGENT_HEADER } from '../mcp/agent-identity.ts';
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
  ) => Promise<
    Array<{
      name: string;
      type?: string;
      env?: Array<{ name: string; value: string }>;
      headers?: Array<{ name: string; value: string }>;
    }>
  >;
};

function makeManager(
  probe?: AcpThreadManagerOptions['probeHarnessManagedMcpEntry'],
): BuildMcpServersSeam {
  const localDir = tmp();
  const manager = new AcpThreadManager({
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

  // The env marker cannot travel over HTTP, so the hosted-agent fact rides a
  // header. Without it an HTTP-capable panel agent reaches `preview_url` on
  // the shared server, where the steer can't be computed, and gets the bare
  // URL this whole change exists to suppress.
  test('the injected HTTP server carries the hosted-agent header', async () => {
    const m = makeManager(() => null);
    const servers = await m.buildMcpServers(record('registry', 'codex-acp'), HTTP_INIT);
    expect(servers[0]).toMatchObject({
      type: 'http',
      headers: [{ name: MCP_HOSTED_AGENT_HEADER, value: '1' }],
    });
  });

  // On this branch we name the command, so the marker can be guaranteed
  // rather than left to inheritance through the agent process.
  test('the injected stdio server carries the hosted-agent marker', async () => {
    const m = makeManager(() => null);
    const servers = await m.buildMcpServers(record('registry', 'claude-acp'), {});
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      name: 'open-knowledge',
      env: [{ name: OK_HOSTED_AGENT_ENV, value: '1' }],
    });
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
