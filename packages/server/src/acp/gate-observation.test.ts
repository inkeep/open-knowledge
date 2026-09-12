import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMPTY_DETECTION_SNAPSHOT,
  EMPTY_PROBE_SNAPSHOT,
  type HostSnapshot,
} from '@inkeep/open-knowledge-core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AgentSessionManager } from '../agent-sessions.ts';
import { getLogger, type PinoLogger } from '../logger.ts';
import { AcpPermissionStore } from './permissions.ts';
import { AcpRegistry } from './registry.ts';
import { AcpThreadManager, type AcpThreadManagerOptions } from './thread-manager.ts';

const baseLog = getLogger('acp-gate-observation-test');

const fakeSessionManager = {
  getSession: async () => {
    throw new Error('not used');
  },
  closeAllForAgent: async () => {},
} as unknown as AgentSessionManager;

const CATALOG = JSON.stringify({
  agents: [
    { id: 'claude-acp', name: 'Claude Code', version: '1.0.0', distribution: { binary: {} } },
    { id: 'auggie', name: 'Auggie', version: '1.0.0', distribution: { binary: {} } },
  ],
});

let dirs: string[] = [];
let managers: AcpThreadManager[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'acp-gate-observation-'));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  await Promise.allSettled(managers.map((m) => m.destroy()));
  managers = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const EMPTY_SNAPSHOT: HostSnapshot = {
  probes: EMPTY_PROBE_SNAPSHOT,
  detection: EMPTY_DETECTION_SNAPSHOT,
};

function makeManager(extra?: Partial<AcpThreadManagerOptions>): {
  manager: AcpThreadManager;
  localDir: string;
  info: ReturnType<typeof vi.fn>;
} {
  const localDir = tmp();
  const info = vi.fn();
  const log = {
    info,
    warn: baseLog.warn.bind(baseLog),
    error: baseLog.error.bind(baseLog),
    debug: baseLog.debug.bind(baseLog),
  } as unknown as PinoLogger;

  const manager = new AcpThreadManager({
    contentDir: tmp(),
    localDir,
    globalDir: null,
    registry: new AcpRegistry({
      localDir,
      log: baseLog,
      fetchImpl: (async () => new Response(CATALOG, { status: 200 })) as typeof fetch,
    }),
    permissions: new AcpPermissionStore(localDir, baseLog),
    sessionManager: fakeSessionManager,
    isExcludedPath: () => false,
    isIgnoredPath: () => false,
    hostSnapshot: async () => EMPTY_SNAPSHOT,
    log,
    resolveLoginShellPath: async () => null,
    ...extra,
  });
  managers.push(manager);
  return { manager, localDir, info };
}

function verdicts(info: ReturnType<typeof vi.fn>): Array<Record<string, unknown>> {
  return info.mock.calls
    .filter((call) => call[1] === '[agent-gate] readiness')
    .map((call) => call[0] as Record<string, unknown>);
}

describe('ACP thread create — readiness observation', () => {
  test('records the verdict under the registry id, not the catalog id', async () => {
    const { manager, info } = makeManager();

    const thread = await manager.createThread({ agent: { source: 'registry', id: 'claude-acp' } });

    expect(thread.threadId).toBeTruthy();
    expect(verdicts(info)).toEqual([
      expect.objectContaining({
        site: 'acp-thread',
        mode: 'acp',
        agent: 'claude',
        registered: true,
      }),
    ]);
  });

  test('carries the skill requirement alongside the verdict', async () => {
    const { manager, info } = makeManager();

    await manager.createThread({ agent: { source: 'registry', id: 'claude-acp' } });

    const [fields] = verdicts(info);
    expect(fields?.skill).toBeDefined();
    expect(fields?.mcp).toBeDefined();
    expect(fields?.verdict).toBeDefined();
  });

  test('creates the thread for a long-tail agent and files it as unregistered', async () => {
    const { manager, info } = makeManager();

    const thread = await manager.createThread({ agent: { source: 'registry', id: 'auggie' } });

    expect(thread.threadId).toBeTruthy();
    expect(thread.agent.id).toBe('auggie');
    expect(verdicts(info)).toEqual([
      expect.objectContaining({ verdict: 'not-registered', agent: null, registered: false }),
    ]);
  });

  test('never puts a user-authored custom agent id in the log', async () => {
    const { manager, localDir, info } = makeManager();
    writeFileSync(
      join(localDir, 'acp-agents.json'),
      JSON.stringify([
        { id: 'claude-acp', name: 'My Private Fork', command: '/nonexistent/agent-binary' },
      ]),
    );

    const thread = await manager.createThread({ agent: { source: 'custom', id: 'claude-acp' } });

    expect(thread.threadId).toBeTruthy();
    expect(verdicts(info)).toEqual([
      expect.objectContaining({ verdict: 'not-registered', agent: null }),
    ]);
  });

  test('creates the thread when no host snapshot is wired at all', async () => {
    const { manager, info } = makeManager({ hostSnapshot: undefined });

    const thread = await manager.createThread({ agent: { source: 'registry', id: 'claude-acp' } });

    expect(thread.threadId).toBeTruthy();
    expect(verdicts(info)).toHaveLength(1);
  });

  test('creates the thread when the host snapshot throws', async () => {
    const { manager, info } = makeManager({
      hostSnapshot: async () => {
        throw new Error('probe blew up');
      },
    });

    const thread = await manager.createThread({ agent: { source: 'registry', id: 'claude-acp' } });

    expect(thread.threadId).toBeTruthy();
    expect(verdicts(info)).toHaveLength(0);
  });

  test('leaves the unknown-agent rejection exactly as it was', async () => {
    const { manager, info } = makeManager();

    await expect(
      manager.createThread({ agent: { source: 'registry', id: 'not-in-any-catalog' } }),
    ).rejects.toThrow(/not in the registry/);
    expect(verdicts(info)).toHaveLength(0);
  });
});
