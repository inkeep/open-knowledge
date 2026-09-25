import type { ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ACP_LAUNCH_FAILURE_LOG } from '@inkeep/open-knowledge-core';
import type {
  ThreadEvent,
  ThreadInfo,
  ThreadServerFrame,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { THREAD_REOPEN_OP_TIMEOUT_MS } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as Y from 'yjs';
import codexFixture from '../../../../test-support/fixtures/codex-legacy-warning-envelopes.json' with {
  type: 'json',
};
import type { AgentPresenceBroadcaster } from '../agent-presence.ts';
import type { AgentSessionManager } from '../agent-sessions.ts';
import { resolveBundledSkillDir } from '../build-skill-zip.ts';
import { getLogger, type PinoLogger } from '../logger.ts';
import { isValidLockPid } from '../process-alive.ts';
import { RUNTIME_VERSION } from '../version-constants.ts';
import { withLocalAcquisitionRegistry } from './acquisition-contract.test-helper.ts';
import { isWithin } from './archive.ts';
import {
  installNodeFixture,
  npmCli,
  probedDescriptors,
  registryPackage,
  withAcquisitionHome,
  writeExecutable,
  writeRecordingNpm,
} from './package-acquisition.test-helper.ts';
import { AcpPermissionStore, readAutoApproveOkTools } from './permissions.ts';
import * as projectSkillStaging from './project-skill-staging.ts';
import { PROJECT_SKILL_ENTRY, projectSkillStageDir } from './project-skill-staging.ts';
import { AcpRegistry } from './registry.ts';
import {
  ACP_ENVIRONMENT_NOTE,
  AcpThreadManager,
  type AcpThreadManagerOptions,
  buildEnvironmentNote,
  MAX_QUEUED_PROMPTS,
} from './thread-manager.ts';

const log = getLogger('acp-thread-test');
const BLOCKING_CONSENT_BUDGET_MS = Math.floor(THREAD_REOPEN_OP_TIMEOUT_MS / 2);

const EXAMPLE_AGENT = join(
  dirname(Bun.resolveSync('@agentclientprotocol/sdk', import.meta.dirname)),
  'examples/agent.js',
);

const fakeSessionManager = {
  getSession: async () => {
    throw new Error('example agent never uses client fs');
  },
  closeAllForAgent: async () => {},
} as unknown as AgentSessionManager;

let dirs: string[] = [];
let managers: AcpThreadManager[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'acp-thread-test-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.allSettled(managers.map((m) => m.destroy()));
  managers = [];
  vi.restoreAllMocks();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function makeManager(
  contentDir: string,
  localDir: string,
  extra?: {
    probePiAcpBridge?: AcpThreadManagerOptions['probePiAcpBridge'];
    ensurePiAcpBridge?: AcpThreadManagerOptions['ensurePiAcpBridge'];
    steerStallMs?: number;
    authenticateTimeoutMs?: number;
    unwatchedTurnCancelMs?: number;
    unwatchedTurnKillMs?: number;
    turnStallMs?: number;
    isIgnoredPath?: (relPosix: string) => boolean;
    registry?: AcpRegistry;
    runtimeInstall?: AcpThreadManagerOptions['runtimeInstall'];
    resolveLoginShellPath?: () => Promise<string | null>;
    agentPresenceBroadcaster?: AgentPresenceBroadcaster;
    sessionManager?: AgentSessionManager;
    log?: PinoLogger;
    projectSkillSourceDir?: string | null;
    autoApproveOkTools?: () => boolean;
    terminalAuthAvailable?: boolean;
  },
): AcpThreadManager {
  const manager = new AcpThreadManager({
    contentDir,
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
    log,
    resolveLoginShellPath: async () => null,
    ...extra,
  });
  managers.push(manager);
  return manager;
}

function internals(manager: AcpThreadManager): {
  sweep: () => void;
  pendingPermissionCount: (threadId: string) => number;
  turnActive: (threadId: string) => boolean;
  child: (threadId: string) => ChildProcess | null | undefined;
  sessionId: (threadId: string) => string | null | undefined;
} {
  const m = manager as unknown as {
    reapIdleThreads: () => void;
    threads: Map<
      string,
      {
        pendingPermissions: Map<unknown, unknown>;
        turnActive: boolean;
        child: ChildProcess | null;
        sessionId: string | null;
      }
    >;
  };
  return {
    sweep: () => m.reapIdleThreads(),
    pendingPermissionCount: (threadId) => m.threads.get(threadId)?.pendingPermissions.size ?? 0,
    turnActive: (threadId) => m.threads.get(threadId)?.turnActive ?? false,
    child: (threadId) => m.threads.get(threadId)?.child,
    sessionId: (threadId) => m.threads.get(threadId)?.sessionId,
  };
}

function stagedSkillPath(localDir: string): string {
  return join(projectSkillStageDir(localDir), PROJECT_SKILL_ENTRY);
}

function stagedSkillNote(localDir: string): string {
  return buildEnvironmentNote({ skillPath: stagedSkillPath(localDir) });
}

describe('package acquisition failure projection', () => {
  test.each(['npx', 'uvx'] as const)(
    '%s start and retry retain actionable native refusal and clean up',
    async (runtime) => {
      await withLocalAcquisitionRegistry(async (home) => {
        process.env.npm_config_before = '1970-01-01';
        process.env.UV_EXCLUDE_NEWER = '1970-01-01';
        const localDir = tmp();
        const agent = registryPackage(
          runtime === 'npx' ? 'is-number@7.0.0' : 'ruff@0.16.7',
          runtime,
        );
        const registry = new AcpRegistry({
          localDir,
          log,
          fetchImpl: async () => new Response(JSON.stringify({ agents: [agent] })),
        });
        const manager = makeManager(home, localDir, { registry });
        const events: ThreadEvent[] = [];
        const info = await manager.createThread({ agent: { source: 'registry', id: agent.id } });
        await manager.subscribe(info.threadId, 0, (frame) => {
          if (frame.op === 'event') events.push(frame.event);
          else if (frame.op === 'events') events.push(...frame.events);
        });
        try {
          for (const attempt of ['start', 'retry']) {
            if (attempt === 'retry') {
              const previous = events.filter(
                (event) => event.kind === 'status' && event.status === 'error',
              ).length;
              await manager.retryThread(info.threadId).catch(() => {});
              await expect
                .poll(
                  () =>
                    events.filter((event) => event.kind === 'status' && event.status === 'error')
                      .length,
                  { timeout: 5000 },
                )
                .toBeGreaterThan(previous);
            }
            await expect
              .poll(() => manager.getInfo(info.threadId)?.status, { timeout: 20_000 })
              .toBe('error');
            await expect
              .poll(() => internals(manager).child(info.threadId), { timeout: 5000 })
              .toBeNull();
            await expect
              .poll(
                () => events.some((event) => event.kind === 'status' && event.status === 'error'),
                { timeout: 5000 },
              )
              .toBe(true);
            const failure = events
              .filter((event) => event.kind === 'status' && event.status === 'error')
              .at(-1);
            expect.soft(failure, attempt).toMatchObject({
              failure: {
                reason: 'connect',
                agentMessage: expect.stringMatching(/release|policy|allowed|available/i),
                machineDetail: expect.stringMatching(
                  runtime === 'npx' ? /ETARGET|ENOVERSIONS/ : /exclude-newer|No solution found/,
                ),
              },
            });
            expect.soft(internals(manager).pendingPermissionCount(info.threadId)).toBe(0);
            if (failure?.kind === 'status')
              expect.soft(failure.failure?.machineDetail?.length ?? 0).toBeLessThan(20_000);
            if (failure?.kind === 'status')
              expect
                .soft(failure.failure?.machineDetail)
                .toContain(
                  runtime === 'npx' ? 'A complete log of this run' : 'to override the cutoff',
                );
          }
        } finally {
          await manager.destroy();
        }
      });
    },
    90_000,
  );

  test.each(['npx', 'uvx'] as const)(
    '%s resume exposes typed install-failed after real native acquisition refusal',
    async (runtime) => {
      await withLocalAcquisitionRegistry(async (home) => {
        const realNpx = npmCli('npx');
        const realNpm = npmCli('npm');
        const localDir = tmp();
        writeResumableAgentEntry(localDir, 'resume-bootstrap', { FAKE_CAPS: 'resume,load' });
        const bin = join(home, 'bin');
        mkdirSync(bin);
        installNodeFixture(bin);
        const npx = join(bin, 'npx');
        writeExecutable(
          npx,
          `if(process.argv.includes('--version')) process.stdout.write('11.17.0\\n');
        else import(${JSON.stringify(pathToFileURL(join(localDir, 'resume-bootstrap.mjs')).href)});`,
        );
        writeExecutable(
          join(bin, 'npm'),
          `const r=require('node:child_process').spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(realNpm)}, ...process.argv.slice(2)], {stdio:'inherit',env:process.env}); process.exit(r.status ?? 1);`,
        );
        const env = {
          PATH: [bin, process.env.PATH ?? ''].join(delimiter),
          FAKE_CAPS: 'resume,load',
        };
        let agent = registryPackage('fixture-bootstrap', 'npx', env);
        agent.distribution.npx = { package: 'fixture-bootstrap', env };
        const registry = new AcpRegistry({
          localDir,
          log,
          ttlMs: 0,
          fetchImpl: async () => new Response(JSON.stringify({ agents: [agent] })),
        });
        const manager = makeManager(home, localDir, { registry });
        await manager.init();
        try {
          const info = await manager.createThread({ agent: { source: 'registry', id: agent.id } });
          await expect
            .poll(() => manager.getInfo(info.threadId)?.status, { timeout: 15_000 })
            .toBe('ready');
          manager.sendPrompt(info.threadId, 'retain this fixture session');
          await expect
            .poll(() => manager.getInfo(info.threadId)?.status, { timeout: 15_000 })
            .toBe('ready');
          await manager.closeThread(info.threadId);
          agent = registryPackage(
            runtime === 'npx' ? 'is-number@7.0.0' : 'ruff@0.16.7',
            runtime,
            env,
          );
          process.env.npm_config_before = '1970-01-01';
          process.env.UV_EXCLUDE_NEWER = '1970-01-01';
          writeExecutable(
            npx,
            `const r=require('node:child_process').spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(realNpx)}, ...process.argv.slice(2)], {stdio:'inherit',env:process.env}); process.exit(r.status ?? 1);`,
          );
          await expect(manager.resumeThread(info.threadId)).rejects.toMatchObject({
            code: 'install-failed',
            message: expect.stringMatching(/release-date policy/),
          });
          expect(manager.getInfo(info.threadId)?.archived).toBe(true);
          expect(internals(manager).child(info.threadId)).toBeNull();
          const replay: ThreadEvent[] = [];
          await manager.subscribe(info.threadId, 0, (frame) => {
            if (frame.op === 'event') replay.push(frame.event);
            else if (frame.op === 'events') replay.push(...frame.events);
          });
          expect(replay.filter((event) => event.kind === 'status').at(-1)).toMatchObject({
            status: 'exited',
            failure: {
              reason: 'connect',
              agentMessage: expect.stringMatching(/release-date policy/),
              machineDetail: expect.stringMatching(
                runtime === 'npx' ? /ETARGET|ENOVERSIONS/ : /exclude-newer|No solution found/,
              ),
            },
          });
        } finally {
          await manager.destroy();
        }
      });
    },
    90_000,
  );

  test('a ceiling-sized acquisition primary preserves its headline and a distinct stderr tail', async () => {
    await withLocalAcquisitionRegistry(async (home) => {
      const localDir = tmp();
      const bin = join(home, 'bin');
      mkdirSync(bin);
      installNodeFixture(bin);
      const originalPath = process.env.PATH;
      writeExecutable(
        join(bin, 'uvx'),
        `
        const args = process.argv.slice(2);
        const result = require('node:child_process').spawnSync('uvx', args, {
          encoding: 'utf8', env: { ...process.env, PATH: ${JSON.stringify(originalPath)} },
        });
        if (args.length === 1 && args[0] === '--version') {
          process.stdout.write(result.stdout);
        } else {
          const headline = 'PRIMARY-HEAD ' + result.stderr.replace(/\\n/g, ' ');
          process.stderr.write('TAIL-ONLY: registry endpoint\\n' + headline.padEnd(15999, 'x') + '\\n');
        }
        process.exit(result.status ?? 1);
      `,
      );
      const env = {
        PATH: [bin, originalPath ?? ''].join(delimiter),
        UV_EXCLUDE_NEWER: '1970-01-01',
      };
      const agent = registryPackage('ruff@0.16.7', 'uvx', env);
      const registry = new AcpRegistry({
        localDir,
        log,
        fetchImpl: async () => new Response(JSON.stringify({ agents: [agent] })),
      });
      const manager = makeManager(home, localDir, { registry });
      const info = await manager.createThread({ agent: { source: 'registry', id: agent.id } });
      const statuses: StatusEvent[] = [];
      await manager.subscribe(info.threadId, 0, collectStatuses(statuses));
      await waitUntil(
        () => statuses.some((event) => event.failure?.reason === 'connect'),
        15_000,
        'acquisition failure',
      );
      const detail = statuses.find((event) => event.failure?.reason === 'connect')?.failure
        ?.machineDetail;
      expect(detail).toMatch(/^PRIMARY-HEAD /);
      expect(detail).toContain('No solution found');
      expect(detail).toContain('TAIL-ONLY: registry endpoint');
      expect(detail?.length).toBeLessThanOrEqual(16_000);
    });
  }, 30_000);

  test('compatibility control: ordinary ACP closure is not described as a package policy refusal', async () => {
    const localDir = tmp();
    const command = join(localDir, 'ordinary-close.cjs');
    writeFileSync(
      command,
      "process.stderr.write('ordinary ACP fixture closure https://alice:fixture-secret@registry.example.test/pkg Authorization: Bearer fixture-token');process.exit(1);",
    );
    writeFileSync(
      join(localDir, 'acp-agents.json'),
      JSON.stringify([
        { id: 'ordinary', name: 'Ordinary', command: process.execPath, args: [command] },
      ]),
    );
    const manager = makeManager(tmp(), localDir);
    const events: ThreadEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'custom', id: 'ordinary' } });
    await manager.subscribe(info.threadId, 0, (frame) => {
      if (frame.op === 'event') events.push(frame.event);
      else if (frame.op === 'events') events.push(...frame.events);
    });
    await expect
      .poll(() => manager.getInfo(info.threadId)?.status, { timeout: 10_000 })
      .toBe('error');
    await expect
      .poll(() => events.some((event) => event.kind === 'status' && event.status === 'error'), {
        timeout: 5000,
      })
      .toBe(true);
    const failure = events
      .filter((event) => event.kind === 'status' && event.status === 'error')
      .at(-1);
    expect(failure).toMatchObject({
      failure: { reason: 'connect', agentMessage: expect.stringContaining('initialize failed') },
    });
    expect(JSON.stringify(failure)).not.toMatch(
      /release-date policy|cooldown|fixture-secret|fixture-token/,
    );
  });
});

function writeExampleAgentEntry(localDir: string): void {
  writeFileSync(
    join(localDir, 'acp-agents.json'),
    JSON.stringify([
      { id: 'example', name: 'Example Agent', command: 'node', args: [EXAMPLE_AGENT] },
    ]),
  );
}

async function waitUntil(pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function statusesOf(manager: AcpThreadManager, threadId: string): Promise<string[]> {
  const statuses: string[] = [];
  await manager.subscribe(threadId, 0, (frame) => {
    const events = frame.op === 'event' ? [frame.event] : frame.op === 'events' ? frame.events : [];
    for (const event of events) if (event.kind === 'status') statuses.push(event.status);
  });
  return statuses;
}

describe('AcpThreadManager (real subprocess)', () => {
  test('runs a full turn against the SDK example agent, permission round-trip included', async () => {
    expect(existsSync(EXAMPLE_AGENT)).toBe(true);
    const contentDir = tmp();
    const localDir = tmp();
    writeFileSync(
      join(localDir, 'acp-agents.json'),
      JSON.stringify([
        { id: 'example', name: 'Example Agent', command: 'node', args: [EXAMPLE_AGENT] },
      ]),
    );
    const manager = makeManager(contentDir, localDir);

    const events: Array<{ seq: number; event: ThreadEvent }> = [];
    const info = await manager.createThread({ agent: { source: 'custom', id: 'example' } });
    expect(info.status).toBe('spawning');
    await manager.subscribe(info.threadId, 0, (frame: ThreadServerFrame) => {
      if (frame.op === 'event') events.push({ seq: frame.seq, event: frame.event });
      if (frame.op === 'events') {
        for (const [i, event] of frame.events.entries()) {
          events.push({ seq: frame.fromSeq + i, event });
        }
      }
    });

    const waitFor = async (pred: () => boolean, ms: number): Promise<void> => {
      const deadline = Date.now() + ms;
      while (!pred()) {
        if (Date.now() > deadline) {
          throw new Error(
            `timed out; events so far: ${JSON.stringify(events.map((e) => e.event.kind))}`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    await waitFor(
      () => events.some((e) => e.event.kind === 'status' && e.event.status === 'ready'),
      15_000,
    );

    manager.sendPrompt(info.threadId, 'Improve my project please');

    await waitFor(() => events.some((e) => e.event.kind === 'permission_request'), 20_000);
    const request = events.find((e) => e.event.kind === 'permission_request')?.event;
    if (request?.kind !== 'permission_request') throw new Error('unreachable');
    expect(request.options.map((o) => o.optionId)).toContain('allow');

    manager.respondPermission(info.threadId, request.requestId, {
      kind: 'selected',
      optionId: 'allow',
    });

    await waitFor(() => events.some((e) => e.event.kind === 'turn_ended'), 20_000);
    const turnEnd = events.find((e) => e.event.kind === 'turn_ended')?.event;
    if (turnEnd?.kind !== 'turn_ended') throw new Error('unreachable');
    expect(turnEnd.stopReason).toBe('end_turn');

    expect(events.some((e) => e.event.kind === 'session_update')).toBe(true);
    const seqs = events.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

    const replayed: number[] = [];
    await manager.subscribe(info.threadId, 0, (frame) => {
      if (frame.op === 'event') replayed.push(frame.seq);
      if (frame.op === 'events') {
        for (let i = 0; i < frame.events.length; i++) {
          replayed.push(frame.fromSeq + i);
        }
      }
    });
    expect(replayed.length).toBeGreaterThanOrEqual(events.length);

    await manager.closeThread(info.threadId);
    expect(manager.listThreads().filter((t) => t.archived !== true)).toHaveLength(0);
    expect(manager.listThreads()[0]?.archived).toBe(true);
  }, 45_000);

  test('closeThread kills a SIGTERM-ignoring agent tree before resolving', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const kidPidFile = join(localDir, 'kid.pid');
    const agentPath = join(localDir, 'stubborn-agent.mjs');
    writeFileSync(
      agentPath,
      [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "process.on('SIGTERM', () => {});",
        'const kid = spawn(process.execPath, [',
        "  '-e',",
        '  "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000);",',
        "], { stdio: 'ignore' });",
        'writeFileSync(process.env.KID_PID_FILE, String(kid.pid));',
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(localDir, 'acp-agents.json'),
      JSON.stringify([
        {
          id: 'stubborn',
          name: 'Stubborn Agent',
          command: 'node',
          args: [agentPath],
          env: { KID_PID_FILE: kidPidFile },
        },
      ]),
    );
    const manager = makeManager(contentDir, localDir);
    const info = await manager.createThread({ agent: { source: 'custom', id: 'stubborn' } });

    const deadline = Date.now() + 5_000;
    while (!existsSync(kidPidFile)) {
      if (Date.now() > deadline) throw new Error('agent tree never spawned');
      await new Promise((r) => setTimeout(r, 25));
    }
    const kidPid = Number(readFileSync(kidPidFile, 'utf8'));
    const rootPid = (
      manager as unknown as { threads: Map<string, { child: { pid?: number } | null }> }
    ).threads.get(info.threadId)?.child?.pid;
    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(typeof rootPid).toBe('number');
    expect(isAlive(kidPid)).toBe(true);

    await manager.closeThread(info.threadId, { killGraceMs: 250 });

    expect(rootPid !== undefined && isAlive(rootPid)).toBe(false);
    const kidDeadline = Date.now() + 2_000;
    while (isAlive(kidPid)) {
      if (Date.now() > kidDeadline) throw new Error('grandchild survived closeThread');
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(manager.listThreads().filter((t) => t.archived !== true)).toHaveLength(0);
  }, 15_000);

  test('unwatched turn backstop: cancel stage ends a zero-subscriber turn', async () => {
    const localDir = tmp();
    writeExampleAgentEntry(localDir);
    const manager = makeManager(tmp(), localDir, {
      unwatchedTurnCancelMs: 1,
      unwatchedTurnKillMs: 10 * 60 * 1000,
    });
    const info = await manager.createThread({ agent: { source: 'custom', id: 'example' } });
    const { sweep, pendingPermissionCount, turnActive } = internals(manager);

    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'ready',
      15_000,
      'agent ready',
    );
    manager.sendPrompt(info.threadId, 'Improve my project please');
    await waitUntil(
      () => pendingPermissionCount(info.threadId) > 0,
      20_000,
      'pending permission request',
    );

    sweep();

    await waitUntil(() => !turnActive(info.threadId), 10_000, 'turn cancelled');
    expect(manager.getInfo(info.threadId)?.status).toBe('ready');
    expect(manager.listThreads()).toHaveLength(1);
  }, 45_000);

  test('unwatched turn backstop: kill stage force-closes when past the kill threshold', async () => {
    const localDir = tmp();
    writeExampleAgentEntry(localDir);
    const manager = makeManager(tmp(), localDir, {
      unwatchedTurnCancelMs: 1,
      unwatchedTurnKillMs: 1,
    });
    const info = await manager.createThread({ agent: { source: 'custom', id: 'example' } });
    const { sweep } = internals(manager);

    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'ready',
      15_000,
      'agent ready',
    );
    manager.sendPrompt(info.threadId, 'Improve my project please');

    sweep();

    await waitUntil(
      () => manager.listThreads().filter((t) => t.archived !== true).length === 0,
      10_000,
      'thread force-closed',
    );
  }, 45_000);

  test('unknown agents and capacity are refused cleanly', async () => {
    const manager = makeManager(tmp(), tmp());
    await expect(manager.createThread({ agent: { source: 'custom', id: 'nope' } })).rejects.toThrow(
      "no custom agent 'nope'",
    );
    await expect(
      manager.createThread({ agent: { source: 'registry', id: 'ghost' } }),
    ).rejects.toThrow('agent registry unavailable');

    const emptyCatalogRegistry = new AcpRegistry({
      localDir: tmp(),
      log,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ agents: [] }), { status: 200 })) as typeof fetch,
    });
    const manager2 = makeManager(tmp(), tmp(), { registry: emptyCatalogRegistry });
    await expect(
      manager2.createThread({ agent: { source: 'registry', id: 'ghost' } }),
    ).rejects.toThrow('not in the registry');
  });

  test('session config options: advertised at session/new, set round-trips', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const agentPath = join(localDir, 'config-option-agent.mjs');
    writeFileSync(
      agentPath,
      `
let current = 'sonnet';
const configOptions = () => [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: current,
    options: [
      { value: 'sonnet', name: 'Sonnet' },
      { value: 'opus', name: 'Opus' },
    ],
  },
];
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    const reply = (result) =>
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    if (msg.method === 'initialize') {
      reply({ protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      reply({ sessionId: 's1', configOptions: configOptions() });
    } else if (msg.method === 'session/set_config_option') {
      current = msg.params.value;
      reply({ configOptions: configOptions() });
    } else if (msg.method === 'session/prompt') {
      reply({ stopReason: 'end_turn' });
    } else if (msg.id !== undefined) {
      reply({});
    }
  }
});
`,
    );
    writeFileSync(
      join(localDir, 'acp-agents.json'),
      JSON.stringify([
        { id: 'config-agent', name: 'Config Agent', command: 'node', args: [agentPath] },
      ]),
    );
    const manager = makeManager(contentDir, localDir);

    const info = await manager.createThread({ agent: { source: 'custom', id: 'config-agent' } });
    const waitFor = async (pred: () => boolean, ms: number): Promise<void> => {
      const deadline = Date.now() + ms;
      while (!pred()) {
        if (Date.now() > deadline) {
          throw new Error(`timed out; info: ${JSON.stringify(manager.getInfo(info.threadId))}`);
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    await waitFor(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000);
    const advertised = manager.getInfo(info.threadId)?.configOptions;
    expect(advertised).toHaveLength(1);
    expect(advertised?.[0]).toMatchObject({
      id: 'model',
      category: 'model',
      type: 'select',
      currentValue: 'sonnet',
    });
    expect(manager.getInfo(info.threadId)?.promptCapabilities).toEqual({});

    manager.setConfigOption(info.threadId, 'model', 'opus');
    await waitFor(
      () => manager.getInfo(info.threadId)?.configOptions?.[0]?.currentValue === 'opus',
      10_000,
    );

    await manager.closeThread(info.threadId);
  }, 30_000);

  test('prompt capabilities: advertised at initialize, land on thread info', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const agentPath = join(localDir, 'prompt-caps-agent.mjs');
    writeFileSync(
      agentPath,
      `
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    const reply = (result) =>
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    if (msg.method === 'initialize') {
      reply({
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: { image: true, embeddedContext: true } },
      });
    } else if (msg.method === 'session/new') {
      reply({ sessionId: 's1' });
    } else if (msg.method === 'session/prompt') {
      reply({ stopReason: 'end_turn' });
    } else if (msg.id !== undefined) {
      reply({});
    }
  }
});
`,
    );
    writeFileSync(
      join(localDir, 'acp-agents.json'),
      JSON.stringify([
        { id: 'caps-agent', name: 'Caps Agent', command: 'node', args: [agentPath] },
      ]),
    );
    const manager = makeManager(contentDir, localDir);

    const info = await manager.createThread({ agent: { source: 'custom', id: 'caps-agent' } });
    expect(info.promptCapabilities).toBeNull();
    const deadline = Date.now() + 15_000;
    while (manager.getInfo(info.threadId)?.status !== 'ready') {
      if (Date.now() > deadline) {
        throw new Error(`timed out; info: ${JSON.stringify(manager.getInfo(info.threadId))}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(manager.getInfo(info.threadId)?.promptCapabilities).toEqual({
      image: true,
      embeddedContext: true,
    });

    await manager.closeThread(info.threadId);
  }, 30_000);

  test('initialize handshake: sends clientInfo implementation metadata', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const agentPath = join(localDir, 'client-info-agent.mjs');
    const capturePath = join(localDir, 'initialize-params.json');
    writeFileSync(
      agentPath,
      `
import { writeFileSync } from 'node:fs';
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    const reply = (result) =>
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    if (msg.method === 'initialize') {
      writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(msg.params));
      reply({ protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      reply({ sessionId: 's1' });
    } else if (msg.id !== undefined) {
      reply({});
    }
  }
});
`,
    );
    writeFileSync(
      join(localDir, 'acp-agents.json'),
      JSON.stringify([
        { id: 'client-info-agent', name: 'Client Info Agent', command: 'node', args: [agentPath] },
      ]),
    );
    const manager = makeManager(contentDir, localDir);

    const info = await manager.createThread({
      agent: { source: 'custom', id: 'client-info-agent' },
    });
    const deadline = Date.now() + 15_000;
    while (manager.getInfo(info.threadId)?.status !== 'ready') {
      if (Date.now() > deadline) {
        throw new Error(`timed out; info: ${JSON.stringify(manager.getInfo(info.threadId))}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    const params = JSON.parse(readFileSync(capturePath, 'utf8')) as {
      clientInfo?: unknown;
      clientCapabilities?: unknown;
    };
    expect(params.clientInfo).toEqual({
      name: 'open-knowledge',
      title: 'Open Knowledge',
      version: RUNTIME_VERSION,
    });
    expect(params.clientCapabilities).toBeDefined();

    await manager.closeThread(info.threadId);
  }, 30_000);

  test('available commands: captured from available_commands_update; env note rides only the first wire prompt', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const agentPath = join(localDir, 'commands-agent.mjs');
    writeFileSync(
      agentPath,
      `
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
const notify = (update) =>
  write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update } });
let prompts = 0;
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    const reply = (result) =>
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    if (msg.method === 'initialize') {
      reply({ protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      reply({ sessionId: 's1' });
      notify({
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'review', description: 'Review the current diff' },
        ],
      });
    } else if (msg.method === 'session/prompt') {
      prompts += 1;
      notify({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'received:' + msg.params.prompt[0].text },
      });
      if (prompts === 1) {
        notify({
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            { name: 'review', description: 'Review the current diff' },
            { name: 'plan', description: 'Draft a plan' },
          ],
        });
      }
      reply({ stopReason: 'end_turn' });
    } else if (msg.id !== undefined) {
      reply({});
    }
  }
});
`,
    );
    writeFileSync(
      join(localDir, 'acp-agents.json'),
      JSON.stringify([
        { id: 'commands-agent', name: 'Commands Agent', command: 'node', args: [agentPath] },
      ]),
    );
    const manager = makeManager(contentDir, localDir);

    const info = await manager.createThread({ agent: { source: 'custom', id: 'commands-agent' } });
    expect(info.availableCommands).toBeNull();

    const events: Array<{ seq: number; event: ThreadEvent }> = [];
    await manager.subscribe(info.threadId, 0, (frame: ThreadServerFrame) => {
      if (frame.op === 'event') events.push({ seq: frame.seq, event: frame.event });
      if (frame.op === 'events') {
        for (const [i, event] of frame.events.entries()) {
          events.push({ seq: frame.fromSeq + i, event });
        }
      }
    });
    const waitFor = async (pred: () => boolean, ms: number): Promise<void> => {
      const deadline = Date.now() + ms;
      while (!pred()) {
        if (Date.now() > deadline) {
          throw new Error(`timed out; info: ${JSON.stringify(manager.getInfo(info.threadId))}`);
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    await waitFor(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000);
    await waitFor(
      () => (manager.getInfo(info.threadId)?.availableCommands ?? []).length > 0,
      10_000,
    );
    expect(manager.getInfo(info.threadId)?.availableCommands).toEqual([
      { name: 'review', description: 'Review the current diff' },
    ]);

    const receivedTexts = () =>
      events
        .map((e) => e.event)
        .filter((e) => e.kind === 'session_update')
        .map((e) => (e.update as { content?: { text?: string } }).content?.text ?? '')
        .filter((text) => text.startsWith('received:'));

    manager.sendPrompt(info.threadId, '/review the diff');
    await waitFor(() => receivedTexts().length === 1, 15_000);
    expect(receivedTexts()[0]).toBe('received:/review the diff');

    await waitFor(
      () => (manager.getInfo(info.threadId)?.availableCommands ?? []).length === 2,
      10_000,
    );

    await waitFor(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000);
    manager.sendPrompt(info.threadId, '/plan the rollout');
    await waitFor(() => receivedTexts().length === 2, 15_000);
    expect(receivedTexts()[1]).toBe('received:/plan the rollout');

    await waitFor(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000);
    manager.sendPrompt(info.threadId, 'first hello');
    await waitFor(() => receivedTexts().length === 3, 15_000);
    expect(receivedTexts()[2]).toBe(`received:${stagedSkillNote(localDir)}\n\nfirst hello`);
    const userMessages = events
      .map((e) => e.event)
      .filter((e) => e.kind === 'user_message')
      .map((e) => e.content);
    expect(userMessages).toEqual(['/review the diff', '/plan the rollout', 'first hello']);

    await waitFor(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000);
    manager.sendPrompt(info.threadId, 'second hello');
    await waitFor(() => receivedTexts().length === 4, 15_000);
    expect(receivedTexts()[3]).toBe('received:second hello');

    await manager.closeThread(info.threadId);
  }, 30_000);
});

const RESUMABLE_AGENT_SOURCE = `
const { appendFileSync } = process.getBuiltinModule('node:fs');
const caps = (process.env.FAKE_CAPS ?? '').split(',').filter(Boolean);
const withConfig = process.env.FAKE_CONFIG === '1';
const withModes = process.env.FAKE_MODES === '1';
let modeValue = 'ask';
const modeState = () => ({
  currentModeId: modeValue,
  availableModes: [
    { id: 'ask', name: 'Ask#' + process.pid },
    { id: 'plan', name: 'Plan#' + process.pid },
  ],
});
// applyInitialMode records a successful set locally rather than storing an
// agent-returned object, so unlike configOptions the mode cannot be proven to
// have reached the agent by inspecting the manager. This log is that proof:
// the test truncates it before resuming, so any line in it came from the
// process the resume started.
const logSetMode = (modeId) => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, modeId + '\\n');
};
// A resumed agent is a NEW process, so this resets to the default on every
// resume — which is exactly what a real agent does with a fresh session.
let modelValue = 'sonnet';
// The pid tags every option this process hands out, so a test can tell values
// that came from THIS session's response apart from ones the manager merely
// replayed out of the persisted meta.
const configOptions = () => [
  {
    id: 'model',
    name: 'Model#' + process.pid,
    type: 'select',
    category: 'model',
    currentValue: modelValue,
    options: [{ value: 'sonnet', name: 'Sonnet' }, { value: 'opus', name: 'Opus' }],
  },
];
// FAKE_CONFIG_ON_RESUME=0 models an agent that resumes without reporting its
// config — legal per ACP, both response types mark configOptions optional.
const resumeReply = () => {
  const reportState = process.env.FAKE_CONFIG_ON_RESUME !== '0';
  const out = {};
  if (withConfig && reportState) out.configOptions = configOptions();
  if (withModes && reportState) out.modes = modeState();
  return out;
};
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    const reply = (result) => write({ jsonrpc: '2.0', id: msg.id, result });
    const replyErr = (code, message) => write({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
    const notify = (update) =>
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-fixed', update } });
    if (msg.method === 'initialize') {
      const agentCapabilities = {};
      if (caps.includes('load')) agentCapabilities.loadSession = true;
      if (caps.includes('resume')) agentCapabilities.sessionCapabilities = { resume: {} };
      reply({ protocolVersion: 1, agentCapabilities });
    } else if (msg.method === 'session/new') {
      const newSession = { sessionId: 'sess-fixed' };
      if (withConfig) newSession.configOptions = configOptions();
      if (withModes) newSession.modes = modeState();
      reply(newSession);
      notify({
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'fresh_only', description: 'advertised on session/new only' }],
      });
    } else if (msg.method === 'session/set_config_option') {
      if (msg.params.configId === 'model') modelValue = msg.params.value;
      reply({ configOptions: configOptions() });
    } else if (msg.method === 'session/set_mode') {
      if (!modeState().availableModes.some((m) => m.id === msg.params.modeId)) {
        replyErr(-32602, 'unknown mode');
      } else {
        modeValue = msg.params.modeId;
        logSetMode(msg.params.modeId);
        reply({});
      }
    } else if (msg.method === 'session/prompt') {
      notify({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'echo:' + msg.params.prompt[0].text },
      });
      reply({ stopReason: 'end_turn' });
    } else if (msg.method === 'session/load') {
      if (process.env.FAIL_LOAD === '1' || msg.params.sessionId !== 'sess-fixed') {
        replyErr(-32002, 'unknown session');
      } else {
        notify({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old-user' } });
        notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old-agent' } });
        reply(resumeReply());
      }
    } else if (msg.method === 'session/resume') {
      if (msg.params.sessionId !== 'sess-fixed') replyErr(-32002, 'unknown session');
      // Holding the reply widens the window between the manager clearing
      // 'archived' and the session actually being back, which is the state a
      // concurrency guard has to be tested against.
      else if (Number(process.env.FAKE_RESUME_DELAY_MS ?? 0) > 0)
        setTimeout(() => reply(resumeReply()), Number(process.env.FAKE_RESUME_DELAY_MS));
      else reply(resumeReply());
    } else if (msg.id !== undefined) {
      reply({});
    }
  }
});
`;

function writeResumableAgentEntry(localDir: string, id: string, env: Record<string, string>): void {
  const agentPath = join(localDir, `${id}.mjs`);
  writeFileSync(agentPath, RESUMABLE_AGENT_SOURCE);
  writeFileSync(
    join(localDir, 'acp-agents.json'),
    JSON.stringify([{ id, name: `Fake ${id}`, command: 'node', args: [agentPath], env }]),
  );
}

function writeStreamerAgentEntry(localDir: string, id: string): void {
  const agentPath = join(localDir, `${id}.mjs`);
  writeFileSync(
    agentPath,
    `
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
const notify = (update) =>
  write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-fixed', update } });
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    const reply = (result) => write({ jsonrpc: '2.0', id: msg.id, result });
    if (msg.method === 'initialize') {
      reply({ protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      reply({ sessionId: 'sess-fixed' });
    } else if (msg.method === 'session/prompt') {
      for (const w of 'ABCDEFGH') notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: w } });
      for (const w of 'think') notify({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: w } });
      for (const w of 'IJKLMNOP') notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: w } });
      reply({ stopReason: 'end_turn' });
    } else if (msg.id !== undefined) {
      reply({});
    }
  }
});
`,
  );
  writeFileSync(
    join(localDir, 'acp-agents.json'),
    JSON.stringify([{ id, name: `Fake ${id}`, command: 'node', args: [agentPath] }]),
  );
}

describe('AcpThreadManager persistence + resume', () => {
  type Collected = Array<{ seq: number; event: ThreadEvent }>;
  const collector = (into: Collected) => (frame: ThreadServerFrame) => {
    if (frame.op === 'event') into.push({ seq: frame.seq, event: frame.event });
    if (frame.op === 'events') {
      for (const [i, event] of frame.events.entries()) {
        into.push({ seq: frame.fromSeq + i, event });
      }
    }
  };
  const kinds = (events: Collected): string[] => events.map((e) => e.event.kind);
  const notedEcho = (localDir: string, text: string): string =>
    `echo:${stagedSkillNote(localDir)}\n\n${text}`;
  const agentChunks = (events: Collected): string[] =>
    events
      .map((e) => e.event)
      .filter((e) => e.kind === 'session_update')
      .map(
        (e) => (e as { update?: { sessionUpdate?: string; content?: { text?: string } } }).update,
      )
      .filter((update) => update?.sessionUpdate === 'agent_message_chunk')
      .map((update) => update?.content?.text ?? '');

  async function runOneTurn(
    manager: AcpThreadManager,
    agentId: string,
    prompt: string,
  ): Promise<string> {
    const info = await manager.createThread({ agent: { source: 'custom', id: agentId } });
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'ready',
      15_000,
      'agent ready',
    );
    manager.sendPrompt(info.threadId, prompt);
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'turn ended');
    return info.threadId;
  }

  const chunkText = (e: ThreadEvent): string =>
    e.kind === 'session_update'
      ? ((e.update as unknown as { content?: { text?: string } }).content?.text ?? '')
      : '';
  const chunksOfKind = (events: Collected, kind: string): ThreadEvent[] =>
    events
      .map((e) => e.event)
      .filter(
        (e) =>
          e.kind === 'session_update' &&
          (e.update as unknown as { sessionUpdate?: string }).sessionUpdate === kind,
      );

  test('a streamed chunk burst folds into far fewer transcript events, boundaries intact', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeStreamerAgentEntry(localDir, 'streamer');
    const manager = makeManager(contentDir, localDir);
    await manager.init();
    const threadId = await runOneTurn(manager, 'streamer', 'go');

    const live: Collected = [];
    await manager.subscribe(threadId, 0, collector(live));

    expect(live.map((e) => e.seq)).toEqual(live.map((_, i) => i));

    const messageChunks = chunksOfKind(live, 'agent_message_chunk');
    const thoughtChunks = chunksOfKind(live, 'agent_thought_chunk');
    expect(messageChunks.map(chunkText).join('')).toBe('ABCDEFGHIJKLMNOP');
    expect(thoughtChunks.map(chunkText).join('')).toBe('think');
    expect(messageChunks.length).toBeGreaterThanOrEqual(2);
    expect(messageChunks.length).toBeLessThan(16);
    expect(thoughtChunks.length).toBeLessThan(5);

    await manager.closeThread(threadId);
    const manager2 = makeManager(contentDir, localDir);
    await manager2.init();
    const replayed: Collected = [];
    await manager2.subscribe(threadId, 0, collector(replayed));
    expect(replayed.map((e) => e.seq)).toEqual(replayed.map((_, i) => i));
    expect(chunksOfKind(replayed, 'agent_message_chunk').map(chunkText).join('')).toBe(
      'ABCDEFGHIJKLMNOP',
    );
  }, 45_000);

  test('close archives the transcript; a new manager rehydrates and replays it from disk', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeResumableAgentEntry(localDir, 'fake-resume', { FAKE_CAPS: 'resume,load' });
    const manager = makeManager(contentDir, localDir);
    await manager.init();
    const threadId = await runOneTurn(manager, 'fake-resume', 'hello there');
    const liveEvents: Collected = [];
    await manager.subscribe(threadId, 0, collector(liveEvents));
    await manager.closeThread(threadId);

    const archivedInfo = manager.listThreads().find((t) => t.threadId === threadId);
    expect(archivedInfo?.archived).toBe(true);
    expect(archivedInfo?.status).toBe('exited');
    expect(archivedInfo?.title).toBe('hello there');

    const manager2 = makeManager(contentDir, localDir);
    await manager2.init();
    const rehydrated = manager2.listThreads().find((t) => t.threadId === threadId);
    expect(rehydrated?.archived).toBe(true);
    expect(rehydrated?.title).toBe('hello there');
    const replayed: Collected = [];
    await manager2.subscribe(threadId, 0, collector(replayed));
    expect(replayed.length).toBeGreaterThanOrEqual(liveEvents.length);
    expect(replayed.map((e) => e.seq)).toEqual(replayed.map((_, i) => i));
    expect(kinds(replayed)).toContain('user_message');
    expect(agentChunks(replayed)).toContain(notedEcho(localDir, 'hello there'));
  }, 45_000);

  test('closing a never-prompted thread discards it instead of archiving', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeExampleAgentEntry(localDir);
    const manager = makeManager(contentDir, localDir);
    await manager.init();

    const info = await manager.createThread({ agent: { source: 'custom', id: 'example' } });
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'ready',
      15_000,
      'agent ready',
    );
    await manager.closeThread(info.threadId);

    expect(manager.listThreads().find((t) => t.threadId === info.threadId)).toBeUndefined();
    const manager2 = makeManager(contentDir, localDir);
    await manager2.init();
    expect(manager2.listThreads().find((t) => t.threadId === info.threadId)).toBeUndefined();
  }, 45_000);

  test('a manual rename survives archive + rehydration; adoption strips prompt filler', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeResumableAgentEntry(localDir, 'fake-resume', { FAKE_CAPS: 'resume,load' });
    const manager = makeManager(contentDir, localDir);
    await manager.init();
    const threadId = await runOneTurn(manager, 'fake-resume', 'please update the roadmap');
    expect(manager.getInfo(threadId)?.title).toBe('Update the roadmap');

    await manager.closeThread(threadId);
    const lastActivityAt = manager.getInfo(threadId)?.lastActivityAt;
    await manager.renameThread(threadId, 'Q3 roadmap thread');
    expect(manager.getInfo(threadId)?.title).toBe('Q3 roadmap thread');
    expect(manager.getInfo(threadId)?.lastActivityAt).toBe(lastActivityAt);

    const manager2 = makeManager(contentDir, localDir);
    await manager2.init();
    const rehydrated = manager2.listThreads().find((t) => t.threadId === threadId);
    expect(rehydrated?.title).toBe('Q3 roadmap thread');
    expect(rehydrated?.lastActivityAt).toBe(lastActivityAt);
    const replayed: Collected = [];
    await manager2.subscribe(threadId, 0, collector(replayed));
    expect(replayed.map((e) => e.seq)).toEqual(replayed.map((_, i) => i));
    expect(
      replayed.some(
        (e) => e.event.kind === 'title_changed' && e.event.title === 'Q3 roadmap thread',
      ),
    ).toBe(true);
  }, 45_000);

  test('launch title derives from titleHint, not the composed prompt preamble', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeExampleAgentEntry(localDir);
    const manager = makeManager(contentDir, localDir);
    await manager.init();

    const info = await manager.createThread({
      agent: { source: 'custom', id: 'example' },
      titleHint: 'Fix the login redirect',
    });
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'ready',
      15_000,
      'agent ready',
    );

    manager.sendPrompt(
      info.threadId,
      "You're an agent working inside OpenKnowledge, with its MCP tools available to you. Here's what I'd like to do:\n\n> Fix the login redirect",
    );
    await waitUntil(
      () => manager.getInfo(info.threadId)?.title !== info.agent.name,
      15_000,
      'title adopted',
    );
    expect(manager.getInfo(info.threadId)?.title).toBe('Fix the login redirect');
  }, 45_000);

  async function resumeWithConfig(reportOnResume: boolean): Promise<void> {
    const contentDir = tmp();
    const localDir = tmp();
    writeResumableAgentEntry(localDir, 'fake-resume', {
      FAKE_CAPS: 'resume,load',
      FAKE_CONFIG: '1',
      ...(reportOnResume ? {} : { FAKE_CONFIG_ON_RESUME: '0' }),
    });
    const manager = makeManager(contentDir, localDir);
    await manager.init();
    const threadId = await runOneTurn(manager, 'fake-resume', 'first message');

    manager.setConfigOption(threadId, 'model', 'opus');
    await waitUntil(
      () => manager.getInfo(threadId)?.configOptions?.[0]?.currentValue === 'opus',
      15_000,
      'model applied before archive',
    );
    const beforeArchive = manager.getInfo(threadId)?.configOptions?.[0];

    await manager.closeThread(threadId);
    expect(manager.getInfo(threadId)?.archived).toBe(true);
    await manager.resumeThread(threadId);
    await waitUntil(
      () => manager.getInfo(threadId)?.status === 'ready',
      15_000,
      'resumed thread ready',
    );

    const afterResume = manager.getInfo(threadId)?.configOptions?.[0];
    expect(afterResume?.currentValue).toBe('opus');
    expect(afterResume?.name).not.toBe(beforeArchive?.name);

    await manager.closeThread(threadId);
  }

  test('resume re-applies the thread settled config when the agent reports it', async () => {
    await resumeWithConfig(true);
  }, 45_000);

  test('resume re-applies the thread settled config when the agent reports none', async () => {
    await resumeWithConfig(false);
  }, 45_000);

  async function resumeWithMode(reportOnResume: boolean): Promise<void> {
    const contentDir = tmp();
    const localDir = tmp();
    const setModeLog = join(tmp(), 'set-mode.log');
    writeResumableAgentEntry(localDir, 'fake-resume', {
      FAKE_CAPS: 'resume,load',
      FAKE_MODES: '1',
      FAKE_LOG: setModeLog,
      ...(reportOnResume ? {} : { FAKE_CONFIG_ON_RESUME: '0' }),
    });
    const manager = makeManager(contentDir, localDir);
    await manager.init();
    const threadId = await runOneTurn(manager, 'fake-resume', 'first message');

    manager.setMode(threadId, 'plan');
    await waitUntil(
      () => manager.getInfo(threadId)?.modes?.currentModeId === 'plan',
      15_000,
      'mode applied before archive',
    );

    await manager.closeThread(threadId);
    writeFileSync(setModeLog, '');
    await manager.resumeThread(threadId);
    await waitUntil(
      () => manager.getInfo(threadId)?.status === 'ready',
      15_000,
      'resumed thread ready',
    );

    expect(manager.getInfo(threadId)?.modes?.currentModeId).toBe('plan');
    expect(readFileSync(setModeLog, 'utf8')).toContain('plan');

    await manager.closeThread(threadId);
  }

  test('resume re-applies the thread settled mode when the agent reports it', async () => {
    await resumeWithMode(true);
  }, 45_000);

  test('resume re-applies the thread settled mode when the agent reports none', async () => {
    await resumeWithMode(false);
  }, 45_000);

  test('a mode pick on an archived thread is kept and applied by the resume', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const setModeLog = join(tmp(), 'set-mode.log');
    writeResumableAgentEntry(localDir, 'fake-resume', {
      FAKE_CAPS: 'resume,load',
      FAKE_MODES: '1',
      FAKE_LOG: setModeLog,
    });
    const manager = makeManager(contentDir, localDir);
    await manager.init();
    const threadId = await runOneTurn(manager, 'fake-resume', 'first message');
    await manager.closeThread(threadId);
    writeFileSync(setModeLog, '');

    manager.setMode(threadId, 'plan');
    expect(manager.getInfo(threadId)?.modes?.currentModeId).toBe('plan');
    expect(readFileSync(setModeLog, 'utf8')).toBe('');
    expect(() => manager.setMode(threadId, 'nope')).toThrow();
    expect(manager.getInfo(threadId)?.modes?.currentModeId).toBe('plan');

    await manager.resumeThread(threadId);
    await waitUntil(
      () => manager.getInfo(threadId)?.status === 'ready',
      15_000,
      'resumed thread ready',
    );
    expect(readFileSync(setModeLog, 'utf8')).toContain('plan');

    await manager.closeThread(threadId);
  }, 45_000);

  test('a pick mid-resume is refused rather than sent at a half-open session', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeResumableAgentEntry(localDir, 'fake-resume', {
      FAKE_CAPS: 'resume,load',
      FAKE_CONFIG: '1',
      FAKE_RESUME_DELAY_MS: '2000',
    });
    const manager = makeManager(contentDir, localDir);
    await manager.init();
    const threadId = await runOneTurn(manager, 'fake-resume', 'first message');
    await manager.closeThread(threadId);

    const resuming = manager.resumeThread(threadId);
    await waitUntil(
      () => manager.getInfo(threadId)?.archived === false,
      15_000,
      'resume past the archived flip',
    );
    expect(() => manager.setConfigOption(threadId, 'model', 'opus')).toThrow(/still resuming/);
    expect(() => manager.setMode(threadId, 'plan')).toThrow(/still resuming/);

    await resuming;
    await manager.closeThread(threadId);
  }, 45_000);

  test('a config pick on an archived thread is kept and applied by the resume', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeResumableAgentEntry(localDir, 'fake-resume', {
      FAKE_CAPS: 'resume,load',
      FAKE_CONFIG: '1',
    });
    const manager = makeManager(contentDir, localDir);
    await manager.init();
    const threadId = await runOneTurn(manager, 'fake-resume', 'first message');
    await manager.closeThread(threadId);
    expect(manager.getInfo(threadId)?.archived).toBe(true);
    const beforePick = manager.getInfo(threadId)?.configOptions?.[0];
    expect(beforePick?.currentValue).toBe('sonnet');

    manager.setConfigOption(threadId, 'model', 'opus');
    expect(manager.getInfo(threadId)?.configOptions?.[0]?.currentValue).toBe('opus');

    await manager.resumeThread(threadId);
    await waitUntil(
      () => manager.getInfo(threadId)?.status === 'ready',
      15_000,
      'resumed thread ready',
    );
    const afterResume = manager.getInfo(threadId)?.configOptions?.[0];
    expect(afterResume?.currentValue).toBe('opus');
    expect(afterResume?.name).not.toBe(beforePick?.name);

    await manager.closeThread(threadId);
  }, 45_000);

  test('an archived thread rejects a value its options do not offer', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeResumableAgentEntry(localDir, 'fake-resume', {
      FAKE_CAPS: 'resume,load',
      FAKE_CONFIG: '1',
    });
    const manager = makeManager(contentDir, localDir);
    await manager.init();
    const threadId = await runOneTurn(manager, 'fake-resume', 'first message');
    await manager.closeThread(threadId);

    expect(() => manager.setConfigOption(threadId, 'model', 'gpt-9')).toThrow();
    expect(() => manager.setConfigOption(threadId, 'nonexistent', 'opus')).toThrow();
    expect(manager.getInfo(threadId)?.configOptions?.[0]?.currentValue).toBe('sonnet');
  }, 45_000);

  test('resume via session/resume: same thread continues, no history duplication', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeResumableAgentEntry(localDir, 'fake-resume', { FAKE_CAPS: 'resume,load' });
    const manager = makeManager(contentDir, localDir);
    await manager.init();
    const threadId = await runOneTurn(manager, 'fake-resume', 'first message');
    expect(manager.getInfo(threadId)?.availableCommands).toEqual([
      { name: 'fresh_only', description: 'advertised on session/new only' },
    ]);
    await manager.closeThread(threadId);
    expect(manager.getInfo(threadId)?.archived).toBe(true);

    const info = await manager.resumeThread(threadId, 'second message');
    expect(info.archived).toBe(false);
    await waitUntil(
      () =>
        manager.getInfo(threadId)?.status === 'ready' &&
        !(manager as unknown as { threads: Map<string, { turnActive: boolean }> }).threads.get(
          threadId,
        )?.turnActive,
      15_000,
      'resumed turn ended',
    );

    const replayed: Collected = [];
    await manager.subscribe(threadId, 0, collector(replayed));
    expect(replayed.map((e) => e.seq)).toEqual(replayed.map((_, i) => i));
    const userMessages = replayed
      .map((e) => e.event)
      .filter((e): e is Extract<ThreadEvent, { kind: 'user_message' }> => e.kind === 'user_message')
      .map((e) => e.content);
    expect(userMessages).toEqual(['first message', 'second message']);
    expect(agentChunks(replayed)).toEqual([
      notedEcho(localDir, 'first message'),
      'echo:second message',
    ]);
    expect(manager.getInfo(threadId)?.availableCommands).toBeNull();

    await manager.closeThread(threadId);
  }, 45_000);

  test('resume via session/load: protocol replay is suppressed, not duplicated', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeResumableAgentEntry(localDir, 'fake-load', { FAKE_CAPS: 'load' });
    const manager = makeManager(contentDir, localDir);
    await manager.init();
    const threadId = await runOneTurn(manager, 'fake-load', 'first message');
    await manager.closeThread(threadId);

    const info = await manager.resumeThread(threadId, 'second message');
    expect(info.archived).toBe(false);
    await waitUntil(
      () =>
        manager.getInfo(threadId)?.status === 'ready' &&
        !(manager as unknown as { threads: Map<string, { turnActive: boolean }> }).threads.get(
          threadId,
        )?.turnActive,
      20_000,
      'resumed turn ended',
    );

    const replayed: Collected = [];
    await manager.subscribe(threadId, 0, collector(replayed));
    expect(agentChunks(replayed)).toEqual([
      notedEcho(localDir, 'first message'),
      'echo:second message',
    ]);
    expect(agentChunks(replayed)).not.toContain('old-user');
    expect(agentChunks(replayed)).not.toContain('old-agent');

    await manager.closeThread(threadId);
  }, 45_000);

  test('resume-unsupported: no capability, and expired sessions, both stay archived', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeResumableAgentEntry(localDir, 'fake-none', { FAKE_CAPS: '' });
    const manager = makeManager(contentDir, localDir);
    await manager.init();
    const threadId = await runOneTurn(manager, 'fake-none', 'first message');
    await manager.closeThread(threadId);

    await expect(manager.resumeThread(threadId, 'again')).rejects.toMatchObject({
      code: 'resume-unsupported',
    });
    expect(manager.getInfo(threadId)?.archived).toBe(true);

    writeResumableAgentEntry(localDir, 'fake-none', { FAKE_CAPS: 'load', FAIL_LOAD: '1' });
    await expect(manager.resumeThread(threadId, 'again')).rejects.toMatchObject({
      code: 'resume-unsupported',
    });
    expect(manager.getInfo(threadId)?.archived).toBe(true);
    const replayed: Collected = [];
    await manager.subscribe(threadId, 0, collector(replayed));
    expect(agentChunks(replayed)).toContain(notedEcho(localDir, 'first message'));
  }, 45_000);

  test('an agent that drops its resume capability retires the offer instead of repeating it', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeResumableAgentEntry(localDir, 'fake-flip', { FAKE_CAPS: 'resume' });
    const manager = makeManager(contentDir, localDir);
    await manager.init();
    const threadId = await runOneTurn(manager, 'fake-flip', 'first message');
    await manager.closeThread(threadId);
    expect(manager.getInfo(threadId)?.resumable).toBe(true);

    writeResumableAgentEntry(localDir, 'fake-flip', { FAKE_CAPS: '' });
    await expect(manager.resumeThread(threadId, 'again')).rejects.toMatchObject({
      code: 'resume-unsupported',
    });
    expect(manager.getInfo(threadId)?.archived).toBe(true);
    expect(manager.getInfo(threadId)?.resumable).toBe(false);

    const manager2 = makeManager(contentDir, localDir);
    await manager2.init();
    const rehydrated = manager2.listThreads().find((t) => t.threadId === threadId);
    expect(rehydrated?.resumable).toBe(false);
  }, 45_000);

  test('delete refuses live threads, removes archived ones and their files', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeResumableAgentEntry(localDir, 'fake-resume', { FAKE_CAPS: 'resume' });
    const manager = makeManager(contentDir, localDir);
    await manager.init();
    const threadId = await runOneTurn(manager, 'fake-resume', 'to be deleted');

    await expect(manager.deleteThread(threadId)).rejects.toMatchObject({ code: 'not-ready' });

    await manager.closeThread(threadId);
    const threadsDir = join(localDir, 'threads');
    expect(existsSync(join(threadsDir, `${threadId}.ndjson`))).toBe(true);
    expect(existsSync(join(threadsDir, `${threadId}.meta.json`))).toBe(true);

    await manager.deleteThread(threadId);
    expect(manager.listThreads()).toHaveLength(0);
    expect(existsSync(join(threadsDir, `${threadId}.ndjson`))).toBe(false);
    expect(existsSync(join(threadsDir, `${threadId}.meta.json`))).toBe(false);
  }, 45_000);

  test('destroy() archives running threads; a new manager can resume them', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeResumableAgentEntry(localDir, 'fake-resume', { FAKE_CAPS: 'resume' });
    const manager = makeManager(contentDir, localDir);
    await manager.init();
    const threadId = await runOneTurn(manager, 'fake-resume', 'survives shutdown');
    await manager.destroy();

    const manager2 = makeManager(contentDir, localDir);
    await manager2.init();
    const rehydrated = manager2.listThreads().find((t) => t.threadId === threadId);
    expect(rehydrated?.archived).toBe(true);

    const info = await manager2.resumeThread(threadId, 'and continues');
    expect(info.archived).toBe(false);
    await waitUntil(
      () => manager2.getInfo(threadId)?.status === 'ready',
      15_000,
      'resumed after restart',
    );
    const replayed: Collected = [];
    await manager2.subscribe(threadId, 0, collector(replayed));
    expect(agentChunks(replayed)).toContain(notedEcho(localDir, 'survives shutdown'));
    await manager2.closeThread(threadId);
  }, 45_000);
});

describe('handleFsWrite exclusion gate', () => {
  test('non-markdown writes into ignored namespaces are rejected; plain asset writes land', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const manager = makeManager(contentDir, localDir, {
      isIgnoredPath: (rel) => rel.startsWith('.ok/') || rel.startsWith('.git/'),
    });
    const m = manager as unknown as {
      handleFsWrite: (record: unknown, path: string, content: string) => Promise<void>;
    };
    const record = { info: { lastActivityAt: 0 } };

    await expect(
      m.handleFsWrite(record, join(contentDir, '.ok', 'local', 'acp-agents.json'), '[]'),
    ).rejects.toThrow(/excluded from the project content scope/);
    await expect(
      m.handleFsWrite(record, join(contentDir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh'),
    ).rejects.toThrow(/excluded from the project content scope/);

    await m.handleFsWrite(record, join(contentDir, 'assets', 'note.txt'), 'hi');
    expect(readFileSync(join(contentDir, 'assets', 'note.txt'), 'utf8')).toBe('hi');
  });
});

describe('handleFsWrite concurrent replace guard', () => {
  test('returns one small ACP error and keeps the peer content', async () => {
    const contentDir = tmp();
    const docs = new Map<string, Y.Doc>();
    const sessionManager = {
      getSession: async (docName: string, agentId: string) => {
        let document = docs.get(docName);
        if (document === undefined) {
          document = new Y.Doc();
          Object.assign(document, { name: docName });
          docs.set(docName, document);
        }
        return { dc: { document }, origin: { agentId }, agentId, docName };
      },
      closeAllForAgent: async () => {},
    } as unknown as AgentSessionManager;
    const manager = makeManager(contentDir, tmp(), { sessionManager });
    const fsWrite = (
      manager as unknown as {
        handleFsWrite: (record: unknown, path: string, content: string) => Promise<void>;
      }
    ).handleFsWrite.bind(manager);
    const path = join(contentDir, 'notes', 'shared.md');
    const record = (agentSessionId: string) => ({
      agentSessionId,
      info: { lastActivityAt: 0, agent: { id: 'codex', name: agentSessionId } },
    });

    await fsWrite(record('agent-a'), path, '# From A\n');
    const before = docs.get('notes/shared')?.getText('source').toString();
    const error = await fsWrite(record('agent-b'), path, '# From B\n').then(
      () => undefined,
      (reason: unknown) => reason as { code?: number; message?: string; data?: unknown },
    );

    expect(error?.code).toBe(-32009);
    expect(error?.message).toBe(
      'Another writer changed this document recently. Wait a few seconds and retry.',
    );
    expect(error?.data).toEqual({
      type: 'urn:ok:error:concurrent-overwrite-refused',
      file: 'notes/shared.md',
      retryable: true,
      retryAfterSeconds: 3,
    });
    expect(docs.get('notes/shared')?.getText('source').toString()).toBe(before);
  });
});

function writeRequestingAgentEntry(localDir: string, id: string, promptBody: string): void {
  const agentPath = join(localDir, `${id}.mjs`);
  writeFileSync(
    agentPath,
    `
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
let nextId = 1000;
const pending = new Map();
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    write({ jsonrpc: '2.0', id, method, params: { sessionId: 'sess-1', ...params } });
  });
const notify = (update) =>
  write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update } });
let clientCaps = {};
let cancelled = false;
async function handlePrompt(msg) {
  cancelled = false;
  const finish = () => write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  const finishCancelled = () =>
    write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'cancelled' } });
${promptBody}
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    if (msg.method === undefined && msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      continue;
    }
    const reply = (result) => write({ jsonrpc: '2.0', id: msg.id, result });
    if (msg.method === 'initialize') {
      clientCaps = (msg.params && msg.params.clientCapabilities) || {};
      reply({ protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      reply({ sessionId: 'sess-1' });
    } else if (msg.method === 'session/cancel') {
      // A notification, so no reply — the prompt loop is what reads the flag.
      cancelled = true;
    } else if (msg.method === 'session/prompt') {
      handlePrompt(msg).catch((err) => {
        notify({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'agent-error:' + err.message },
        });
        write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      });
    } else if (msg.id !== undefined) {
      reply({});
    }
  }
});
`,
  );
  writeFileSync(
    join(localDir, 'acp-agents.json'),
    JSON.stringify([{ id, name: `Fake ${id}`, command: 'node', args: [agentPath] }]),
  );
}

describe('AcpThreadManager terminals + permission effects', () => {
  type Collected = Array<{ seq: number; event: ThreadEvent }>;
  const collect = (into: Collected) => (frame: ThreadServerFrame) => {
    if (frame.op === 'event') into.push({ seq: frame.seq, event: frame.event });
    if (frame.op === 'events') {
      for (const [i, event] of frame.events.entries()) {
        into.push({ seq: frame.fromSeq + i, event });
      }
    }
  };
  const agentText = (events: Collected): string =>
    events
      .map((e) => e.event)
      .filter((e) => e.kind === 'session_update')
      .map((e) => {
        const update = (e as { update?: { sessionUpdate?: string; content?: { text?: string } } })
          .update;
        return update?.sessionUpdate === 'agent_message_chunk' ? (update.content?.text ?? '') : '';
      })
      .join('');

  test('terminal round-trip: agent runs a command through OK and reads its output back', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeRequestingAgentEntry(
      localDir,
      'terminal-agent',
      `
  notify({
    sessionUpdate: 'agent_message_chunk',
    content: {
      type: 'text',
      text:
        'terminal-cap:' + String(clientCaps.terminal === true) +
        ';boolean-config-cap:' +
        String(clientCaps.session?.configOptions?.boolean != null) +
        ';',
    },
  });
  const { terminalId } = await request('terminal/create', {
    command: process.execPath,
    args: ['-e', "process.stdout.write('terminal says hi')"],
  });
  notify({
    sessionUpdate: 'tool_call',
    toolCallId: 'tc1',
    title: 'Run greeting',
    kind: 'execute',
    status: 'in_progress',
    content: [{ type: 'terminal', terminalId }],
  });
  const exit = await request('terminal/wait_for_exit', { terminalId });
  const out = await request('terminal/output', { terminalId });
  await request('terminal/release', { terminalId });
  notify({ sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed' });
  notify({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'observed:' + out.output + ';exit=' + String(exit.exitCode) },
  });
  finish();
`,
    );
    const manager = makeManager(contentDir, localDir);
    const info = await manager.createThread({ agent: { source: 'custom', id: 'terminal-agent' } });
    const events: Collected = [];
    await manager.subscribe(info.threadId, 0, collect(events));
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    manager.sendPrompt(info.threadId, 'run the greeting');
    await waitUntil(
      () => events.some((e) => e.event.kind === 'turn_ended'),
      20_000,
      `turn end; got ${JSON.stringify(events.map((e) => e.event.kind))}`,
    );

    const text = agentText(events);
    expect(text).toContain('terminal-cap:true;');
    expect(text).toContain('boolean-config-cap:true;');
    expect(text).toContain('observed:terminal says hi;exit=0');

    const created = events.find((e) => e.event.kind === 'terminal_created')?.event;
    if (created?.kind !== 'terminal_created') throw new Error('no terminal_created event');
    expect(created.command).toContain('node');
    const chunks = events
      .map((e) => e.event)
      .filter(
        (e): e is Extract<ThreadEvent, { kind: 'terminal_output' }> => e.kind === 'terminal_output',
      );
    expect(chunks.map((c) => c.chunk).join('')).toContain('terminal says hi');
    const exited = events.find((e) => e.event.kind === 'terminal_exit')?.event;
    if (exited?.kind !== 'terminal_exit') throw new Error('no terminal_exit event');
    expect(exited.exitCode).toBe(0);

    await manager.closeThread(info.threadId);
  }, 45_000);

  function writePlantingAgentEntry(localDir: string): void {
    writeRequestingAgentEntry(
      localDir,
      'planting-agent',
      `
  const response = await request('session/request_permission', {
    toolCall: { toolCallId: 'w1', title: 'Write planted.txt', kind: 'edit' },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  });
  const outcome = response.outcome;
  if (outcome.outcome === 'selected' && outcome.optionId === 'allow') {
    const { join } = await import('node:path');
    await request('fs/write_text_file', {
      path: join(process.cwd(), 'planted.txt'),
      content: 'planted by approval',
    });
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'outcome:allowed' } });
  } else {
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'outcome:' + outcome.outcome } });
  }
  finish();
`,
    );
  }

  function writeOkToolAgentEntry(localDir: string): void {
    writeRequestingAgentEntry(
      localDir,
      'ok-tool-agent',
      `
  const response = await request('session/request_permission', {
    toolCall: {
      toolCallId: 'ok1',
      title: 'mcp__open-knowledge__search',
      kind: 'other',
      rawInput: { query: 'permission' },
    },
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ],
  });
  const outcome = response.outcome;
  notify({
    sessionUpdate: 'agent_message_chunk',
    content: {
      type: 'text',
      text: 'ok-tool:' + (outcome.outcome === 'selected' ? outcome.optionId : outcome.outcome) + ';',
    },
  });
  finish();
`,
    );
  }

  test('agents.autoApproveOkTools in the user config decides whether an OK tool call asks', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const home = tmp();
    writeOkToolAgentEntry(localDir);
    const manager = makeManager(contentDir, localDir, {
      autoApproveOkTools: () => readAutoApproveOkTools(contentDir, home),
    });
    const info = await manager.createThread({ agent: { source: 'custom', id: 'ok-tool-agent' } });
    const events: Collected = [];
    await manager.subscribe(info.threadId, 0, collect(events));
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');
    const requests = () => events.filter((e) => e.event.kind === 'permission_request');
    const autoApprovals = () =>
      events.filter(
        (e) => e.event.kind === 'permission_resolved' && e.event.auto && e.event.optionId !== null,
      );
    const turnsEnded = () => events.filter((e) => e.event.kind === 'turn_ended').length;

    mkdirSync(join(home, '.ok'), { recursive: true });
    writeFileSync(join(home, '.ok', 'global.yml'), 'agents:\n  autoApproveOkTools: false\n');
    manager.sendPrompt(info.threadId, 'search');
    await waitUntil(() => requests().length === 1, 20_000, 'a prompt while the setting is off');
    const request = requests()[0]?.event;
    if (request?.kind !== 'permission_request') throw new Error('unreachable');
    manager.respondPermission(info.threadId, request.requestId, {
      kind: 'selected',
      optionId: 'allow',
    });
    await waitUntil(() => turnsEnded() === 1, 20_000, 'first turn end');
    expect(autoApprovals()).toHaveLength(0);

    rmSync(join(home, '.ok', 'global.yml'), { force: true });
    manager.sendPrompt(info.threadId, 'search again');
    await waitUntil(() => turnsEnded() === 2, 20_000, 'second turn end');
    expect(requests()).toHaveLength(1);
    expect(autoApprovals()).toHaveLength(1);
    expect(agentText(events)).toContain('ok-tool:allow;ok-tool:allow;');

    await manager.closeThread(info.threadId);
  }, 60_000);

  function writeShellProbingAgentEntry(localDir: string): void {
    writeRequestingAgentEntry(
      localDir,
      'shell-probing-agent',
      `
  const outcomes = [];
  for (const command of ['ls -la', 'rm -rf scratch']) {
    const response = await request('session/request_permission', {
      toolCall: {
        toolCallId: 'sh' + outcomes.length,
        title: 'Run ' + command,
        kind: 'execute',
        rawInput: { command },
      },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const outcome = response.outcome;
    outcomes.push(outcome.outcome === 'selected' ? outcome.optionId : outcome.outcome);
  }
  notify({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'outcomes:' + outcomes.join(',') + ';' },
  });
  finish();
`,
    );
  }

  test('the read-only shell grant approves read-only commands for the rest of the chat, and only those', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeShellProbingAgentEntry(localDir);
    const manager = makeManager(contentDir, localDir);
    const info = await manager.createThread({
      agent: { source: 'custom', id: 'shell-probing-agent' },
    });
    const events: Collected = [];
    await manager.subscribe(info.threadId, 0, collect(events));
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');
    const requests = () =>
      events
        .map((e) => e.event)
        .filter(
          (e): e is Extract<ThreadEvent, { kind: 'permission_request' }> =>
            e.kind === 'permission_request',
        );
    const turnsEnded = () => events.filter((e) => e.event.kind === 'turn_ended').length;
    const answer = (requestId: string, optionId: string) =>
      manager.respondPermission(info.threadId, requestId, { kind: 'selected', optionId });

    manager.sendPrompt(info.threadId, 'probe');
    await waitUntil(() => requests().length === 1, 20_000, 'first request');
    const first = requests()[0];
    if (first === undefined) throw new Error('unreachable');
    expect(first.toolCall.title).toBe('Run ls -la');
    expect(first.readOnlyShell).toBe(true);
    manager.setChatGrant(info.threadId, 'read_only_shell', true);
    expect(manager.getInfo(info.threadId)?.chatGrants).toEqual(['read_only_shell']);
    answer(first.requestId, 'allow');
    await waitUntil(() => requests().length === 2, 20_000, 'second request');
    const second = requests()[1];
    if (second === undefined) throw new Error('unreachable');
    expect(second.toolCall.title).toBe('Run rm -rf scratch');
    expect(second.readOnlyShell).toBeUndefined();
    answer(second.requestId, 'reject');
    await waitUntil(() => turnsEnded() === 1, 20_000, 'first turn end');
    expect(agentText(events)).toContain('outcomes:allow,reject;');

    manager.sendPrompt(info.threadId, 'probe again');
    await waitUntil(() => requests().length === 3, 20_000, 'third request');
    const third = requests()[2];
    if (third === undefined) throw new Error('unreachable');
    expect(third.toolCall.title).toBe('Run rm -rf scratch');
    const autoResolved = events
      .map((e) => e.event)
      .filter((e) => e.kind === 'permission_resolved' && e.auto && e.optionId === 'allow');
    expect(autoResolved).toHaveLength(1);
    answer(third.requestId, 'allow');
    await waitUntil(() => turnsEnded() === 2, 20_000, 'second turn end');
    expect(agentText(events)).toContain('outcomes:allow,allow;');

    manager.setChatGrant(info.threadId, 'read_only_shell', false);
    expect(manager.getInfo(info.threadId)?.chatGrants).toBeUndefined();
    manager.sendPrompt(info.threadId, 'probe once more');
    await waitUntil(() => requests().length === 4, 20_000, 'fourth request');
    const fourth = requests()[3];
    if (fourth === undefined) throw new Error('unreachable');
    expect(fourth.toolCall.title).toBe('Run ls -la');
    expect(fourth.readOnlyShell).toBe(true);
    answer(fourth.requestId, 'reject');
    await waitUntil(() => requests().length === 5, 20_000, 'fifth request');
    const fifth = requests()[4];
    if (fifth === undefined) throw new Error('unreachable');
    answer(fifth.requestId, 'reject');
    await waitUntil(() => turnsEnded() === 3, 20_000, 'third turn end');
    expect(agentText(events)).toContain('outcomes:reject,reject;');

    await manager.closeThread(info.threadId);
  }, 60_000);

  test('approve → the planted file EXISTS; status parks on awaiting_permission meanwhile', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writePlantingAgentEntry(localDir);
    const manager = makeManager(contentDir, localDir);
    const info = await manager.createThread({ agent: { source: 'custom', id: 'planting-agent' } });
    const events: Collected = [];
    await manager.subscribe(info.threadId, 0, collect(events));
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    manager.sendPrompt(info.threadId, 'plant the file');
    await waitUntil(
      () => events.some((e) => e.event.kind === 'permission_request'),
      20_000,
      'permission request',
    );
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'awaiting_permission',
      5_000,
      'awaiting_permission status',
    );
    expect(existsSync(join(contentDir, 'planted.txt'))).toBe(false);

    const request = events.find((e) => e.event.kind === 'permission_request')?.event;
    if (request?.kind !== 'permission_request') throw new Error('unreachable');
    manager.respondPermission(info.threadId, request.requestId, {
      kind: 'selected',
      optionId: 'allow',
    });

    await waitUntil(() => events.some((e) => e.event.kind === 'turn_ended'), 20_000, 'turn end');
    await waitUntil(() => existsSync(join(contentDir, 'planted.txt')), 5_000, 'planted file');
    expect(readFileSync(join(contentDir, 'planted.txt'), 'utf8')).toBe('planted by approval');
    expect(agentText(events)).toContain('outcome:allowed');
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 5_000, 'ready again');

    await manager.closeThread(info.threadId);
  }, 45_000);

  test('deny (cancelled outcome) → the planted file is ABSENT and the turn still completes', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writePlantingAgentEntry(localDir);
    const manager = makeManager(contentDir, localDir);
    const info = await manager.createThread({ agent: { source: 'custom', id: 'planting-agent' } });
    const events: Collected = [];
    await manager.subscribe(info.threadId, 0, collect(events));
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    manager.sendPrompt(info.threadId, 'plant the file');
    await waitUntil(
      () => events.some((e) => e.event.kind === 'permission_request'),
      20_000,
      'permission request',
    );
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'awaiting_permission',
      5_000,
      'awaiting_permission status',
    );

    const request = events.find((e) => e.event.kind === 'permission_request')?.event;
    if (request?.kind !== 'permission_request') throw new Error('unreachable');
    manager.respondPermission(info.threadId, request.requestId, { kind: 'cancelled' });

    await waitUntil(() => events.some((e) => e.event.kind === 'turn_ended'), 20_000, 'turn end');
    expect(existsSync(join(contentDir, 'planted.txt'))).toBe(false);
    expect(agentText(events)).toContain('outcome:cancelled');
    const resolution = events.find((e) => e.event.kind === 'permission_resolved')?.event;
    if (resolution?.kind !== 'permission_resolved') throw new Error('unreachable');
    expect(resolution.optionId).toBeNull();
    expect(resolution.auto).toBe(false);
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 5_000, 'ready again');

    await manager.closeThread(info.threadId);
  }, 45_000);
});

function writeCascadingConfigAgent(localDir: string): void {
  const agentPath = join(localDir, 'cascade-agent.mjs');
  writeFileSync(
    agentPath,
    `
let model = 'sonnet';
let thought = 'med';
const thoughtOptions = () =>
  model === 'opus'
    ? [{ value: 'low', name: 'Low' }, { value: 'med', name: 'Med' }, { value: 'high', name: 'High' }, { value: 'xhigh', name: 'XHigh' }]
    : [{ value: 'low', name: 'Low' }, { value: 'med', name: 'Med' }];
const configOptions = () => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model,
    options: [{ value: 'sonnet', name: 'Sonnet' }, { value: 'opus', name: 'Opus' }] },
  { id: 'thought_level', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: thought,
    options: thoughtOptions() },
];
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    const reply = (result) =>
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    if (msg.method === 'initialize') {
      reply({ protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      reply({ sessionId: 's1', configOptions: configOptions() });
    } else if (msg.method === 'session/set_config_option') {
      const { configId, value } = msg.params;
      if (configId === 'model') model = value;
      else if (configId === 'thought_level' && thoughtOptions().some((o) => o.value === value)) thought = value;
      reply({ configOptions: configOptions() });
    } else if (msg.method === 'session/prompt') {
      reply({ stopReason: 'end_turn' });
    } else if (msg.id !== undefined) {
      reply({});
    }
  }
});
`,
  );
  writeFileSync(
    join(localDir, 'acp-agents.json'),
    JSON.stringify([
      { id: 'cascade-agent', name: 'Cascade Agent', command: 'node', args: [agentPath] },
    ]),
  );
}

function writeLegacyModeAgent(localDir: string): void {
  const agentPath = join(localDir, 'mode-agent.mjs');
  writeFileSync(
    agentPath,
    `
let current = 'default';
const modes = () => ({ currentModeId: current, availableModes: [
  { id: 'default', name: 'Default' },
  { id: 'plan', name: 'Plan' },
  { id: 'bypass', name: 'Bypass permissions' },
] });
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    const reply = (result) =>
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    if (msg.method === 'initialize') {
      reply({ protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      reply({ sessionId: 's1', modes: modes() });
    } else if (msg.method === 'session/set_mode') {
      current = msg.params.modeId;
      reply({});
    } else if (msg.method === 'session/prompt') {
      reply({ stopReason: 'end_turn' });
    } else if (msg.id !== undefined) {
      reply({});
    }
  }
});
`,
  );
  writeFileSync(
    join(localDir, 'acp-agents.json'),
    JSON.stringify([{ id: 'mode-agent', name: 'Mode Agent', command: 'node', args: [agentPath] }]),
  );
}

function writeConfigModeAgent(localDir: string): void {
  const agentPath = join(localDir, 'config-mode-agent.mjs');
  writeFileSync(
    agentPath,
    `
let mode = 'default';
const configOptions = () => [
  { id: 'permission', name: 'Permission mode', category: 'mode', type: 'select', currentValue: mode,
    options: [{ value: 'default', name: 'Default' }, { value: 'bypass', name: 'Bypass permissions' }] },
];
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    const reply = (result) =>
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    if (msg.method === 'initialize') {
      reply({ protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      reply({ sessionId: 's1', configOptions: configOptions() });
    } else if (msg.method === 'session/set_config_option') {
      if (msg.params.configId === 'permission') mode = msg.params.value;
      reply({ configOptions: configOptions() });
    } else if (msg.method === 'session/prompt') {
      reply({ stopReason: 'end_turn' });
    } else if (msg.id !== undefined) {
      reply({});
    }
  }
});
`,
  );
  writeFileSync(
    join(localDir, 'acp-agents.json'),
    JSON.stringify([
      { id: 'config-mode-agent', name: 'Config Mode Agent', command: 'node', args: [agentPath] },
    ]),
  );
}

function writeRejectingModeAgent(localDir: string): void {
  const agentPath = join(localDir, 'reject-mode-agent.mjs');
  writeFileSync(
    agentPath,
    `
const modes = { currentModeId: 'default', availableModes: [
  { id: 'default', name: 'Default' },
  { id: 'bypass', name: 'Bypass permissions' },
] };
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    const reply = (result) =>
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    if (msg.method === 'initialize') {
      reply({ protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      reply({ sessionId: 's1', modes });
    } else if (msg.method === 'session/set_mode') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
        error: { code: -32000, message: 'mode change refused' } }) + '\\n');
    } else if (msg.method === 'session/prompt') {
      reply({ stopReason: 'end_turn' });
    } else if (msg.id !== undefined) {
      reply({});
    }
  }
});
`,
  );
  writeFileSync(
    join(localDir, 'acp-agents.json'),
    JSON.stringify([
      { id: 'reject-mode-agent', name: 'Reject Mode Agent', command: 'node', args: [agentPath] },
    ]),
  );
}

describe('AcpThreadManager initial mode apply', () => {
  test('restores an opted-in mode via session/set_mode before ready', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeLegacyModeAgent(localDir);
    const manager = makeManager(contentDir, localDir);

    const info = await manager.createThread({
      agent: { source: 'custom', id: 'mode-agent' },
      settings: { modeId: 'bypass' },
    });
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    expect(manager.getInfo(info.threadId)?.modes?.currentModeId).toBe('bypass');

    await manager.closeThread(info.threadId);
  }, 30_000);

  test('skips a remembered mode the session no longer advertises', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeLegacyModeAgent(localDir);
    const manager = makeManager(contentDir, localDir);

    const info = await manager.createThread({
      agent: { source: 'custom', id: 'mode-agent' },
      settings: { modeId: 'ghost' },
    });
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    expect(manager.getInfo(info.threadId)?.modes?.currentModeId).toBe('default');

    await manager.closeThread(info.threadId);
  }, 30_000);

  test('restores an opted-in mode exposed as a config option via set_config_option', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeConfigModeAgent(localDir);
    const manager = makeManager(contentDir, localDir);

    const info = await manager.createThread({
      agent: { source: 'custom', id: 'config-mode-agent' },
      settings: { modeId: 'bypass' },
    });
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    const opts = manager.getInfo(info.threadId)?.configOptions ?? [];
    expect(opts.find((o) => o.id === 'permission')?.currentValue).toBe('bypass');

    await manager.closeThread(info.threadId);
  }, 30_000);

  test('a rejected set_mode still reaches ready on the agent default', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeRejectingModeAgent(localDir);
    const manager = makeManager(contentDir, localDir);

    const info = await manager.createThread({
      agent: { source: 'custom', id: 'reject-mode-agent' },
      settings: { modeId: 'bypass' },
    });
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    expect(manager.getInfo(info.threadId)?.modes?.currentModeId).toBe('default');

    await manager.closeThread(info.threadId);
  }, 30_000);
});

describe('AcpThreadManager initial config apply', () => {
  test('applies remembered config before ready — model first, dependent option re-validated', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeCascadingConfigAgent(localDir);
    const manager = makeManager(contentDir, localDir);

    const info = await manager.createThread({
      agent: { source: 'custom', id: 'cascade-agent' },
      settings: { config: { thought_level: 'xhigh', model: 'opus', retired_option: 'gone' } },
    });
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    const opts = manager.getInfo(info.threadId)?.configOptions ?? [];
    expect(opts.find((o) => o.id === 'model')?.currentValue).toBe('opus');
    expect(opts.find((o) => o.id === 'thought_level')?.currentValue).toBe('xhigh');

    await manager.closeThread(info.threadId);
  }, 30_000);

  test('skips a remembered value the resolved options no longer offer', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeCascadingConfigAgent(localDir);
    const manager = makeManager(contentDir, localDir);

    const info = await manager.createThread({
      agent: { source: 'custom', id: 'cascade-agent' },
      settings: { config: { thought_level: 'xhigh' } },
    });
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    const opts = manager.getInfo(info.threadId)?.configOptions ?? [];
    expect(opts.find((o) => o.id === 'model')?.currentValue).toBe('sonnet');
    expect(opts.find((o) => o.id === 'thought_level')?.currentValue).toBe('med');

    await manager.closeThread(info.threadId);
  }, 30_000);
});

describe('AcpThreadManager prompt queueing', () => {
  type Collected = Array<{ seq: number; event: ThreadEvent }>;
  const collect = (into: Collected) => (frame: ThreadServerFrame) => {
    if (frame.op === 'event') into.push({ seq: frame.seq, event: frame.event });
    if (frame.op === 'events') {
      for (const [i, event] of frame.events.entries()) {
        into.push({ seq: frame.fromSeq + i, event });
      }
    }
  };
  const agentText = (events: Collected): string =>
    events
      .map((e) => e.event)
      .filter((e) => e.kind === 'session_update')
      .map((e) => {
        const update = (e as { update?: { sessionUpdate?: string; content?: { text?: string } } })
          .update;
        return update?.sessionUpdate === 'agent_message_chunk' ? (update.content?.text ?? '') : '';
      })
      .join('');
  const userMessages = (events: Collected): string[] =>
    events
      .map((e) => e.event)
      .filter((e): e is Extract<ThreadEvent, { kind: 'user_message' }> => e.kind === 'user_message')
      .map((e) => e.content);
  const stopReasons = (events: Collected): string[] =>
    events
      .map((e) => e.event)
      .filter((e): e is Extract<ThreadEvent, { kind: 'turn_ended' }> => e.kind === 'turn_ended')
      .map((e) => e.stopReason);

  function writeGateAgent(localDir: string, releasePath: string): void {
    writeRequestingAgentEntry(
      localDir,
      'gate-agent',
      `
  const text = (msg.params.prompt ?? []).map((b) => b.text ?? '').join('');
  notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ran:' + text + ';' } });
  if (text.includes('WAIT')) {
    const fs = await import('node:fs');
    while (!fs.existsSync(${JSON.stringify(releasePath)})) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  finish();
`,
    );
  }

  function writeCancelHonoringGateAgent(localDir: string, releasePath: string): void {
    writeRequestingAgentEntry(
      localDir,
      'steer-agent',
      `
  const text = (msg.params.prompt ?? []).map((b) => b.text ?? '').join('');
  notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ran:' + text + ';' } });
  if (text.includes('WAIT')) {
    const fs = await import('node:fs');
    while (!fs.existsSync(${JSON.stringify(releasePath)})) {
      if (cancelled) {
        finishCancelled();
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  finish();
`,
    );
  }

  test('mid-turn prompts queue, edit/remove target entries by id, and drain FIFO', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const releasePath = join(localDir, 'release-turn');
    writeGateAgent(localDir, releasePath);
    const manager = makeManager(contentDir, localDir);
    const info = await manager.createThread({ agent: { source: 'custom', id: 'gate-agent' } });
    const events: Collected = [];
    await manager.subscribe(info.threadId, 0, collect(events));
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    manager.sendPrompt(info.threadId, 'WAIT at the gate');
    await waitUntil(() => internals(manager).turnActive(info.threadId), 5_000, 'turn active');

    manager.sendPrompt(info.threadId, 'second draft');
    manager.sendPrompt(info.threadId, 'third');
    manager.sendPrompt(info.threadId, 'fourth');
    const queued = manager.getInfo(info.threadId)?.queue ?? [];
    expect(queued.map((m) => m.content)).toEqual(['second draft', 'third', 'fourth']);

    const head = queued[0];
    const middle = queued[1];
    if (head === undefined || middle === undefined) throw new Error('queue entries missing');
    manager.editQueued(info.threadId, head.id, 'second final');
    manager.removeQueued(info.threadId, middle.id);
    manager.editQueued(info.threadId, 'no-such-id', 'ignored');
    manager.removeQueued(info.threadId, 'no-such-id');
    expect((manager.getInfo(info.threadId)?.queue ?? []).map((m) => m.content)).toEqual([
      'second final',
      'fourth',
    ]);

    writeFileSync(releasePath, 'go');
    await waitUntil(
      () => events.filter((e) => e.event.kind === 'turn_ended').length === 3,
      20_000,
      `three turn ends; got ${JSON.stringify(events.map((e) => e.event.kind))}`,
    );
    expect(manager.getInfo(info.threadId)?.queue).toBeUndefined();
    expect(manager.getInfo(info.threadId)?.status).toBe('ready');

    const text = agentText(events);
    expect(text).toContain('ran:second final;');
    expect(text).toContain('ran:fourth;');
    expect(text).not.toContain('second draft');
    expect(text).not.toContain('ran:third;');
    expect(text.indexOf('ran:second final;')).toBeLessThan(text.indexOf('ran:fourth;'));

    expect(userMessages(events)).toEqual(['WAIT at the gate', 'second final', 'fourth']);

    await manager.closeThread(info.threadId);
  }, 40_000);

  test('a held entry sits out the drain, then dispatches the moment it is released', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const releasePath = join(localDir, 'release-turn');
    writeGateAgent(localDir, releasePath);
    const manager = makeManager(contentDir, localDir);
    const info = await manager.createThread({ agent: { source: 'custom', id: 'gate-agent' } });
    const events: Collected = [];
    await manager.subscribe(info.threadId, 0, collect(events));
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    manager.sendPrompt(info.threadId, 'WAIT at the gate');
    await waitUntil(() => internals(manager).turnActive(info.threadId), 5_000, 'turn active');

    manager.sendPrompt(info.threadId, 'being rewritten');
    manager.sendPrompt(info.threadId, 'ready to go');
    const head = (manager.getInfo(info.threadId)?.queue ?? [])[0];
    if (head === undefined) throw new Error('queue head missing');
    expect(manager.holdQueued(info.threadId, head.id, true)).toBe(true);
    expect(manager.holdQueued(info.threadId, 'no-such-id', true)).toBe(false);

    writeFileSync(releasePath, 'go');
    await waitUntil(
      () => events.filter((e) => e.event.kind === 'turn_ended').length === 2,
      20_000,
      `two turn ends; got ${JSON.stringify(events.map((e) => e.event.kind))}`,
    );
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'ready',
      20_000,
      `back to ready; got ${manager.getInfo(info.threadId)?.status}`,
    );
    expect(userMessages(events)).toEqual(['WAIT at the gate', 'ready to go']);
    const parked = manager.getInfo(info.threadId)?.queue ?? [];
    expect(parked.map((m) => m.content)).toEqual(['being rewritten']);
    expect(parked[0]?.held).toBe(true);

    expect(manager.holdQueued(info.threadId, head.id, false)).toBe(true);
    await waitUntil(
      () => events.filter((e) => e.event.kind === 'turn_ended').length === 3,
      20_000,
      `three turn ends; got ${JSON.stringify(events.map((e) => e.event.kind))}`,
    );
    expect(userMessages(events)).toEqual(['WAIT at the gate', 'ready to go', 'being rewritten']);
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'ready',
      20_000,
      'ready again',
    );
    expect(manager.getInfo(info.threadId)?.queue).toBeUndefined();

    await manager.closeThread(info.threadId);
  }, 40_000);

  test('saving an edit on a held entry releases it and sends the new text', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const releasePath = join(localDir, 'release-turn');
    writeGateAgent(localDir, releasePath);
    const manager = makeManager(contentDir, localDir);
    const info = await manager.createThread({ agent: { source: 'custom', id: 'gate-agent' } });
    const events: Collected = [];
    await manager.subscribe(info.threadId, 0, collect(events));
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    manager.sendPrompt(info.threadId, 'WAIT at the gate');
    await waitUntil(() => internals(manager).turnActive(info.threadId), 5_000, 'turn active');
    manager.sendPrompt(info.threadId, 'first draft');
    const entry = (manager.getInfo(info.threadId)?.queue ?? [])[0];
    if (entry === undefined) throw new Error('queue entry missing');
    manager.holdQueued(info.threadId, entry.id, true);

    writeFileSync(releasePath, 'go');
    await waitUntil(
      () => events.filter((e) => e.event.kind === 'turn_ended').length === 1,
      20_000,
      'the gated turn ends',
    );
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 20_000, 'ready');
    expect(userMessages(events)).toEqual(['WAIT at the gate']);
    expect(manager.getInfo(info.threadId)?.queue?.length).toBe(1);

    expect(manager.editQueued(info.threadId, entry.id, 'sharper draft')).toBe(true);
    await waitUntil(
      () => events.filter((e) => e.event.kind === 'turn_ended').length === 2,
      20_000,
      `two turn ends; got ${JSON.stringify(events.map((e) => e.event.kind))}`,
    );
    expect(userMessages(events)).toEqual(['WAIT at the gate', 'sharper draft']);
    expect(agentText(events)).toContain('ran:sharper draft;');
    expect(agentText(events)).not.toContain('first draft');
    expect(manager.getInfo(info.threadId)?.queue).toBeUndefined();

    expect(manager.editQueued(info.threadId, entry.id, 'too late')).toBe(false);
    expect(manager.editQueued(info.threadId, 'no-such-id', 'ignored')).toBe(false);

    await manager.closeThread(info.threadId);
  }, 40_000);

  test('cancel drops the whole queue; the cap rejects the overflow prompt', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const releasePath = join(localDir, 'release-turn');
    writeGateAgent(localDir, releasePath);
    const manager = makeManager(contentDir, localDir);
    const info = await manager.createThread({ agent: { source: 'custom', id: 'gate-agent' } });
    const events: Collected = [];
    await manager.subscribe(info.threadId, 0, collect(events));
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    manager.sendPrompt(info.threadId, 'WAIT for cancel');
    await waitUntil(() => internals(manager).turnActive(info.threadId), 5_000, 'turn active');

    for (let i = 0; i < MAX_QUEUED_PROMPTS; i += 1) {
      manager.sendPrompt(info.threadId, `queued ${i}`);
    }
    expect(manager.getInfo(info.threadId)?.queue?.length).toBe(MAX_QUEUED_PROMPTS);
    expect(() => manager.sendPrompt(info.threadId, 'one too many')).toThrow(/already waiting/);

    manager.cancel(info.threadId);
    expect(manager.getInfo(info.threadId)?.queue).toBeUndefined();

    writeFileSync(releasePath, 'go');
    await waitUntil(() => !internals(manager).turnActive(info.threadId), 10_000, 'turn ended');
    expect(manager.getInfo(info.threadId)?.queue).toBeUndefined();
    expect(userMessages(events)).toEqual(['WAIT for cancel']);

    await manager.closeThread(info.threadId);
  }, 40_000);

  test('a terminal status drops the queue — a dead agent keeps no phantom entries', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeGateAgent(localDir, join(localDir, 'release-turn'));
    const manager = makeManager(contentDir, localDir);
    const info = await manager.createThread({ agent: { source: 'custom', id: 'gate-agent' } });
    await manager.subscribe(info.threadId, 0, () => {});
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    manager.sendPrompt(info.threadId, 'WAIT at the gate');
    await waitUntil(() => internals(manager).turnActive(info.threadId), 5_000, 'turn active');
    manager.sendPrompt(info.threadId, 'never runs');
    expect(manager.getInfo(info.threadId)?.queue?.length).toBe(1);

    await manager.closeThread(info.threadId);
    expect(manager.getInfo(info.threadId)?.queue).toBeUndefined();
  }, 40_000);

  test('neither the queue nor a parked steer is persisted — a rehydrated thread comes back empty', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeGateAgent(localDir, join(localDir, 'release-turn'));
    const manager = makeManager(contentDir, localDir, { steerStallMs: 60_000 });
    await manager.init();
    const info = await manager.createThread({ agent: { source: 'custom', id: 'gate-agent' } });
    await manager.subscribe(info.threadId, 0, () => {});
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    manager.sendPrompt(info.threadId, 'WAIT at the gate');
    await waitUntil(() => internals(manager).turnActive(info.threadId), 5_000, 'turn active');
    manager.sendPrompt(info.threadId, 'queued while busy');
    expect(manager.getInfo(info.threadId)?.queue?.length).toBe(1);
    manager.steerPrompt(info.threadId, 'steered while busy');
    expect(manager.getInfo(info.threadId)?.steer?.content).toBe('steered while busy');

    await manager.closeThread(info.threadId);

    const manager2 = makeManager(contentDir, localDir);
    await manager2.init();
    expect(manager2.getInfo(info.threadId)).toBeDefined();
    expect(manager2.getInfo(info.threadId)?.queue).toBeUndefined();
    expect(manager2.getInfo(info.threadId)?.steer).toBeUndefined();
  }, 40_000);

  test('the read-only shell grant is not persisted, so a rehydrated thread asks again', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeGateAgent(localDir, join(localDir, 'release-turn'));
    const manager = makeManager(contentDir, localDir);
    await manager.init();
    const info = await manager.createThread({ agent: { source: 'custom', id: 'gate-agent' } });
    await manager.subscribe(info.threadId, 0, () => {});
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    manager.sendPrompt(info.threadId, 'WAIT at the gate');
    await waitUntil(() => internals(manager).turnActive(info.threadId), 5_000, 'turn active');
    manager.setChatGrant(info.threadId, 'read_only_shell', true);
    expect(manager.getInfo(info.threadId)?.chatGrants).toEqual(['read_only_shell']);
    await manager.closeThread(info.threadId);

    const findMeta = (): string | undefined =>
      readdirSync(localDir, { recursive: true })
        .map(String)
        .find((entry) => entry.endsWith(`${info.threadId}.meta.json`));
    await waitUntil(() => findMeta() !== undefined, 5_000, 'persisted meta');
    const metaFile = findMeta();
    if (metaFile === undefined) throw new Error('unreachable');
    expect(readFileSync(join(localDir, metaFile), 'utf8')).not.toContain('chatGrants');

    const manager2 = makeManager(contentDir, localDir);
    await manager2.init();
    expect(manager2.getInfo(info.threadId)).toBeDefined();
    expect(manager2.getInfo(info.threadId)?.chatGrants).toBeUndefined();
  }, 40_000);

  test('a steer stops the run, goes first, and lets the queue drain behind it', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const releasePath = join(localDir, 'release-turn');
    writeCancelHonoringGateAgent(localDir, releasePath);
    const manager = makeManager(contentDir, localDir);
    const info = await manager.createThread({ agent: { source: 'custom', id: 'steer-agent' } });
    const events: Collected = [];
    await manager.subscribe(info.threadId, 0, collect(events));
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    manager.sendPrompt(info.threadId, 'WAIT at the gate');
    await waitUntil(() => internals(manager).turnActive(info.threadId), 5_000, 'turn active');
    manager.sendPrompt(info.threadId, 'queued before the steer');

    manager.steerPrompt(info.threadId, 'do this instead');
    expect(manager.getInfo(info.threadId)?.steer?.content).toBe('do this instead');
    expect((manager.getInfo(info.threadId)?.queue ?? []).map((m) => m.content)).toEqual([
      'queued before the steer',
    ]);

    await waitUntil(
      () => events.filter((e) => e.event.kind === 'turn_ended').length === 3,
      20_000,
      `three turn ends; got ${JSON.stringify(events.map((e) => e.event.kind))}`,
    );

    expect(stopReasons(events)[0]).toBe('cancelled');
    expect(userMessages(events)).toEqual([
      'WAIT at the gate',
      'do this instead',
      'queued before the steer',
    ]);
    const text = agentText(events);
    expect(text.indexOf('ran:do this instead;')).toBeLessThan(
      text.indexOf('ran:queued before the steer;'),
    );
    expect(manager.getInfo(info.threadId)?.steer).toBeUndefined();
    expect(manager.getInfo(info.threadId)?.queue).toBeUndefined();
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'ready',
      10_000,
      'ready after the drain',
    );

    await manager.closeThread(info.threadId);
  }, 40_000);

  test('an ignored cancel demotes the steer to the front of the queue', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const releasePath = join(localDir, 'release-turn');
    writeGateAgent(localDir, releasePath);
    const manager = makeManager(contentDir, localDir, { steerStallMs: 200 });
    const info = await manager.createThread({ agent: { source: 'custom', id: 'gate-agent' } });
    const events: Collected = [];
    await manager.subscribe(info.threadId, 0, collect(events));
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    manager.sendPrompt(info.threadId, 'WAIT at the gate');
    await waitUntil(() => internals(manager).turnActive(info.threadId), 5_000, 'turn active');
    manager.sendPrompt(info.threadId, 'queued first');

    manager.steerPrompt(info.threadId, 'could not interrupt');
    expect(manager.getInfo(info.threadId)?.steer?.content).toBe('could not interrupt');

    await waitUntil(
      () => manager.getInfo(info.threadId)?.steer === undefined,
      5_000,
      'steer demoted',
    );
    expect((manager.getInfo(info.threadId)?.queue ?? []).map((m) => m.content)).toEqual([
      'could not interrupt',
      'queued first',
    ]);

    writeFileSync(releasePath, 'go');
    await waitUntil(
      () => events.filter((e) => e.event.kind === 'turn_ended').length === 3,
      20_000,
      `three turn ends; got ${JSON.stringify(events.map((e) => e.event.kind))}`,
    );
    expect(userMessages(events)).toEqual([
      'WAIT at the gate',
      'could not interrupt',
      'queued first',
    ]);

    await manager.closeThread(info.threadId);
  }, 40_000);

  function writeCancelRejectingGateAgent(localDir: string, releasePath: string): void {
    writeRequestingAgentEntry(
      localDir,
      'rejecting-agent',
      `
  const text = (msg.params.prompt ?? []).map((b) => b.text ?? '').join('');
  notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ran:' + text + ';' } });
  if (text.includes('WAIT')) {
    const fs = await import('node:fs');
    while (!fs.existsSync(${JSON.stringify(releasePath)})) {
      await new Promise((r) => setTimeout(r, 20));
    }
    write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'prompt aborted' } });
    return;
  }
  finish();
`,
    );
  }

  test('a stall-demoted steer still drains when the agent answers the cancel by rejecting', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const releasePath = join(localDir, 'release-turn');
    writeCancelRejectingGateAgent(localDir, releasePath);
    const manager = makeManager(contentDir, localDir, { steerStallMs: 200 });
    const info = await manager.createThread({ agent: { source: 'custom', id: 'rejecting-agent' } });
    const events: Collected = [];
    await manager.subscribe(info.threadId, 0, collect(events));
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    manager.sendPrompt(info.threadId, 'WAIT at the gate');
    await waitUntil(() => internals(manager).turnActive(info.threadId), 5_000, 'turn active');

    manager.steerPrompt(info.threadId, 'demoted correction');
    await waitUntil(
      () => manager.getInfo(info.threadId)?.steer === undefined,
      5_000,
      'the steer to demote to the queue',
    );
    expect((manager.getInfo(info.threadId)?.queue ?? []).map((m) => m.content)).toEqual([
      'demoted correction',
    ]);

    writeFileSync(releasePath, 'go');
    await waitUntil(
      () => events.filter((e) => e.event.kind === 'turn_ended').length === 2,
      20_000,
      `two turn ends; got ${JSON.stringify(events.map((e) => e.event.kind))}`,
    );
    expect(userMessages(events)).toEqual(['WAIT at the gate', 'demoted correction']);
    expect(agentText(events)).toContain('ran:demoted correction;');
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'ready',
      10_000,
      'ready after the drain',
    );
    expect(manager.getInfo(info.threadId)?.queue).toBeUndefined();

    await manager.closeThread(info.threadId);
  }, 40_000);

  test('Stop clears a parked steer along with the queue', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const releasePath = join(localDir, 'release-turn');
    writeGateAgent(localDir, releasePath);
    const manager = makeManager(contentDir, localDir, { steerStallMs: 60_000 });
    const info = await manager.createThread({ agent: { source: 'custom', id: 'gate-agent' } });
    const events: Collected = [];
    await manager.subscribe(info.threadId, 0, collect(events));
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    manager.sendPrompt(info.threadId, 'WAIT for cancel');
    await waitUntil(() => internals(manager).turnActive(info.threadId), 5_000, 'turn active');
    manager.sendPrompt(info.threadId, 'queued behind');
    manager.steerPrompt(info.threadId, 'never mind, do this');
    expect(manager.getInfo(info.threadId)?.steer).toBeDefined();

    manager.cancel(info.threadId);
    expect(manager.getInfo(info.threadId)?.steer).toBeUndefined();
    expect(manager.getInfo(info.threadId)?.queue).toBeUndefined();

    writeFileSync(releasePath, 'go');
    await waitUntil(() => !internals(manager).turnActive(info.threadId), 10_000, 'turn ended');
    expect(userMessages(events)).toEqual(['WAIT for cancel']);

    await manager.closeThread(info.threadId);
  }, 40_000);

  test('a steer with no turn running is just a send', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeGateAgent(localDir, join(localDir, 'release-turn'));
    const manager = makeManager(contentDir, localDir);
    const info = await manager.createThread({ agent: { source: 'custom', id: 'gate-agent' } });
    const events: Collected = [];
    await manager.subscribe(info.threadId, 0, collect(events));
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    manager.steerPrompt(info.threadId, 'nothing to interrupt');
    await waitUntil(
      () => events.filter((e) => e.event.kind === 'turn_ended').length === 1,
      20_000,
      'turn ended',
    );
    expect(manager.getInfo(info.threadId)?.steer).toBeUndefined();
    expect(userMessages(events)).toEqual(['nothing to interrupt']);
    expect(stopReasons(events)).toEqual(['end_turn']);

    await manager.closeThread(info.threadId);
  }, 40_000);

  test('Send now pulls a queued entry out of line and steers with it', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const releasePath = join(localDir, 'release-turn');
    writeCancelHonoringGateAgent(localDir, releasePath);
    const manager = makeManager(contentDir, localDir);
    const info = await manager.createThread({ agent: { source: 'custom', id: 'steer-agent' } });
    const events: Collected = [];
    await manager.subscribe(info.threadId, 0, collect(events));
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    manager.sendPrompt(info.threadId, 'WAIT at the gate');
    await waitUntil(() => internals(manager).turnActive(info.threadId), 5_000, 'turn active');
    manager.sendPrompt(info.threadId, 'patient one');
    manager.sendPrompt(info.threadId, 'jump the line');
    const target = (manager.getInfo(info.threadId)?.queue ?? [])[1];
    if (target === undefined) throw new Error('queue entry missing');

    expect(manager.sendQueuedNow(info.threadId, 'no-such-id')).toBe(false);
    expect(manager.sendQueuedNow(info.threadId, target.id)).toBe(true);
    expect(manager.getInfo(info.threadId)?.steer?.content).toBe('jump the line');
    expect((manager.getInfo(info.threadId)?.queue ?? []).map((m) => m.content)).toEqual([
      'patient one',
    ]);

    await waitUntil(
      () => events.filter((e) => e.event.kind === 'turn_ended').length === 3,
      20_000,
      `three turn ends; got ${JSON.stringify(events.map((e) => e.event.kind))}`,
    );
    expect(stopReasons(events)[0]).toBe('cancelled');
    expect(userMessages(events)).toEqual(['WAIT at the gate', 'jump the line', 'patient one']);
    expect(manager.getInfo(info.threadId)?.steer).toBeUndefined();
    expect(manager.getInfo(info.threadId)?.queue).toBeUndefined();

    await manager.closeThread(info.threadId);
  }, 40_000);

  test('Send now ahead of a parked steer keeps that steer first in line, not dropped', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const releasePath = join(localDir, 'release-turn');
    writeGateAgent(localDir, releasePath);
    const manager = makeManager(contentDir, localDir, { steerStallMs: 60_000 });
    const info = await manager.createThread({ agent: { source: 'custom', id: 'gate-agent' } });
    const events: Collected = [];
    await manager.subscribe(info.threadId, 0, collect(events));
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    manager.sendPrompt(info.threadId, 'WAIT at the gate');
    await waitUntil(() => internals(manager).turnActive(info.threadId), 5_000, 'turn active');
    manager.sendPrompt(info.threadId, 'queued first');
    manager.steerPrompt(info.threadId, 'could not interrupt');
    const queued = (manager.getInfo(info.threadId)?.queue ?? [])[0];
    if (queued === undefined) throw new Error('queue entry missing');

    expect(manager.sendQueuedNow(info.threadId, queued.id)).toBe(true);
    expect(manager.getInfo(info.threadId)?.steer?.content).toBe('queued first');
    expect((manager.getInfo(info.threadId)?.queue ?? []).map((m) => m.content)).toEqual([
      'could not interrupt',
    ]);

    writeFileSync(releasePath, 'go');
    await waitUntil(
      () => events.filter((e) => e.event.kind === 'turn_ended').length === 3,
      20_000,
      `three turn ends; got ${JSON.stringify(events.map((e) => e.event.kind))}`,
    );
    expect(userMessages(events)).toEqual([
      'WAIT at the gate',
      'queued first',
      'could not interrupt',
    ]);

    await manager.closeThread(info.threadId);
  }, 40_000);

  test('Send now on a held entry with no run going just sends it', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const releasePath = join(localDir, 'release-turn');
    writeGateAgent(localDir, releasePath);
    const manager = makeManager(contentDir, localDir);
    const info = await manager.createThread({ agent: { source: 'custom', id: 'gate-agent' } });
    const events: Collected = [];
    await manager.subscribe(info.threadId, 0, collect(events));
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    manager.sendPrompt(info.threadId, 'WAIT at the gate');
    await waitUntil(() => internals(manager).turnActive(info.threadId), 5_000, 'turn active');
    manager.sendPrompt(info.threadId, 'parked');
    const entry = (manager.getInfo(info.threadId)?.queue ?? [])[0];
    if (entry === undefined) throw new Error('queue entry missing');
    manager.holdQueued(info.threadId, entry.id, true);

    writeFileSync(releasePath, 'go');
    await waitUntil(
      () => events.filter((e) => e.event.kind === 'turn_ended').length === 1,
      20_000,
      'the gated turn ends',
    );
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 20_000, 'ready');
    expect(manager.getInfo(info.threadId)?.queue?.length).toBe(1);

    expect(manager.sendQueuedNow(info.threadId, entry.id)).toBe(true);
    await waitUntil(
      () => events.filter((e) => e.event.kind === 'turn_ended').length === 2,
      20_000,
      'two turn ends',
    );
    expect(userMessages(events)).toEqual(['WAIT at the gate', 'parked']);
    expect(manager.getInfo(info.threadId)?.queue).toBeUndefined();
    expect(manager.getInfo(info.threadId)?.steer).toBeUndefined();

    await manager.closeThread(info.threadId);
  }, 40_000);

  function writeStutterAgent(localDir: string, releasePath: string): void {
    writeRequestingAgentEntry(
      localDir,
      'stutter-agent',
      `
  notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'one;' } });
  const fs = await import('node:fs');
  while (!fs.existsSync(${JSON.stringify(releasePath)})) {
    await new Promise((r) => setTimeout(r, 20));
  }
  notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'two;' } });
  await new Promise((r) => setTimeout(r, 900));
  finish();
`,
    );
  }

  test('a turn that goes silent is flagged as stalled, and the flag is never persisted', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeGateAgent(localDir, join(localDir, 'release-turn'));
    const warn = vi.spyOn(log, 'warn');
    const manager = makeManager(contentDir, localDir, { turnStallMs: 250 });
    await manager.init();
    const info = await manager.createThread({ agent: { source: 'custom', id: 'gate-agent' } });
    await manager.subscribe(info.threadId, 0, () => {});
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    manager.sendPrompt(info.threadId, 'WAIT at the gate');
    await waitUntil(() => internals(manager).turnActive(info.threadId), 5_000, 'turn active');
    await waitUntil(
      () => manager.getInfo(info.threadId)?.stalledSince !== undefined,
      5_000,
      'stall flagged',
    );
    const stalledSince = manager.getInfo(info.threadId)?.stalledSince ?? 0;
    expect(Date.now() - stalledSince).toBeGreaterThanOrEqual(250);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: info.threadId, silentMs: expect.any(Number) }),
      '[acp-threads] turn stalled: no agent activity',
    );

    await manager.closeThread(info.threadId);
    const manager2 = makeManager(contentDir, localDir);
    await manager2.init();
    expect(manager2.getInfo(info.threadId)).toBeDefined();
    expect(manager2.getInfo(info.threadId)?.stalledSince).toBeUndefined();
  }, 40_000);

  test('typing while the agent is quiet neither delays the notice nor restarts its count', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeGateAgent(localDir, join(localDir, 'release-turn'));
    const manager = makeManager(contentDir, localDir, { turnStallMs: 400 });
    const info = await manager.createThread({ agent: { source: 'custom', id: 'gate-agent' } });
    await manager.subscribe(info.threadId, 0, () => {});
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    manager.sendPrompt(info.threadId, 'WAIT at the gate');
    await waitUntil(() => internals(manager).turnActive(info.threadId), 5_000, 'turn active');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const queuedAt = Date.now();
    manager.sendPrompt(info.threadId, 'queued while the agent is quiet');
    expect(manager.getInfo(info.threadId)?.lastActivityAt).toBeGreaterThanOrEqual(queuedAt);

    await waitUntil(
      () => manager.getInfo(info.threadId)?.stalledSince !== undefined,
      5_000,
      'stall flagged',
    );
    expect(manager.getInfo(info.threadId)?.stalledSince ?? Number.POSITIVE_INFINITY).toBeLessThan(
      queuedAt,
    );

    await manager.closeThread(info.threadId);
  }, 40_000);

  function writeReadingAgent(localDir: string, releasePath: string, readPath: string): void {
    writeRequestingAgentEntry(
      localDir,
      'reading-agent',
      `
  notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'one;' } });
  const fs = await import('node:fs');
  while (!fs.existsSync(${JSON.stringify(releasePath)})) {
    await new Promise((r) => setTimeout(r, 20));
  }
  await request('fs/read_text_file', { sessionId: msg.params.sessionId, path: ${JSON.stringify(readPath)} });
  await new Promise((r) => setTimeout(r, 300));
  finish();
`,
    );
  }

  test('a client file read from a quiet agent counts as activity', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const releasePath = join(localDir, 'release-turn');
    const readPath = join(contentDir, 'note.md');
    writeFileSync(readPath, '# hello\n');
    writeReadingAgent(localDir, releasePath, readPath);
    const infoLog = vi.spyOn(log, 'info');
    const manager = makeManager(contentDir, localDir, { turnStallMs: 250 });
    const info = await manager.createThread({ agent: { source: 'custom', id: 'reading-agent' } });
    await manager.subscribe(info.threadId, 0, () => {});
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    manager.sendPrompt(info.threadId, 'go');
    await waitUntil(
      () => manager.getInfo(info.threadId)?.stalledSince !== undefined,
      5_000,
      'stall flagged',
    );
    writeFileSync(releasePath, 'go');
    await waitUntil(
      () => infoLog.mock.calls.some((call) => call[1] === '[acp-threads] turn resumed after stall'),
      5_000,
      'the file read cleared the stall',
    );
    await waitUntil(() => !internals(manager).turnActive(info.threadId), 20_000, 'turn ended');

    await manager.closeThread(info.threadId);
  }, 40_000);

  test('Stop retires the stall flag at once, even while the agent ignores the cancel', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeGateAgent(localDir, join(localDir, 'release-turn'));
    const manager = makeManager(contentDir, localDir, { turnStallMs: 250 });
    const info = await manager.createThread({ agent: { source: 'custom', id: 'gate-agent' } });
    await manager.subscribe(info.threadId, 0, () => {});
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    manager.sendPrompt(info.threadId, 'WAIT at the gate');
    await waitUntil(
      () => manager.getInfo(info.threadId)?.stalledSince !== undefined,
      5_000,
      'stall flagged',
    );
    manager.cancel(info.threadId);
    expect(manager.getInfo(info.threadId)?.stalledSince).toBeUndefined();
    expect(internals(manager).turnActive(info.threadId)).toBe(true);

    await manager.closeThread(info.threadId);
  }, 40_000);

  test('a turn waiting on your permission is not a stall', async () => {
    const localDir = tmp();
    writeExampleAgentEntry(localDir);
    const warn = vi.spyOn(log, 'warn');
    const manager = makeManager(tmp(), localDir, { turnStallMs: 200 });
    const info = await manager.createThread({ agent: { source: 'custom', id: 'example' } });
    const events: Collected = [];
    await manager.subscribe(info.threadId, 0, collect(events));
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    manager.sendPrompt(info.threadId, 'Improve my project please');
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'awaiting_permission',
      20_000,
      'permission pending',
    );
    const stallWarnings = (): number =>
      warn.mock.calls.filter((call) => call[1] === '[acp-threads] turn stalled: no agent activity')
        .length;
    const before = stallWarnings();
    expect(manager.getInfo(info.threadId)?.stalledSince).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(manager.getInfo(info.threadId)?.stalledSince).toBeUndefined();
    expect(stallWarnings()).toBe(before);

    const request = events
      .map((e) => e.event)
      .find(
        (e): e is Extract<ThreadEvent, { kind: 'permission_request' }> =>
          e.kind === 'permission_request',
      );
    if (request === undefined) throw new Error('permission request missing');
    manager.respondPermission(info.threadId, request.requestId, { kind: 'cancelled' });
    expect(manager.getInfo(info.threadId)?.stalledSince).toBeUndefined();

    await manager.closeThread(info.threadId);
  }, 45_000);

  test('the stall clears the moment the agent speaks again, and the turn logs its lifecycle', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const releasePath = join(localDir, 'release-turn');
    writeStutterAgent(localDir, releasePath);
    const infoLog = vi.spyOn(log, 'info');
    const warn = vi.spyOn(log, 'warn');
    const manager = makeManager(contentDir, localDir, { turnStallMs: 250 });
    const info = await manager.createThread({ agent: { source: 'custom', id: 'stutter-agent' } });
    const events: Collected = [];
    await manager.subscribe(info.threadId, 0, collect(events));
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    manager.sendPrompt(info.threadId, 'go');
    await waitUntil(
      () => manager.getInfo(info.threadId)?.stalledSince !== undefined,
      5_000,
      'first stall',
    );
    writeFileSync(releasePath, 'go');
    await waitUntil(
      () => infoLog.mock.calls.some((call) => call[1] === '[acp-threads] turn resumed after stall'),
      5_000,
      'stall cleared on activity',
    );
    await waitUntil(
      () => events.filter((e) => e.event.kind === 'turn_ended').length === 1,
      20_000,
      'turn ended',
    );
    expect(manager.getInfo(info.threadId)?.stalledSince).toBeUndefined();
    expect(agentText(events)).toBe('one;two;');
    const messages = infoLog.mock.calls.map((call) => call[1]);
    expect(messages).toContain('[acp-threads] turn started');
    const ended = infoLog.mock.calls.find((call) => call[1] === '[acp-threads] turn ended');
    const endedFields = ended?.[0] as { durationMs?: number } | undefined;
    expect(endedFields).toMatchObject({ threadId: info.threadId, outcome: 'end_turn' });
    expect(endedFields?.durationMs).toBeGreaterThan(0);
    expect(
      warn.mock.calls.filter((call) => call[1] === '[acp-threads] turn stalled: no agent activity'),
    ).toHaveLength(2);

    await manager.closeThread(info.threadId);
  }, 40_000);
});

describe.skipIf(process.platform === 'win32')('login-shell PATH fallback', () => {
  test('launches a command only the login shell can resolve', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const shimDir = tmp();
    const command = `ok-login-shell-agent-${process.pid}`;
    writeFileSync(join(shimDir, command), `#!/bin/sh\nexec node ${EXAMPLE_AGENT} "$@"\n`, {
      mode: 0o755,
    });
    writeFileSync(
      join(localDir, 'acp-agents.json'),
      JSON.stringify([{ id: 'shell-agent', name: 'Shell Agent', command }]),
    );

    const manager = makeManager(contentDir, localDir, {
      resolveLoginShellPath: async () => shimDir,
    });
    const info = await manager.createThread({ agent: { source: 'custom', id: 'shell-agent' } });
    await manager.subscribe(info.threadId, 0, () => {});
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');
  }, 30_000);

  test('a command missing from the login shell too still fails with the install hint', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeFileSync(
      join(localDir, 'acp-agents.json'),
      JSON.stringify([
        { id: 'absent-agent', name: 'Absent Agent', command: `ok-absent-${process.pid}` },
      ]),
    );

    const manager = makeManager(contentDir, localDir, {
      resolveLoginShellPath: async () => tmp(),
    });
    const seen: ThreadEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'custom', id: 'absent-agent' } });
    await manager.subscribe(info.threadId, 0, (frame: ThreadServerFrame) => {
      if (frame.op === 'event') seen.push(frame.event);
      if (frame.op === 'events') seen.push(...frame.events);
    });
    const errorEvent = (): Extract<ThreadEvent, { kind: 'status' }> | undefined =>
      seen.find(
        (e): e is Extract<ThreadEvent, { kind: 'status' }> =>
          e.kind === 'status' && e.status === 'error',
      );
    await waitUntil(() => errorEvent() !== undefined, 10_000, 'error status');
    expect(errorEvent()?.detail).toContain('was not found');
  }, 20_000);
});

function writePathEchoAgentEntry(localDir: string, id: string): void {
  const agentPath = join(localDir, `${id}.mjs`);
  writeFileSync(
    agentPath,
    `
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    } else if (msg.method === 'session/new') {
      write({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'path-echo-session' } });
      write({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'path-echo-session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: process.env.PATH ?? '' },
          },
        },
      });
    } else if (msg.id !== undefined) {
      write({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  }
});
`,
  );
  writeFileSync(
    join(localDir, 'acp-agents.json'),
    JSON.stringify([{ id, name: `Fake ${id}`, command: 'node', args: [agentPath] }]),
  );
}

describe.skipIf(process.platform === 'win32')('login-shell PATH on a launchable command', () => {
  test('a launch that preflights still carries the login-shell PATH', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const shimDir = tmp();
    writePathEchoAgentEntry(localDir, 'path-echo');

    const manager = makeManager(contentDir, localDir, {
      resolveLoginShellPath: async () => shimDir,
    });
    const seen: ThreadEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'custom', id: 'path-echo' } });
    await manager.subscribe(info.threadId, 0, (frame: ThreadServerFrame) => {
      if (frame.op === 'event') seen.push(frame.event);
      if (frame.op === 'events') seen.push(...frame.events);
    });
    const reportedPath = (): string | undefined => {
      for (const event of seen) {
        if (event.kind !== 'session_update') continue;
        const update = event.update as {
          sessionUpdate?: string;
          content?: { type?: string; text?: string };
        };
        if (update.sessionUpdate !== 'agent_message_chunk') continue;
        if (update.content?.type === 'text') return update.content.text;
      }
      return undefined;
    };
    await waitUntil(() => reportedPath() !== undefined, 15_000, "the agent's PATH");
    expect(manager.getInfo(info.threadId)?.status).toBe('ready');
    expect(reportedPath()).toContain(shimDir);
  }, 30_000);
});

function writeMarkerGatedAgentEntry(localDir: string, id: string, markerPath: string): void {
  const agentPath = join(localDir, `${id}.mjs`);
  writeFileSync(
    agentPath,
    `
import { existsSync } from 'node:fs';
const MARKER = ${JSON.stringify(markerPath)};
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    } else if (msg.method === 'session/new') {
      if (existsSync(MARKER)) {
        write({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'marker-session' } });
      } else {
        write({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32603, message: 'harness not installed' },
        });
      }
    } else if (msg.method === 'session/prompt') {
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    } else if (msg.id !== undefined) {
      write({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  }
});
`,
  );
  writeFileSync(
    join(localDir, 'acp-agents.json'),
    JSON.stringify([{ id, name: `Fake ${id}`, command: 'node', args: [agentPath] }]),
  );
}

describe('AcpThreadManager retry', () => {
  test('retry settles an outstanding permission from a failed prompt in replayed history', async () => {
    const localDir = tmp();
    writeRequestingAgentEntry(
      localDir,
      'permission-failure',
      `
      void request('session/request_permission', {
        toolCall: { toolCallId: 'pending-edit', title: 'Edit a file', kind: 'edit' },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      });
      write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'prompt failed' } });
    `,
    );
    const manager = makeManager(tmp(), localDir);
    const info = await manager.createThread({
      agent: { source: 'custom', id: 'permission-failure' },
    });
    const events: ThreadEvent[] = [];
    await manager.subscribe(info.threadId, 0, (frame) => {
      if (frame.op === 'event') events.push(frame.event);
      if (frame.op === 'events') events.push(...frame.events);
    });
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');
    manager.sendPrompt(info.threadId, 'edit');
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'error',
      5000,
      'prompt failure',
    );
    await waitUntil(
      () => events.some((event) => event.kind === 'permission_request'),
      5000,
      'permission event delivery',
    );
    expect(events.some((event) => event.kind === 'permission_request')).toBe(true);
    writeRequestingAgentEntry(localDir, 'permission-failure', 'finish();');
    expect((await manager.retryThread(info.threadId)).status).toBe('ready');
    const replay: ThreadEvent[] = [];
    await manager.subscribe(info.threadId, 0, (frame) => {
      if (frame.op === 'event') replay.push(frame.event);
      if (frame.op === 'events') replay.push(...frame.events);
    });
    expect(replay.some((event) => event.kind === 'permission_resolved')).toBe(true);
    expect(internals(manager).pendingPermissionCount(info.threadId)).toBe(0);
  }, 30_000);

  test('a failed start retries in place and succeeds once the cause is fixed', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const marker = join(tmp(), 'installed');
    writeMarkerGatedAgentEntry(localDir, 'gated', marker);

    const manager = makeManager(contentDir, localDir);
    const seen: ThreadEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'custom', id: 'gated' } });
    await manager.subscribe(info.threadId, 0, (frame: ThreadServerFrame) => {
      if (frame.op === 'event') seen.push(frame.event);
      if (frame.op === 'events') seen.push(...frame.events);
    });
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'error',
      15_000,
      'the first start to fail',
    );

    await expect(manager.retryThread(info.threadId)).rejects.toThrow(/harness not installed/);
    expect(manager.getInfo(info.threadId)?.status).toBe('error');

    writeFileSync(marker, '');
    const retried = await manager.retryThread(info.threadId);
    expect(retried.status).toBe('ready');
    expect(manager.getInfo(info.threadId)?.status).toBe('ready');

    manager.sendPrompt(info.threadId, 'hello');
    await waitUntil(
      () => seen.some((e) => e.kind === 'turn_ended'),
      15_000,
      'the first turn to finish',
    );
    expect(manager.getInfo(info.threadId)?.status).toBe('ready');
  }, 60_000);

  test('retrying a thread parked on sign-in replaces the agent it kept alive', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const marker = join(tmp(), 'signed-in-elsewhere');
    writeSilentAuthAgentEntry(localDir, 'silent-auth-retry', marker);

    const manager = makeManager(contentDir, localDir);
    const info = await manager.createThread({
      agent: { source: 'custom', id: 'silent-auth-retry' },
    });
    await manager.subscribe(info.threadId, 0, () => {});
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'auth_required',
      15_000,
      'the sign-in prompt',
    );

    const original = internals(manager).child(info.threadId);
    expect(original?.pid).toBeGreaterThan(0);

    writeFileSync(marker, '');
    const retried = await manager.retryThread(info.threadId);
    expect(retried.status).toBe('ready');
    expect(internals(manager).child(info.threadId)).not.toBe(original);
    await waitUntil(
      () => original?.exitCode !== null || original?.signalCode !== null,
      10_000,
      'the original agent process to die',
    );

    await manager.closeThread(info.threadId);
  }, 40_000);

  test('retries a thread that opened a session before the agent demanded sign-in', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const marker = join(tmp(), 'prompt-auth-cleared');
    writeSessionThenPromptAuthAgentEntry(localDir, 'session-then-auth', marker);

    const manager = makeManager(contentDir, localDir);
    const info = await manager.createThread({
      agent: { source: 'custom', id: 'session-then-auth' },
    });
    await manager.subscribe(info.threadId, 0, () => {});
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    expect(internals(manager).sessionId(info.threadId)).toBe('session-before-auth');

    manager.sendPrompt(info.threadId, 'anything');
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'auth_required',
      15_000,
      'the prompt to park on sign-in',
    );
    expect(internals(manager).sessionId(info.threadId)).toBe('session-before-auth');

    writeFileSync(marker, '');
    const retried = await manager.retryThread(info.threadId);
    expect(retried.status).toBe('ready');

    await manager.closeThread(info.threadId);
  }, 40_000);

  test('refuses a thread that started fine', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeExampleAgentEntry(localDir);

    const manager = makeManager(contentDir, localDir);
    const info = await manager.createThread({ agent: { source: 'custom', id: 'example' } });
    await manager.subscribe(info.threadId, 0, () => {});
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    await expect(manager.retryThread(info.threadId)).rejects.toThrow(/did not fail to start/);
  }, 40_000);

  test('refuses an archived thread — that one resumes, it does not retry', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeMarkerGatedAgentEntry(localDir, 'gated-archive', join(tmp(), 'never-written'));

    const manager = makeManager(contentDir, localDir);
    const info = await manager.createThread({ agent: { source: 'custom', id: 'gated-archive' } });
    await manager.subscribe(info.threadId, 0, () => {});
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'error',
      15_000,
      'the start to fail',
    );
    await manager.closeThread(info.threadId);
    expect(manager.getInfo(info.threadId)?.archived).toBe(true);
    await expect(manager.retryThread(info.threadId)).rejects.toThrow(/archived/);
  }, 40_000);
});

function writeSessionFailingAgentEntry(
  localDir: string,
  id: string,
  error: { code: number; message: string; data: unknown },
  stderrNoise?: string,
): void {
  const agentPath = join(localDir, `${id}.mjs`);
  writeFileSync(
    agentPath,
    `
${stderrNoise === undefined ? '' : `process.stderr.write(${JSON.stringify(`${stderrNoise}\n`)});`}
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
const ERROR = ${JSON.stringify(error)};
const AUTH_METHODS = [{ id: 'test_login', name: 'Test Login', description: 'Sign in via test' }];
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      write({
        jsonrpc: '2.0',
        id: msg.id,
        result: { protocolVersion: 1, agentCapabilities: {}, authMethods: AUTH_METHODS },
      });
    } else if (msg.method === 'session/new') {
      write({ jsonrpc: '2.0', id: msg.id, error: ERROR });
    } else if (msg.id !== undefined) {
      write({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  }
});
`,
  );
  writeFileSync(
    join(localDir, 'acp-agents.json'),
    JSON.stringify([{ id, name: `Fake ${id}`, command: 'node', args: [agentPath] }]),
  );
}

function writeAuthenticatingAgentEntry(localDir: string, id: string): void {
  const agentPath = join(localDir, `${id}.mjs`);
  writeFileSync(
    agentPath,
    `
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
const AUTH_METHODS = [
  { id: 'test_login', name: 'Test Login', description: 'Sign in via test' },
  { id: 'test_env', name: 'Env Login', type: 'env_var', vars: [{ name: 'TEST_KEY' }] },
];
let signedIn = false;
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    const reply = (result) => write({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (error) => write({ jsonrpc: '2.0', id: msg.id, error });
    if (msg.method === 'initialize') {
      reply({ protocolVersion: 1, agentCapabilities: {}, authMethods: AUTH_METHODS });
    } else if (msg.method === 'authenticate') {
      if (msg.params && msg.params.methodId === 'test_login') {
        signedIn = true;
        reply({});
      } else {
        fail({ code: -32602, message: 'unknown auth method', data: { detail: 'auth' } });
      }
    } else if (msg.method === 'session/new') {
      if (signedIn) reply({ sessionId: 'sess-auth' });
      else fail({ code: -32000, message: 'Authentication required', data: { detail: 'x' } });
    } else if (msg.method === 'session/prompt') {
      write({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-auth',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'pid ' + process.pid },
          },
        },
      });
      reply({ stopReason: 'end_turn' });
    } else if (msg.id !== undefined) {
      reply({});
    }
  }
});
`,
  );
  writeFileSync(
    join(localDir, 'acp-agents.json'),
    JSON.stringify([{ id, name: `Fake ${id}`, command: 'node', args: [agentPath] }]),
  );
}

function writeMidTurnAuthExpiringAgentEntry(localDir: string, id: string): void {
  const agentPath = join(localDir, `${id}.mjs`);
  writeFileSync(
    agentPath,
    `
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
const AUTH_METHODS = [
  { id: 'reauth_login', name: 'Reauth Login', description: 'Sign back in' },
];
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    const reply = (result) => write({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (error) => write({ jsonrpc: '2.0', id: msg.id, error });
    if (msg.method === 'initialize') {
      reply({ protocolVersion: 1, agentCapabilities: {}, authMethods: AUTH_METHODS });
    } else if (msg.method === 'session/new') {
      reply({ sessionId: 'sess-live' });
    } else if (msg.method === 'session/prompt') {
      fail({
        code: -32000,
        message: 'Failed to authenticate: OAuth session expired',
        data: { detail: 'oauth token expired mid-turn' },
      });
    } else if (msg.id !== undefined) {
      reply({});
    }
  }
});
`,
  );
  writeFileSync(
    join(localDir, 'acp-agents.json'),
    JSON.stringify([{ id, name: 'Reauth-Needed Agent', command: 'node', args: [agentPath] }]),
  );
}

function writeClaudeShapeAuthExpiringAgentEntry(localDir: string, id: string): void {
  const agentPath = join(localDir, `${id}.mjs`);
  writeFileSync(
    agentPath,
    `
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
const AUTH_METHODS = [
  { id: 'claude_login', name: 'Sign in with Claude', description: 'Reauth via Claude' },
];
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    const reply = (result) => write({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (error) => write({ jsonrpc: '2.0', id: msg.id, error });
    if (msg.method === 'initialize') {
      reply({ protocolVersion: 1, agentCapabilities: {}, authMethods: AUTH_METHODS });
    } else if (msg.method === 'session/new') {
      reply({ sessionId: 'sess-claude' });
    } else if (msg.method === 'session/prompt') {
      fail({
        code: -32603,
        message: 'Internal error: Failed to authenticate: OAuth session expired and could not be refreshed',
        data: { errorKind: 'authentication_failed' },
      });
    } else if (msg.id !== undefined) {
      reply({});
    }
  }
});
`,
  );
  writeFileSync(
    join(localDir, 'acp-agents.json'),
    JSON.stringify([{ id, name: 'Claude-Shape Agent', command: 'node', args: [agentPath] }]),
  );
}

function writeStartupCredentialAgentEntry(localDir: string, id: string, markerPath: string): void {
  const agentPath = join(localDir, `${id}.mjs`);
  writeFileSync(
    agentPath,
    `
import { existsSync, writeFileSync } from 'node:fs';
const MARKER = ${JSON.stringify(markerPath)};
const AUTHED_AT_START = existsSync(MARKER);
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
const AUTH_METHODS = [{ id: 'test_login', name: 'Test Login' }];
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      write({
        jsonrpc: '2.0',
        id: msg.id,
        result: { protocolVersion: 1, agentCapabilities: {}, authMethods: AUTH_METHODS },
      });
    } else if (msg.method === 'authenticate') {
      writeFileSync(MARKER, '');
      write({ jsonrpc: '2.0', id: msg.id, result: {} });
    } else if (msg.method === 'session/new') {
      if (AUTHED_AT_START) {
        write({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'startup-cred-session' } });
      } else {
        write({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: 'Authentication required' },
        });
      }
    } else if (msg.method === 'session/prompt') {
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    } else if (msg.id !== undefined) {
      write({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  }
});
`,
  );
  writeFileSync(
    join(localDir, 'acp-agents.json'),
    JSON.stringify([{ id, name: `Fake ${id}`, command: 'node', args: [agentPath] }]),
  );
}

function writeSilentAuthAgentEntry(
  localDir: string,
  id: string,
  markerPath: string,
  deviceCodeProse = false,
): void {
  const agentPath = join(localDir, `${id}.mjs`);
  writeFileSync(
    agentPath,
    `
import { existsSync } from 'node:fs';
const MARKER = ${JSON.stringify(markerPath)};
const PROSE = ${JSON.stringify(deviceCodeProse)};
if (PROSE) process.stderr.write('npm warn Unknown env config "_jsr-registry".\\n');
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
const AUTH_METHODS = [{ id: 'test_login', name: 'Test Login' }];
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      write({
        jsonrpc: '2.0',
        id: msg.id,
        result: { protocolVersion: 1, agentCapabilities: {}, authMethods: AUTH_METHODS },
      });
    } else if (msg.method === 'authenticate') {
      if (PROSE) process.stderr.write('[auth] Enter this code in your browser: CRQT-NXNT\\n');
      // No reply, ever: the sign-in went to a browser nobody came back from.
    } else if (msg.method === 'session/new') {
      if (existsSync(MARKER)) {
        write({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'silent-auth-session' } });
      } else {
        write({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: 'Authentication required' },
        });
      }
    } else if (msg.method === 'session/prompt') {
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    } else if (msg.id !== undefined) {
      write({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  }
});
`,
  );
  writeFileSync(
    join(localDir, 'acp-agents.json'),
    JSON.stringify([{ id, name: `Fake ${id}`, command: 'node', args: [agentPath] }]),
  );
}

function writeSessionThenPromptAuthAgentEntry(
  localDir: string,
  id: string,
  markerPath: string,
): void {
  const agentPath = join(localDir, `${id}.mjs`);
  writeFileSync(
    agentPath,
    `
import { existsSync } from 'node:fs';
const MARKER = ${JSON.stringify(markerPath)};
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      write({
        jsonrpc: '2.0',
        id: msg.id,
        result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
      });
    } else if (msg.method === 'session/new') {
      write({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'session-before-auth' } });
    } else if (msg.method === 'session/prompt') {
      if (existsSync(MARKER)) {
        write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      } else {
        write({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: 'Authentication required' },
        });
      }
    } else if (msg.id !== undefined) {
      write({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  }
});
`,
  );
  writeFileSync(
    join(localDir, 'acp-agents.json'),
    JSON.stringify([{ id, name: `Fake ${id}`, command: 'node', args: [agentPath] }]),
  );
}

type StatusEvent = Extract<ThreadEvent, { kind: 'status' }>;

const collectStatuses = (into: StatusEvent[]) => (frame: ThreadServerFrame) => {
  const push = (event: ThreadEvent): void => {
    if (event.kind === 'status') into.push(event);
  };
  if (frame.op === 'event') push(frame.event);
  if (frame.op === 'events') for (const event of frame.events) push(event);
};

describe('AcpThreadManager auth classification', () => {
  const withStatus = (statuses: StatusEvent[], status: string): StatusEvent | undefined =>
    statuses.find((e) => e.status === status);

  test('an auth-required session/new failure parks on sign-in with the advertised methods', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeSessionFailingAgentEntry(localDir, 'auth-agent', {
      code: -32000,
      message: 'Authentication required',
      data: { detail: 'x' },
    });
    const manager = makeManager(contentDir, localDir);
    const statuses: StatusEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'custom', id: 'auth-agent' } });
    await manager.subscribe(info.threadId, 0, collectStatuses(statuses));
    await waitUntil(
      () => withStatus(statuses, 'auth_required') !== undefined,
      15_000,
      `auth_required; got ${JSON.stringify(statuses.map((e) => e.status))}`,
    );
    expect(manager.getInfo(info.threadId)?.status).toBe('auth_required');

    const event = withStatus(statuses, 'auth_required');
    expect(event?.failure?.reason).toBe('auth-required');
    expect(event?.failure?.authMethods).toEqual([
      { id: 'test_login', name: 'Test Login', description: 'Sign in via test' },
    ]);
    expect(event?.failure?.agentMessage).toBe('Authentication required');
    expect(event?.failure?.machineDetail).toContain('"detail":"x"');
    expect(event?.detail ?? '').not.toContain('"detail":"x"');

    await manager.closeThread(info.threadId);
  }, 30_000);

  test('a sign-in prompt keeps the stderr tail out of the disclosure', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeSessionFailingAgentEntry(
      localDir,
      'noisy-auth-agent',
      { code: -32000, message: 'Authentication required', data: { detail: 'run /login first' } },
      'npm warn Unknown env config "_jsr-registry".',
    );
    const manager = makeManager(contentDir, localDir);
    const statuses: StatusEvent[] = [];
    const info = await manager.createThread({
      agent: { source: 'custom', id: 'noisy-auth-agent' },
    });
    await manager.subscribe(info.threadId, 0, collectStatuses(statuses));
    await waitUntil(
      () => withStatus(statuses, 'auth_required') !== undefined,
      15_000,
      `auth_required; got ${JSON.stringify(statuses.map((e) => e.status))}`,
    );

    const detail = withStatus(statuses, 'auth_required')?.failure?.machineDetail ?? '';
    expect(detail).toContain('run /login first');
    expect(detail).not.toContain('npm warn');

    await manager.closeThread(info.threadId);
  }, 30_000);

  test('a non-auth session/new failure is an error, not a sign-in prompt, and kills the agent', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeSessionFailingAgentEntry(
      localDir,
      'broken-agent',
      {
        code: -32603,
        message: 'Failed to initialize session services',
        data: { cause: 'services' },
      },
      'boot: loading services',
    );
    const manager = makeManager(contentDir, localDir);
    const statuses: StatusEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'custom', id: 'broken-agent' } });
    await manager.subscribe(info.threadId, 0, collectStatuses(statuses));
    await waitUntil(
      () => withStatus(statuses, 'error') !== undefined,
      15_000,
      `error; got ${JSON.stringify(statuses.map((e) => e.status))}`,
    );
    expect(manager.getInfo(info.threadId)?.status).toBe('error');

    expect(withStatus(statuses, 'auth_required')).toBeUndefined();
    const event = withStatus(statuses, 'error');
    expect(event?.failure?.reason).toBe('session-setup');
    expect(event?.failure?.agentMessage).toBe('Failed to initialize session services');
    expect(event?.failure?.machineDetail).toContain('"cause":"services"');
    expect(event?.failure?.machineDetail).toContain('boot: loading services');

    await waitUntil(
      () => internals(manager).child(info.threadId) === null,
      10_000,
      'agent child torn down',
    );

    await manager.closeThread(info.threadId);
  }, 30_000);

  test.each([
    'short',
    'cut-through-credentials',
    'colon-free',
    'long-stderr',
    'large-tail',
  ] as const)(
    'a %s session/new error payload is redacted before it reaches the failure detail',
    async (shape) => {
      const contentDir = tmp();
      const localDir = tmp();
      writeSessionFailingAgentEntry(
        localDir,
        'leaky-data-agent',
        {
          code: -32603,
          message: 'Failed to initialize session services',
          data: {
            cause: 'services',
            padding: shape === 'short' ? '' : 'x'.repeat(220),
            registry:
              shape === 'colon-free'
                ? 'https://0123456789abcdef@pypi.company.com/simple'
                : `https://alice:fixture-secret${'z'.repeat(80)}@registry.example.test/pkg`,
            header: 'Authorization: Bearer fixture-token',
          },
        },
        shape === 'large-tail'
          ? [...Array.from({ length: 39 }, () => 'x'.repeat(480)), 'boot: loading services'].join(
              '\n',
            )
          : shape === 'colon-free'
            ? 'boot: loading services https://fedcba9876543210@pypi.company.com/simple'
            : `boot: loading services https://bob:fixture-tail-secret${shape === 'long-stderr' ? 'z'.repeat(600) : ''}@registry.example.test/pkg`,
      );
      const manager = makeManager(contentDir, localDir);
      const statuses: StatusEvent[] = [];
      const info = await manager.createThread({
        agent: { source: 'custom', id: 'leaky-data-agent' },
      });
      await manager.subscribe(info.threadId, 0, collectStatuses(statuses));
      await waitUntil(
        () => withStatus(statuses, 'error') !== undefined,
        15_000,
        `error; got ${JSON.stringify(statuses.map((e) => e.status))}`,
      );
      const event = withStatus(statuses, 'error');
      expect(event?.failure?.reason).toBe('session-setup');
      const detail = event?.failure?.machineDetail ?? '';
      expect(detail).toContain('"cause":"services"');
      expect(detail).toContain('boot: loading services');
      expect(detail).not.toMatch(
        /fixture-secret|fixture-token|fixture-tail-secret|0123456789abcdef|fedcba9876543210/,
      );
      expect(detail.length).toBeLessThanOrEqual(16_000);

      await manager.closeThread(info.threadId);
    },
    30_000,
  );

  test('closing a failed thread archives it instead of erasing its evidence', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeSessionFailingAgentEntry(localDir, 'broken-agent', {
      code: -32603,
      message: 'Failed to initialize session services',
      data: { cause: 'services' },
    });
    const manager = makeManager(contentDir, localDir);
    await manager.init();
    const info = await manager.createThread({ agent: { source: 'custom', id: 'broken-agent' } });
    await manager.subscribe(info.threadId, 0, () => {});
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'error', 15_000, 'error');

    await manager.closeThread(info.threadId);
    expect(manager.getInfo(info.threadId)).toBeDefined();
    expect(manager.getInfo(info.threadId)?.archived).toBe(true);
  }, 30_000);

  test('signing in re-opens the session on the same agent process', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeAuthenticatingAgentEntry(localDir, 'signin-agent');
    const manager = makeManager(contentDir, localDir);
    const statuses: StatusEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'custom', id: 'signin-agent' } });
    await manager.subscribe(info.threadId, 0, collectStatuses(statuses));
    await waitUntil(
      () => withStatus(statuses, 'auth_required') !== undefined,
      15_000,
      `auth_required; got ${JSON.stringify(statuses.map((e) => e.status))}`,
    );
    expect(withStatus(statuses, 'auth_required')?.failure?.authMethods).toEqual([
      { id: 'test_login', name: 'Test Login', description: 'Sign in via test' },
      { id: 'test_env', name: 'Env Login', kind: 'env_var' },
    ]);

    const child = internals(manager).child(info.threadId);
    expect(child).toBeDefined();

    const signedIn = await manager.authenticateThread(info.threadId, 'test_login');
    expect(signedIn.status).toBe('ready');
    expect(manager.getInfo(info.threadId)?.status).toBe('ready');
    expect(internals(manager).child(info.threadId)).toBe(child);

    manager.sendPrompt(info.threadId, 'hello');
    await waitUntil(() => internals(manager).turnActive(info.threadId), 5_000, 'turn active');
    await waitUntil(() => !internals(manager).turnActive(info.threadId), 10_000, 'turn ended');

    await manager.closeThread(info.threadId);
  }, 30_000);

  test('a rejected sign-in parks the thread back on sign-in with a fresh notice', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeAuthenticatingAgentEntry(localDir, 'signin-agent');
    const manager = makeManager(contentDir, localDir);
    const statuses: StatusEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'custom', id: 'signin-agent' } });
    await manager.subscribe(info.threadId, 0, collectStatuses(statuses));
    const authNotices = (): StatusEvent[] => statuses.filter((e) => e.status === 'auth_required');
    await waitUntil(() => authNotices().length > 0, 15_000, 'auth_required');

    await expect(manager.authenticateThread(info.threadId, 'not_a_method')).rejects.toThrow(
      /unknown auth method/,
    );
    expect(manager.getInfo(info.threadId)?.status).toBe('auth_required');
    await waitUntil(() => authNotices().length > 1, 10_000, 'a second sign-in notice');
    const latest = authNotices().at(-1);
    expect(latest?.failure?.reason).toBe('auth-required');
    expect(latest?.failure?.agentMessage).toBe('unknown auth method');
    expect(latest?.failure?.authMethods?.map((m) => m.id)).toEqual(['test_login', 'test_env']);

    await manager.closeThread(info.threadId);
  }, 30_000);

  test('signing in a thread that never asked for one is refused', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeAuthenticatingAgentEntry(localDir, 'signin-agent');
    const manager = makeManager(contentDir, localDir);
    const statuses: StatusEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'custom', id: 'signin-agent' } });
    await manager.subscribe(info.threadId, 0, collectStatuses(statuses));
    await waitUntil(() => withStatus(statuses, 'auth_required') !== undefined, 15_000, 'auth');
    await manager.authenticateThread(info.threadId, 'test_login');

    await expect(manager.authenticateThread(info.threadId, 'test_login')).rejects.toThrow(
      /not waiting for a sign-in/,
    );

    await manager.closeThread(info.threadId);
  }, 30_000);

  test('a sign-in prompt keeps what the agent printed during the sign-in', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const marker = join(tmp(), 'signed-in-elsewhere');
    writeSilentAuthAgentEntry(localDir, 'coded-auth', marker, true);
    const manager = makeManager(contentDir, localDir, { authenticateTimeoutMs: 1_500 });
    const statuses: StatusEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'custom', id: 'coded-auth' } });
    await manager.subscribe(info.threadId, 0, collectStatuses(statuses));
    await waitUntil(() => withStatus(statuses, 'auth_required') !== undefined, 15_000, 'auth');

    expect(withStatus(statuses, 'auth_required')?.failure?.machineDetail ?? '').not.toContain(
      'npm warn',
    );

    await expect(manager.authenticateThread(info.threadId, 'test_login')).rejects.toThrow(
      /didn't complete in time/,
    );

    await waitUntil(
      () => statuses.filter((e) => e.status === 'auth_required').length >= 2,
      10_000,
      'the sign-in failure to re-prompt',
    );
    const detail = statuses.filter((e) => e.status === 'auth_required').at(-1)
      ?.failure?.machineDetail;
    expect(detail).toContain('CRQT-NXNT');
    expect(detail).not.toContain('npm warn');

    await manager.closeThread(info.threadId);
  }, 40_000);

  test('a sign-in in flight publishes the agent output live, then clears it', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const marker = join(tmp(), 'signed-in-elsewhere');
    writeSilentAuthAgentEntry(localDir, 'live-code-auth', marker, true);
    const manager = makeManager(contentDir, localDir, { authenticateTimeoutMs: 1_500 });
    const statuses: StatusEvent[] = [];
    const infos: ThreadInfo[] = [];
    const info = await manager.createThread({ agent: { source: 'custom', id: 'live-code-auth' } });
    await manager.subscribe(info.threadId, 0, (frame: ThreadServerFrame) => {
      collectStatuses(statuses)(frame);
      if (frame.op === 'info') infos.push(frame.info);
    });
    await waitUntil(() => withStatus(statuses, 'auth_required') !== undefined, 15_000, 'auth');

    const signIn = manager
      .authenticateThread(info.threadId, 'test_login')
      .then(() => null)
      .catch((err: unknown) => err);

    await waitUntil(
      () => infos.some((i) => (i.signInOutput ?? []).some((l) => l.includes('CRQT-NXNT'))),
      10_000,
      `the code to publish; got ${JSON.stringify(infos.map((i) => i.signInOutput))}`,
    );
    const published = infos.flatMap((i) => i.signInOutput ?? []);
    expect(published.join('\n')).not.toContain('npm warn');

    expect(String(await signIn)).toMatch(/didn't complete in time/);
    await waitUntil(
      () => manager.getInfo(info.threadId)?.signInOutput === undefined,
      10_000,
      'the sign-in output to clear',
    );

    await manager.closeThread(info.threadId);
  }, 40_000);

  test('a sign-in the running agent cannot see relaunches instead of re-prompting', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const marker = join(tmp(), 'credential-written-by-authenticate');
    writeStartupCredentialAgentEntry(localDir, 'startup-cred', marker);
    const manager = makeManager(contentDir, localDir);
    const statuses: StatusEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'custom', id: 'startup-cred' } });
    await manager.subscribe(info.threadId, 0, collectStatuses(statuses));
    await waitUntil(() => withStatus(statuses, 'auth_required') !== undefined, 15_000, 'auth');
    const promptsBeforeSignIn = statuses.filter((e) => e.status === 'auth_required').length;

    const signedIn = await manager.authenticateThread(info.threadId, 'test_login');

    expect(signedIn.status).toBe('ready');
    expect(manager.getInfo(info.threadId)?.status).toBe('ready');
    expect(statuses.filter((e) => e.status === 'auth_required').length).toBe(promptsBeforeSignIn);

    const events: ThreadEvent[] = [];
    await manager.subscribe(info.threadId, 0, (frame: ThreadServerFrame) => {
      if (frame.op === 'event') events.push(frame.event);
      if (frame.op === 'events') events.push(...frame.events);
    });
    manager.sendPrompt(info.threadId, 'hello');
    await waitUntil(() => events.some((e) => e.kind === 'turn_ended'), 15_000, 'a completed turn');

    await manager.closeThread(info.threadId);
  }, 40_000);

  test('a relaunch that fails before reporting parks the sign-in back where the user can act', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const marker = join(tmp(), 'credential-written-by-authenticate');
    writeStartupCredentialAgentEntry(localDir, 'vanishing-agent', marker);
    const manager = makeManager(contentDir, localDir);
    const statuses: StatusEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'custom', id: 'vanishing-agent' } });
    await manager.subscribe(info.threadId, 0, collectStatuses(statuses));
    await waitUntil(() => withStatus(statuses, 'auth_required') !== undefined, 15_000, 'auth');

    writeFileSync(join(localDir, 'acp-agents.json'), JSON.stringify([]));

    await expect(manager.authenticateThread(info.threadId, 'test_login')).rejects.toThrow();

    const settled = manager.getInfo(info.threadId)?.status;
    expect(settled).not.toBe('authenticating');
    expect(settled).toBe('auth_required');
    await expect(manager.retryThread(info.threadId)).rejects.toThrow(/no custom agent/);

    await manager.closeThread(info.threadId);
  }, 40_000);

  test('a relaunch does not inherit the finished sign-in output', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const marker = join(tmp(), 'credential-written-by-authenticate');
    writeStartupCredentialAgentEntry(localDir, 'buffer-scope', marker);
    const manager = makeManager(contentDir, localDir);
    const infos: ThreadInfo[] = [];
    const info = await manager.createThread({ agent: { source: 'custom', id: 'buffer-scope' } });
    await manager.subscribe(info.threadId, 0, (frame: ThreadServerFrame) => {
      if (frame.op === 'info') infos.push(frame.info);
    });
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'auth_required',
      15_000,
      'auth',
    );

    const signedIn = await manager.authenticateThread(info.threadId, 'test_login');
    expect(signedIn.status).toBe('ready');

    expect(manager.getInfo(info.threadId)?.signInOutput).toBeUndefined();
    expect(infos.at(-1)?.signInOutput).toBeUndefined();

    await manager.closeThread(info.threadId);
  }, 40_000);

  test('sign-in output never reaches the persisted meta', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const marker = join(tmp(), 'credential-written-by-authenticate');
    writeStartupCredentialAgentEntry(localDir, 'meta-scope', marker);
    const manager = makeManager(contentDir, localDir);
    await manager.init();
    const events: ThreadEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'custom', id: 'meta-scope' } });
    await manager.subscribe(info.threadId, 0, (frame: ThreadServerFrame) => {
      if (frame.op === 'event') events.push(frame.event);
      if (frame.op === 'events') events.push(...frame.events);
    });
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'auth_required',
      15_000,
      'auth',
    );
    await manager.authenticateThread(info.threadId, 'test_login');

    manager.sendPrompt(info.threadId, 'hello');
    await waitUntil(() => events.some((e) => e.kind === 'turn_ended'), 15_000, 'a completed turn');
    await manager.closeThread(info.threadId);

    const metaPath = join(localDir, 'threads', `${info.threadId}.meta.json`);
    await waitUntil(() => existsSync(metaPath), 10_000, `the archived meta at ${metaPath}`);
    expect(readFileSync(metaPath, 'utf8')).not.toContain('signInOutput');
  }, 40_000);

  test('an unanswered sign-in gives up on its own and leaves the thread usable', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const marker = join(tmp(), 'signed-in-elsewhere');
    writeSilentAuthAgentEntry(localDir, 'silent-auth', marker);
    const manager = makeManager(contentDir, localDir, { authenticateTimeoutMs: 200 });
    const statuses: StatusEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'custom', id: 'silent-auth' } });
    await manager.subscribe(info.threadId, 0, collectStatuses(statuses));
    await waitUntil(() => withStatus(statuses, 'auth_required') !== undefined, 15_000, 'auth');

    await expect(manager.authenticateThread(info.threadId, 'test_login')).rejects.toThrow(
      /didn't complete in time/,
    );
    expect(manager.getInfo(info.threadId)?.status).toBe('auth_required');
    const latest = statuses.filter((e) => e.status === 'auth_required').at(-1);
    expect(latest?.failure?.authMethods?.map((m) => m.id)).toEqual(['test_login']);

    writeFileSync(marker, '');
    const retried = await manager.retryThread(info.threadId);
    expect(retried.status).toBe('ready');

    const events: ThreadEvent[] = [];
    await manager.subscribe(info.threadId, 0, (frame: ThreadServerFrame) => {
      if (frame.op === 'event') events.push(frame.event);
      if (frame.op === 'events') events.push(...frame.events);
    });
    manager.sendPrompt(info.threadId, 'hello');
    await waitUntil(() => events.some((e) => e.kind === 'turn_ended'), 15_000, 'a completed turn');

    await manager.closeThread(info.threadId);
  }, 40_000);

  test('a retry breaks an in-flight sign-in and owns the thread afterwards', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const marker = join(tmp(), 'signed-in-elsewhere');
    writeSilentAuthAgentEntry(localDir, 'silent-auth', marker);
    const manager = makeManager(contentDir, localDir);
    const statuses: StatusEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'custom', id: 'silent-auth' } });
    await manager.subscribe(info.threadId, 0, collectStatuses(statuses));
    await waitUntil(() => withStatus(statuses, 'auth_required') !== undefined, 15_000, 'auth');

    const authNoticesBeforeRetry = statuses.filter((e) => e.status === 'auth_required').length;
    const signIn = manager
      .authenticateThread(info.threadId, 'test_login')
      .then(() => null)
      .catch((err: unknown) => err);
    expect(manager.getInfo(info.threadId)?.status).toBe('authenticating');

    writeFileSync(marker, '');
    const retried = await manager.retryThread(info.threadId);
    expect(retried.status).toBe('ready');

    expect(String(await signIn)).toMatch(/restarted/);
    expect(manager.getInfo(info.threadId)?.status).toBe('ready');
    await waitUntil(
      () => statuses.at(-1)?.status === 'ready',
      10_000,
      `ready to be the last status event; got ${JSON.stringify(statuses.map((e) => e.status))}`,
    );
    expect(statuses.filter((e) => e.status === 'auth_required').length).toBe(
      authNoticesBeforeRetry,
    );

    await manager.closeThread(info.threadId);
  }, 40_000);

  test('a session/prompt that rejects with AUTH_REQUIRED parks on sign-in, not on the opaque prompt error', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeMidTurnAuthExpiringAgentEntry(localDir, 'reauth-agent');
    const manager = makeManager(contentDir, localDir);
    const statuses: StatusEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'custom', id: 'reauth-agent' } });
    await manager.subscribe(info.threadId, 0, collectStatuses(statuses));

    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'ready',
      15_000,
      `ready; got ${JSON.stringify(statuses.map((e) => e.status))}`,
    );

    manager.sendPrompt(info.threadId, 'hello');

    await waitUntil(
      () => withStatus(statuses, 'auth_required') !== undefined,
      15_000,
      `auth_required from prompt; got ${JSON.stringify(statuses.map((e) => e.status))}`,
    );

    const notice = withStatus(statuses, 'auth_required');
    expect(notice?.failure?.reason).toBe('auth-required');
    expect(notice?.failure?.agentMessage).toContain('OAuth session expired');
    expect(notice?.failure?.authMethods).toEqual([
      { id: 'reauth_login', name: 'Reauth Login', description: 'Sign back in' },
    ]);
    expect(withStatus(statuses, 'error')).toBeUndefined();
    expect(manager.getInfo(info.threadId)?.status).toBe('auth_required');

    await manager.closeThread(info.threadId);
  }, 30_000);

  test('a Claude-shape `-32603` + errorKind=authentication_failed prompt rejection parks on sign-in', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeClaudeShapeAuthExpiringAgentEntry(localDir, 'claude-shape-agent');
    const manager = makeManager(contentDir, localDir);
    const statuses: StatusEvent[] = [];
    const info = await manager.createThread({
      agent: { source: 'custom', id: 'claude-shape-agent' },
    });
    await manager.subscribe(info.threadId, 0, collectStatuses(statuses));

    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'ready',
      15_000,
      `ready; got ${JSON.stringify(statuses.map((e) => e.status))}`,
    );

    manager.sendPrompt(info.threadId, 'hello');

    await waitUntil(
      () => withStatus(statuses, 'auth_required') !== undefined,
      15_000,
      `auth_required from prompt; got ${JSON.stringify(statuses.map((e) => e.status))}`,
    );

    const notice = withStatus(statuses, 'auth_required');
    expect(notice?.failure?.reason).toBe('auth-required');
    expect(notice?.failure?.agentMessage).toContain('Failed to authenticate');
    expect(notice?.failure?.authMethods).toEqual([
      {
        id: 'claude_login',
        name: 'Sign in with Claude',
        description: 'Reauth via Claude',
      },
    ]);
    expect(withStatus(statuses, 'error')).toBeUndefined();
    expect(manager.getInfo(info.threadId)?.status).toBe('auth_required');

    await manager.closeThread(info.threadId);
  }, 30_000);
});

describe('AcpThreadManager resumability signal', () => {
  test('a thread parked on sign-in never opened a session, and says so', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeSessionFailingAgentEntry(localDir, 'auth-agent', {
      code: -32000,
      message: 'Authentication required',
      data: { detail: 'x' },
    });
    const manager = makeManager(contentDir, localDir);
    await manager.init();
    const info = await manager.createThread({ agent: { source: 'custom', id: 'auth-agent' } });
    await manager.subscribe(info.threadId, 0, () => {});
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'auth_required',
      15_000,
      'auth_required',
    );
    expect(manager.getInfo(info.threadId)?.resumable).toBe(false);

    await manager.closeThread(info.threadId);
    expect(manager.getInfo(info.threadId)?.archived).toBe(true);
    expect(manager.getInfo(info.threadId)?.resumable).toBe(false);

    const manager2 = makeManager(contentDir, localDir);
    await manager2.init();
    const rehydrated = manager2.listThreads().find((t) => t.threadId === info.threadId);
    expect(rehydrated?.archived).toBe(true);
    expect(rehydrated?.resumable).toBe(false);
  }, 45_000);

  test('an agent that advertises no resume capability leaves its session unresumable', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeAuthenticatingAgentEntry(localDir, 'signin-agent');
    const manager = makeManager(contentDir, localDir);
    await manager.init();
    const info = await manager.createThread({ agent: { source: 'custom', id: 'signin-agent' } });
    await manager.subscribe(info.threadId, 0, () => {});
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'auth_required',
      15_000,
      'auth_required',
    );
    expect(manager.getInfo(info.threadId)?.resumable).toBe(false);

    const signedIn = await manager.authenticateThread(info.threadId, 'test_login');
    expect(signedIn.status).toBe('ready');
    expect(signedIn.resumable).toBe(false);
    expect(manager.getInfo(info.threadId)?.resumable).toBe(false);

    manager.sendPrompt(info.threadId, 'hello');
    await waitUntil(() => internals(manager).turnActive(info.threadId), 5_000, 'turn active');
    await waitUntil(() => !internals(manager).turnActive(info.threadId), 10_000, 'turn ended');

    await manager.closeThread(info.threadId);
    expect(manager.getInfo(info.threadId)?.resumable).toBe(false);

    const manager2 = makeManager(contentDir, localDir);
    await manager2.init();
    const rehydrated = manager2.listThreads().find((t) => t.threadId === info.threadId);
    expect(rehydrated?.archived).toBe(true);
    expect(rehydrated?.resumable).toBe(false);
  }, 45_000);

  test('an agent that advertises resume reports its thread resumable, on disk too', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeResumableAgentEntry(localDir, 'resume-agent', { FAKE_CAPS: 'resume' });
    const manager = makeManager(contentDir, localDir);
    await manager.init();
    const info = await manager.createThread({ agent: { source: 'custom', id: 'resume-agent' } });
    await manager.subscribe(info.threadId, 0, () => {});
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');
    expect(manager.getInfo(info.threadId)?.resumable).toBe(true);

    manager.sendPrompt(info.threadId, 'hello');
    await waitUntil(() => internals(manager).turnActive(info.threadId), 5_000, 'turn active');
    await waitUntil(() => !internals(manager).turnActive(info.threadId), 10_000, 'turn ended');

    await manager.closeThread(info.threadId);
    expect(manager.getInfo(info.threadId)?.resumable).toBe(true);

    const manager2 = makeManager(contentDir, localDir);
    await manager2.init();
    const rehydrated = manager2.listThreads().find((t) => t.threadId === info.threadId);
    expect(rehydrated?.archived).toBe(true);
    expect(rehydrated?.resumable).toBe(true);
  }, 45_000);

  test('an agent that only loads sessions counts as resumable too', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeResumableAgentEntry(localDir, 'load-agent', { FAKE_CAPS: 'load' });
    const manager = makeManager(contentDir, localDir);
    await manager.init();
    const info = await manager.createThread({ agent: { source: 'custom', id: 'load-agent' } });
    await manager.subscribe(info.threadId, 0, () => {});
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');
    expect(manager.getInfo(info.threadId)?.resumable).toBe(true);
  }, 45_000);
});

describe('AcpThreadManager agent presence', () => {
  type Collected = Array<{ seq: number; event: ThreadEvent }>;
  const collect = (into: Collected) => (frame: ThreadServerFrame) => {
    if (frame.op === 'event') into.push({ seq: frame.seq, event: frame.event });
    if (frame.op === 'events') {
      for (const [i, event] of frame.events.entries()) {
        into.push({ seq: frame.fromSeq + i, event });
      }
    }
  };

  interface RecordedPresence {
    key: string;
    entry: { icon: string; currentDoc: string; mode: string; displayName: string };
  }

  function recordingBroadcaster(into: RecordedPresence[]): AgentPresenceBroadcaster {
    return {
      setPresence: (key: string, entry: RecordedPresence['entry']) => into.push({ key, entry }),
      clearPresence: () => {},
    } as unknown as AgentPresenceBroadcaster;
  }

  function stubSessionManager(docs: Map<string, Y.Doc>): AgentSessionManager {
    return {
      getSession: async (docName: string, agentId: string) => {
        let doc = docs.get(docName);
        if (doc === undefined) {
          doc = new Y.Doc();
          docs.set(docName, doc);
        }
        return { dc: { document: doc }, origin: { agentId }, agentId };
      },
      closeAllForAgent: async () => {},
    } as unknown as AgentSessionManager;
  }

  test('a turn that writes nothing publishes no presence at all', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeRequestingAgentEntry(
      localDir,
      'chatty-agent',
      `
  notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } });
  finish();
`,
    );
    const published: RecordedPresence[] = [];
    const manager = makeManager(contentDir, localDir, {
      agentPresenceBroadcaster: recordingBroadcaster(published),
    });

    const info = await manager.createThread({ agent: { source: 'custom', id: 'chatty-agent' } });
    const events: Collected = [];
    await manager.subscribe(info.threadId, 0, collect(events));
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    manager.sendPrompt(info.threadId, 'say hello');
    await waitUntil(() => events.some((e) => e.event.kind === 'turn_ended'), 20_000, 'turn end');
    await manager.closeThread(info.threadId);

    expect(published).toEqual([]);
  }, 45_000);

  test('a context window the agent will not start under is refused and leaves the old one in place', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const agentPath = join(localDir, 'codex-acp.mjs');
    writeFileSync(
      agentPath,
      `
const cfg = process.env.CODEX_CONFIG ?? '';
if (cfg.includes('model_context_window') && !cfg.includes('272000')) process.exit(3);
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    } else if (msg.method === 'session/new') {
      write({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-1' } });
    } else if (msg.id !== undefined) {
      write({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  }
});
`,
    );
    writeFileSync(
      join(localDir, 'acp-agents.json'),
      JSON.stringify([
        { id: 'codex-acp', name: 'Fake codex-acp', command: 'node', args: [agentPath] },
      ]),
    );
    const manager = makeManager(contentDir, localDir, {
      sessionManager: stubSessionManager(new Map()),
    });

    const info = await manager.createThread({
      agent: { source: 'custom', id: 'codex-acp' },
      settings: { contextWindow: 272_000 },
    });
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');
    expect(manager.getInfo(info.threadId)?.contextWindow).toBe(272_000);

    await expect(manager.setContextWindow(info.threadId, 872_000)).rejects.toMatchObject({
      code: 'spawn-failed',
    });
    await expect(manager.retryThread(info.threadId)).resolves.toMatchObject({
      contextWindow: 272_000,
    });

    await manager.closeThread(info.threadId);
  }, 45_000);

  test('a picked window survives a restart, so a resumed conversation keeps it', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeResumableAgentEntry(localDir, 'codex-acp', { FAKE_CAPS: 'resume,load' });
    const manager = makeManager(contentDir, localDir);
    await manager.init();
    const info = await manager.createThread({
      agent: { source: 'custom', id: 'codex-acp' },
      settings: { contextWindow: 872_000 },
    });
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');
    expect(manager.getInfo(info.threadId)?.contextWindow).toBe(872_000);
    manager.sendPrompt(info.threadId, 'hello there');
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'turn ended');
    await manager.closeThread(info.threadId);

    const manager2 = makeManager(contentDir, localDir);
    await manager2.init();
    expect(manager2.getInfo(info.threadId)?.contextWindow ?? null).toBeNull();

    await manager2.resumeThread(info.threadId);
    await waitUntil(() => manager2.getInfo(info.threadId)?.status === 'ready', 15_000, 'resumed');
    expect(manager2.getInfo(info.threadId)?.contextWindow).toBe(872_000);

    await manager2.closeThread(info.threadId);
  }, 45_000);

  test('an ACP fs write publishes presence for that doc, under the agent brand icon', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeRequestingAgentEntry(
      localDir,
      'codex-acp',
      `
  const { join } = await import('node:path');
  await request('fs/write_text_file', {
    path: join(process.cwd(), 'notes', 'planted.md'),
    content: '# planted by the agent',
  });
  notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'wrote it' } });
  finish();
`,
    );
    const published: RecordedPresence[] = [];
    const manager = makeManager(contentDir, localDir, {
      agentPresenceBroadcaster: recordingBroadcaster(published),
      sessionManager: stubSessionManager(new Map()),
    });

    const info = await manager.createThread({ agent: { source: 'custom', id: 'codex-acp' } });
    const events: Collected = [];
    await manager.subscribe(info.threadId, 0, collect(events));
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    manager.sendPrompt(info.threadId, 'plant a note');
    await waitUntil(() => events.some((e) => e.event.kind === 'turn_ended'), 20_000, 'turn end');

    expect(published).toHaveLength(1);
    expect(published[0]?.entry.currentDoc).toBe('notes/planted');
    expect(published[0]?.entry.mode).toBe('writing');
    expect(published[0]?.entry.icon).toBe('openai');

    await manager.closeThread(info.threadId);
  }, 45_000);
});

function writeCrashingAgentEntry(localDir: string, id: string, stderrLine: string): void {
  const agentPath = join(localDir, `${id}.mjs`);
  writeFileSync(agentPath, `process.stderr.write(${JSON.stringify(`${stderrLine}\n`)});\n`);
  writeFileSync(
    join(localDir, 'acp-agents.json'),
    JSON.stringify([{ id, name: `Fake ${id}`, command: 'node', args: [agentPath] }]),
  );
}

function writeExitAfterReadyAgentEntry(
  localDir: string,
  id: string,
  stderr: { text: string; terminated: boolean },
  dieFile: string,
): { preExitStderr: string } {
  const payload = stderr.terminated ? `${stderr.text}\n` : stderr.text;
  const preExitStderr = payload.slice(0, -1);
  const finalStderr = payload.slice(-1);
  const agentPath = join(localDir, `${id}.mjs`);
  writeFileSync(
    agentPath,
    `
import { existsSync } from 'node:fs';
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
let stderrWritten = false;
setInterval(() => {
  if (!stderrWritten && existsSync(${JSON.stringify(`${dieFile}.stderr`)})) {
    stderrWritten = true;
    process.stderr.write(${JSON.stringify(preExitStderr)});
  }
  if (existsSync(${JSON.stringify(dieFile)})) {
    process.stderr.write(${JSON.stringify(finalStderr)}, () => process.exit(7));
  }
}, 20);
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      write({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    } else if (msg.method === 'session/new') {
      write({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'quitter-session' } });
    } else if (msg.id !== undefined) {
      write({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  }
});
`,
  );
  writeFileSync(
    join(localDir, 'acp-agents.json'),
    JSON.stringify([{ id, name: `Fake ${id}`, command: 'node', args: [agentPath] }]),
  );
  return { preExitStderr };
}

function capturingLog(sink: { obj: Record<string, unknown>; msg: string }[]): PinoLogger {
  const record = (obj: unknown, msg?: unknown): void => {
    if (typeof obj === 'string') sink.push({ obj: {}, msg: obj });
    else sink.push({ obj: (obj ?? {}) as Record<string, unknown>, msg: String(msg ?? '') });
  };
  const self = {
    fatal: record,
    error: record,
    warn: record,
    info: record,
    debug: record,
    trace: record,
    child: () => self,
  };
  return self as unknown as PinoLogger;
}

function writeHeldStdioAgentEntry(
  localDir: string,
  id: string,
  mode: 'ready' | 'auth' | 'connect' | 'session-setup' | 'prompt' | 'resume',
  dieFile: string,
  releaseFile: string,
): { diagnostic: string } {
  const diagnostic = 'Fatal: held final diagnostic';
  const stderr = `${diagnostic} https://alice:held-secret@registry.example.test/pkg`;
  const keeper = `
    const { existsSync } = require('node:fs');
    const deadline = Date.now() + 15_000;
    setInterval(() => {
      if (existsSync(${JSON.stringify(releaseFile)}) || Date.now() > deadline) process.exit(0);
    }, 10);
  `;
  const entry = join(localDir, `${id}.mjs`);
  writeFileSync(
    entry,
    `
    import { existsSync, writeFileSync } from 'node:fs';
    import { spawn } from 'node:child_process';
    const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
    setInterval(() => {
      if (!existsSync(${JSON.stringify(dieFile)})) return;
      spawn(process.execPath, ['-e', ${JSON.stringify(keeper)}], {
        detached: true, stdio: ['ignore', 'inherit', 'inherit'],
      }).unref();
      process.stderr.write(${JSON.stringify(stderr)}, () => process.exit(7));
    }, 10);
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\\n')) !== -1) {
        const msg = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (msg.method === 'initialize' && ${JSON.stringify(mode)} === 'connect') {
          writeFileSync(${JSON.stringify(`${dieFile}.request`)}, 'initialize');
        } else if (msg.method === 'initialize') {
          write({ jsonrpc: '2.0', id: msg.id, result: {
            protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } },
            authMethods: [{ id: 'login', name: 'Login' }],
          } });
        } else if (msg.method === 'session/new') {
          if (${JSON.stringify(mode)} === 'session-setup') {
            writeFileSync(${JSON.stringify(`${dieFile}.request`)}, 'session');
          } else if (${JSON.stringify(mode)} === 'auth') {
            write({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'sign in' } });
          } else {
            write({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'held-session' } });
          }
        } else if (msg.method === 'session/resume' && ${JSON.stringify(mode)} !== 'resume') {
          write({ jsonrpc: '2.0', id: msg.id, result: {} });
        } else if (msg.method === 'session/prompt' || msg.method === 'session/resume') {
          writeFileSync(${JSON.stringify(`${dieFile}.request`)}, 'prompt');
        }
      }
    });
  `,
  );
  writeFileSync(
    join(localDir, 'acp-agents.json'),
    JSON.stringify([{ id, name: `Fake ${id}`, command: 'node', args: [entry] }]),
  );
  return { diagnostic };
}

describe('diagnostic stream lifetime', () => {
  test.each([
    ['npx', 'live'],
    ['npx', 'eof'],
    ['uvx', 'live'],
    ['uvx', 'eof'],
  ] as const)(
    '%s initialize handles %s before process exit',
    async (runtime, mode) => {
      const localDir = tmp();
      const binDir = tmp();
      const rejectFile = join(localDir, 'reject');
      const releaseFile = join(localDir, 'release');
      const requestFile = join(localDir, 'request');
      const diagnostic =
        runtime === 'npx'
          ? 'npm ERR! code ETARGET No matching version with a date before 1970-01-01'
          : 'No solution found when resolving tool dependencies: filtered by `exclude-newer`';
      installNodeFixture(binDir);
      writeExecutable(
        join(binDir, runtime),
        `
          const { existsSync, writeFileSync } = require('node:fs');
          if (process.argv.includes('--version')) { process.stdout.write('1.0.0\\n'); process.exit(0); }
          let request;
          let buffer = '';
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', (chunk) => {
            buffer += chunk;
            const end = buffer.indexOf('\\n');
            if (end === -1) return;
            request = JSON.parse(buffer.slice(0, end));
            writeFileSync(${JSON.stringify(requestFile)}, 'initialize');
          });
          let rejected = false;
          setInterval(() => {
            if (!request || rejected || !existsSync(${JSON.stringify(rejectFile)})) return;
            rejected = true;
            if (${JSON.stringify(mode)} === 'live') {
              process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
                error: { code: -32603, message: 'initialize rejected while alive' } }) + '\\n');
            } else {
              process.stdout.end();
            }
          }, 10);
          setInterval(() => {
            if (existsSync(${JSON.stringify(releaseFile)})) {
              process.stderr.write(${JSON.stringify(diagnostic)}, () => process.exit(7));
            }
          }, 10);
        `,
      );
      const lines: { obj: Record<string, unknown>; msg: string }[] = [];
      const manager = makeManager(tmp(), localDir, {
        log: capturingLog(lines),
        registry: new AcpRegistry({
          localDir,
          log,
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                agents: [
                  {
                    id: 'initialize-order',
                    name: 'Initialize order',
                    version: '1.0.0',
                    distribution: {
                      [runtime]: { package: 'initialize-order', env: { PATH: binDir } },
                    },
                  },
                ],
              }),
            ),
        }),
      });
      const info = await manager.createThread({
        agent: { source: 'registry', id: 'initialize-order' },
      });
      await waitUntil(() => existsSync(requestFile), 5000, 'initialize received');
      const child = internals(manager).child(info.threadId);
      if (child?.stdout == null) throw new Error('child stdout missing');
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      let rejectedAt = 0;
      let exitObserved = false;
      let eofBeforeExit = false;
      child.once('exit', () => {
        exitObserved = true;
      });
      child.stdout.once('end', () => {
        eofBeforeExit = !exitObserved;
      });
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('initialize rejected while alive')) {
          rejectedAt = performance.now();
          aliveAtRejection = child.exitCode === null && child.signalCode === null;
        }
      });
      let reportedAt = 0;
      let aliveAtRejection = false;
      const statuses: StatusEvent[] = [];
      await manager.subscribe(info.threadId, 0, (frame) => {
        collectStatuses(statuses)(frame);
        if (statuses.some((event) => event.failure?.reason === 'connect') && reportedAt === 0) {
          reportedAt = performance.now();
        }
      });
      try {
        writeFileSync(rejectFile, 'reject');
        await waitUntil(
          () => lines.some((line) => line.msg === '[acp-threads] initialize failed'),
          5000,
          'initialize failure',
        );
        if (mode === 'eof') writeFileSync(releaseFile, 'release');
        await waitUntil(
          () => statuses.some((event) => event.failure?.reason === 'connect'),
          5000,
          'connect failure',
        );
        const failure = statuses.find((event) => event.failure?.reason === 'connect')?.failure;
        if (mode === 'live') {
          expect(rejectedAt).toBeGreaterThan(0);
          expect(reportedAt - rejectedAt).toBeLessThan(700);
          expect(aliveAtRejection).toBe(true);
          expect(failure?.agentMessage).toContain('initialize rejected while alive');
        } else {
          expect(eofBeforeExit).toBe(true);
          expect(failure?.agentMessage).toContain('release-date policy');
          expect(failure?.machineDetail).toContain(diagnostic);
        }
      } finally {
        writeFileSync(releaseFile, 'release');
        await closed;
      }
    },
    30_000,
  );

  test.each(['exit', 'retry'] as const)(
    '%s retires an outstanding sign-in consent',
    async (action) => {
      const localDir = tmp();
      const binDir = tmp();
      writeAuthenticatingAgentEntry(localDir, 'consent-agent');
      const agentPath = join(localDir, 'consent-agent.mjs');
      installNodeFixture(binDir);
      writeExecutable(
        join(binDir, 'npx'),
        `
        if (process.argv.includes('--version')) process.stdout.write('1.0.0\\n');
        else void import(${JSON.stringify(pathToFileURL(agentPath).href)});
      `,
      );
      let bridgeLoadable = true;
      const manager = makeManager(tmp(), localDir, {
        registry: new AcpRegistry({
          localDir,
          log,
          fetchImpl: async () =>
            new Response(
              JSON.stringify({
                agents: [
                  {
                    id: 'pi-acp',
                    name: 'Pi',
                    version: '1.0.0',
                    distribution: { npx: { package: '@fake/pi', env: { PATH: binDir } } },
                  },
                ],
              }),
            ),
        }),
        probePiAcpBridge: (cwd) => ({
          project: 'ready',
          cwd,
          canonicalCwd: cwd,
          bridgePath: join(cwd, 'bridge.ts'),
          trustPath: join(cwd, 'trust.json'),
          bridge: 'absent',
          trust: 'untrusted',
          bridgeLoadable,
          otherExtensions: [],
        }),
        ensurePiAcpBridge: () => {
          throw new Error('retired consent must not provision');
        },
      });
      const info = await manager.createThread({ agent: { source: 'registry', id: 'pi-acp' } });
      const events: ThreadEvent[] = [];
      const collect = (frame: ThreadServerFrame) => {
        if (frame.op === 'event') events.push(frame.event);
        if (frame.op === 'events') events.push(...frame.events);
      };
      await manager.subscribe(info.threadId, 0, collect);
      await waitUntil(
        () => manager.getInfo(info.threadId)?.status === 'auth_required',
        15_000,
        'sign-in',
      );
      bridgeLoadable = false;
      let settled = false;
      const authentication = manager
        .authenticateThread(info.threadId, 'test_login')
        .finally(() => {
          settled = true;
        })
        .catch(() => undefined);
      await waitUntil(
        () => events.some((event) => event.kind === 'pi_bridge_consent_request'),
        5000,
        'consent',
      );
      const request = events.find((event) => event.kind === 'pi_bridge_consent_request');
      if (request?.kind !== 'pi_bridge_consent_request') throw new Error('consent missing');
      bridgeLoadable = true;
      if (action === 'exit') {
        const child = internals(manager).child(info.threadId);
        if (child == null) throw new Error('child missing');
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        child.kill('SIGKILL');
        await exited;
      } else {
        writeRequestingAgentEntry(localDir, 'consent-agent', 'finish();');
        await manager.retryThread(info.threadId);
      }
      await waitUntil(() => settled, 1000, 'authentication settlement');
      await authentication;
      manager.respondPiBridgeConsent(info.threadId, request.requestId, { kind: 'granted' });
      const replay: ThreadEvent[] = [];
      await manager.subscribe(info.threadId, 0, (frame) => {
        if (frame.op === 'event') replay.push(frame.event);
        if (frame.op === 'events') replay.push(...frame.events);
      });
      expect(
        replay.some(
          (event) =>
            event.kind === 'pi_bridge_consent_resolved' &&
            event.requestId === request.requestId &&
            event.decision === 'granted',
        ),
      ).toBe(false);
    },
    30_000,
  );

  test('a live agent prompt rejection reports without waiting for process closure', async () => {
    const localDir = tmp();
    writeRequestingAgentEntry(
      localDir,
      'live-rejection',
      `
      write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'invalid prompt' } });
    `,
    );
    const manager = makeManager(tmp(), localDir);
    const info = await manager.createThread({ agent: { source: 'custom', id: 'live-rejection' } });
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');
    const child = internals(manager).child(info.threadId);
    if (child == null) throw new Error('child missing');
    const statuses: StatusEvent[] = [];
    await manager.subscribe(info.threadId, 0, collectStatuses(statuses));
    let rejectedAt = 0;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('invalid prompt')) rejectedAt = performance.now();
    });
    let reportedAt = 0;
    await manager.subscribe(info.threadId, 0, (frame) => {
      const batch =
        frame.op === 'events' ? frame.events : frame.op === 'event' ? [frame.event] : [];
      if (batch.some((event) => event.kind === 'status' && event.failure?.reason === 'prompt'))
        reportedAt = performance.now();
    });
    manager.sendPrompt(info.threadId, 'reject');
    await waitUntil(
      () => statuses.some((event) => event.failure?.reason === 'prompt'),
      5000,
      'prompt rejection',
    );
    expect(rejectedAt).toBeGreaterThan(0);
    expect(reportedAt - rejectedAt).toBeLessThan(700);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    expect(
      statuses.find((event) => event.failure?.reason === 'prompt')?.failure?.agentMessage,
    ).toBe('invalid prompt');
  }, 30_000);

  test.each(['connect', 'session-setup', 'prompt'] as const)(
    '%s failure waits for held unterminated stderr and is the only failure reported',
    async (mode) => {
      const localDir = tmp();
      const id = 'held-agent';
      const dieFile = join(localDir, 'die');
      const releaseFile = join(localDir, 'release-stdio');
      const fixture = writeHeldStdioAgentEntry(localDir, id, mode, dieFile, releaseFile);
      const manager = makeManager(tmp(), localDir);
      const info = await manager.createThread({ agent: { source: 'custom', id } });
      const statuses: StatusEvent[] = [];
      await manager.subscribe(info.threadId, 0, collectStatuses(statuses));
      if (mode === 'prompt') {
        await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 5000, 'ready');
        manager.sendPrompt(info.threadId, 'crash');
      }
      await waitUntil(() => existsSync(`${dieFile}.request`), 5000, 'request received');
      const child = internals(manager).child(info.threadId);
      if (child?.stderr == null || child.stdout == null) throw new Error('stdio missing');
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      try {
        child.stderr.pause();
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        writeFileSync(dieFile, 'exit');
        await exited;
        child.stdout.destroy();
        await new Promise<void>((resolve) => setImmediate(resolve));
        child.stderr.resume();
        writeFileSync(releaseFile, 'release');
        await closed;
        await waitUntil(
          () => statuses.some((event) => event.failure?.reason === mode),
          5000,
          'typed failure',
        );
        const detail = statuses.find((event) => event.failure?.reason === mode)?.failure
          ?.machineDetail;
        expect(detail).toContain(fixture.diagnostic);
        expect(detail).not.toContain('held-secret');
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(
          statuses.flatMap((event) => (event.failure === undefined ? [] : [event.failure.reason])),
        ).toEqual([mode]);
      } finally {
        child.stderr.resume();
        writeFileSync(releaseFile, 'release');
        await closed;
      }
    },
    20_000,
  );

  test('a resume that spawns after close terminates its rejected agent', async () => {
    const localDir = tmp();
    const id = 'resume-after-close';
    const pidFile = join(localDir, 'resumed-pid');
    const RESUMED_AGENT_SELF_EXIT_MS = 30_000;
    writeResumableAgentEntry(localDir, id, { FAKE_CAPS: 'resume' });
    const release = Promise.withResolvers<string | null>();
    const entered = Promise.withResolvers<void>();
    let hold = false;
    const manager = makeManager(tmp(), localDir, {
      resolveLoginShellPath: async () => {
        if (!hold) return null;
        entered.resolve();
        return release.promise;
      },
    });
    await manager.init();
    const info = await manager.createThread({ agent: { source: 'custom', id } });
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 5000, 'ready');
    manager.sendPrompt(info.threadId, 'retain history');
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 5000, 'prompt');
    await manager.closeThread(info.threadId);
    writeFileSync(
      join(localDir, `${id}.mjs`),
      `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      setTimeout(() => process.exit(0), ${RESUMED_AGENT_SELF_EXIT_MS});
      process.stdin.once('data', (chunk) => {
        const msg = JSON.parse(chunk.toString());
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id,
          error: { code: -32603, message: 'resume initialization refused' } }) + '\\n');
      });
      `,
    );
    hold = true;
    const resumed = manager.resumeThread(info.threadId).catch((error: unknown) => error);
    await entered.promise;
    await manager.closeThread(info.threadId);
    expect(manager.getInfo(info.threadId)?.archived).toBe(true);
    release.resolve(null);
    expect(await resumed).toMatchObject({ code: 'spawn-failed' });
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(
      isValidLockPid(pid),
      `resumed-pid held ${JSON.stringify(readFileSync(pidFile, 'utf8'))}`,
    ).toBe(true);
    await expect
      .poll(
        () => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 3000 },
      )
      .toBe(false);
    const replay: ThreadEvent[] = [];
    await manager.subscribe(info.threadId, 0, (frame) => {
      if (frame.op === 'event') replay.push(frame.event);
      if (frame.op === 'events') replay.push(...frame.events);
    });
    expect(replay.at(-1)).toMatchObject({ kind: 'status', detail: 'thread closed' });
  }, 15_000);

  test.each(['prompt', 'resume'] as const)(
    'closing during %s diagnostics keeps thread closed last in replayed history',
    async (mode) => {
      const localDir = tmp();
      const id = 'close-during-drain';
      const dieFile = join(localDir, 'die');
      const releaseFile = join(localDir, 'release-stdio');
      writeResumableAgentEntry(localDir, id, { FAKE_CAPS: 'resume' });
      const lines: { obj: Record<string, unknown>; msg: string }[] = [];
      const manager = makeManager(tmp(), localDir, { log: capturingLog(lines) });
      await manager.init();
      const info = await manager.createThread({ agent: { source: 'custom', id } });
      await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 5000, 'ready');
      manager.sendPrompt(info.threadId, 'retain history');
      await waitUntil(
        () => manager.getInfo(info.threadId)?.status === 'ready',
        5000,
        'prompt complete',
      );
      await manager.closeThread(info.threadId);
      const fixture = writeHeldStdioAgentEntry(localDir, id, mode, dieFile, releaseFile);
      const resumed = manager.resumeThread(info.threadId).catch((error: unknown) => error);
      if (mode === 'prompt') {
        await resumed;
        manager.sendPrompt(info.threadId, 'crash');
      }
      await waitUntil(() => existsSync(`${dieFile}.request`), 5000, 'prompt received');
      const child = internals(manager).child(info.threadId);
      if (child?.stdout == null) throw new Error('child stdout missing');
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      const events: ThreadEvent[] = [];
      await manager.subscribe(
        info.threadId,
        manager.getInfo(info.threadId)?.lastSeq ?? 0,
        (frame) => {
          if (frame.op === 'event') events.push(frame.event);
          if (frame.op === 'events') events.push(...frame.events);
        },
      );
      try {
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        writeFileSync(dieFile, 'exit');
        await exited;
        child.stdout.destroy();
        if (mode === 'prompt') {
          await waitUntil(
            () => events.some((event) => event.kind === 'turn_ended'),
            5000,
            'prompt rejected',
          );
        } else {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        await manager.closeThread(info.threadId);
        expect(manager.getInfo(info.threadId)?.archived).toBe(true);
        writeFileSync(releaseFile, 'release');
        await closed;
        await resumed;
        await new Promise<void>((resolve) => setImmediate(resolve));
        const replay: StatusEvent[] = [];
        await manager.subscribe(info.threadId, 0, collectStatuses(replay));
        expect(replay.some((event) => event.detail === 'thread closed')).toBe(true);
        expect(replay.at(-1)?.detail).toBe('thread closed');
        expect(manager.getInfo(info.threadId)?.status).toBe('exited');
        const suppressed = lines.find(
          (line) =>
            line.obj.suppressed === true &&
            line.obj.reason === (mode === 'prompt' ? 'prompt' : 'connect'),
        );
        expect(suppressed?.obj.threadId).toBe(info.threadId);
        expect(suppressed?.obj.machineDetail).toContain(fixture.diagnostic);
        expect(JSON.stringify(suppressed)).not.toContain('held-secret');
      } finally {
        writeFileSync(releaseFile, 'release');
        await closed;
      }
    },
    20_000,
  );

  test('an exited agent reports within the drain bound while a descendant holds stdio', async () => {
    const localDir = tmp();
    const id = 'held-agent';
    const dieFile = join(localDir, 'die');
    const releaseFile = join(localDir, 'release-stdio');
    writeHeldStdioAgentEntry(localDir, id, 'ready', dieFile, releaseFile);
    const manager = makeManager(tmp(), localDir);
    const info = await manager.createThread({ agent: { source: 'custom', id } });
    const statuses: StatusEvent[] = [];
    await manager.subscribe(info.threadId, 0, collectStatuses(statuses));
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 5000, 'ready');
    const child = internals(manager).child(info.threadId);
    if (child == null) throw new Error('child missing');
    let didClose = false;
    const closed = new Promise<void>((resolve) =>
      child.once('close', () => {
        didClose = true;
        resolve();
      }),
    );
    try {
      writeFileSync(dieFile, 'exit');
      await waitUntil(
        () => statuses.some((event) => event.detail === 'agent exited (7)'),
        3000,
        'bounded exit',
      );
      expect(didClose).toBe(false);
      expect(internals(manager).child(info.threadId)).toBeNull();
    } finally {
      writeFileSync(releaseFile, 'release');
      await closed;
    }
  }, 20_000);

  test('an agent that dies while waiting for sign-in reports the crash', async () => {
    const localDir = tmp();
    const id = 'held-agent';
    const dieFile = join(localDir, 'die');
    const releaseFile = join(localDir, 'release-stdio');
    writeHeldStdioAgentEntry(localDir, id, 'auth', dieFile, releaseFile);
    const manager = makeManager(tmp(), localDir);
    const info = await manager.createThread({ agent: { source: 'custom', id } });
    const statuses: StatusEvent[] = [];
    await manager.subscribe(info.threadId, 0, collectStatuses(statuses));
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'auth_required',
      5000,
      'sign in',
    );
    const child = internals(manager).child(info.threadId);
    if (child == null) throw new Error('child missing');
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    try {
      writeFileSync(dieFile, 'exit');
      writeFileSync(releaseFile, 'release');
      await waitUntil(
        () => statuses.some((event) => event.failure?.reason === 'exited'),
        5000,
        'the crash to be reported',
      );
      expect(statuses.find((event) => event.failure?.reason === 'exited')?.failure).toMatchObject({
        exit: { exitCode: 7, signal: null },
      });
      expect(
        statuses.flatMap((event) => (event.failure === undefined ? [] : [event.failure.reason])),
      ).toEqual(['auth-required', 'exited']);
    } finally {
      writeFileSync(releaseFile, 'release');
      await closed;
    }
  }, 20_000);

  test.each(['eof-first', 'exit-first'] as const)(
    'an agent that dies during a sign-in ends exited with one crash card when %s',
    async (order) => {
      const localDir = tmp();
      const id = 'held-agent';
      const dieFile = join(localDir, 'die');
      const releaseFile = join(localDir, 'release-stdio');
      writeHeldStdioAgentEntry(localDir, id, 'auth', dieFile, releaseFile);
      const manager = makeManager(tmp(), localDir);
      const info = await manager.createThread({ agent: { source: 'custom', id } });
      const statuses: StatusEvent[] = [];
      await manager.subscribe(info.threadId, 0, collectStatuses(statuses));
      await waitUntil(
        () => manager.getInfo(info.threadId)?.status === 'auth_required',
        5000,
        'sign in',
      );
      const child = internals(manager).child(info.threadId);
      if (child?.stdout == null) throw new Error('child stdout missing');
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      try {
        const signIn = manager
          .authenticateThread(info.threadId, 'login')
          .catch((error: unknown) => error);
        await waitUntil(
          () => manager.getInfo(info.threadId)?.status === 'authenticating',
          5000,
          'signing in',
        );
        if (order === 'eof-first') {
          child.stdout.destroy();
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        writeFileSync(dieFile, 'exit');
        await exited;
        writeFileSync(releaseFile, 'release');
        await closed;
        expect(await signIn).toMatchObject({ code: 'agent-exited' });
        await waitUntil(
          () => statuses.some((event) => event.failure?.reason === 'exited'),
          5000,
          'the crash to be reported',
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(
          statuses.flatMap((event) => (event.failure === undefined ? [] : [event.failure.reason])),
        ).toEqual(['auth-required', 'exited']);
        expect(manager.getInfo(info.threadId)?.status).toBe('exited');
      } finally {
        writeFileSync(releaseFile, 'release');
        await closed;
      }
    },
    20_000,
  );

  test('a drained old exit cannot replace the ready status or handle of a retried agent', async () => {
    const localDir = tmp();
    const id = 'held-agent';
    const dieFile = join(localDir, 'die');
    const releaseFile = join(localDir, 'release-stdio');
    writeHeldStdioAgentEntry(localDir, id, 'auth', dieFile, releaseFile);
    const manager = makeManager(tmp(), localDir);
    const info = await manager.createThread({ agent: { source: 'custom', id } });
    const statuses: StatusEvent[] = [];
    await manager.subscribe(info.threadId, 0, collectStatuses(statuses));
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'auth_required',
      5000,
      'sign in',
    );
    const original = internals(manager).child(info.threadId);
    if (original == null) throw new Error('child missing');
    const closed = new Promise<void>((resolve) => original.once('close', () => resolve()));
    try {
      const exited = new Promise<void>((resolve) => original.once('exit', () => resolve()));
      writeFileSync(dieFile, 'exit');
      await exited;
      await expect(manager.authenticateThread(info.threadId, 'login')).rejects.toThrow(
        'is no longer running',
      );
      writeRequestingAgentEntry(localDir, id, 'finish();');
      expect((await manager.retryThread(info.threadId)).status).toBe('ready');
      const replacement = internals(manager).child(info.threadId);
      expect(replacement).toBeTruthy();
      expect(replacement).not.toBe(original);
      const retryHistory: StatusEvent[] = [];
      await manager.subscribe(info.threadId, 0, collectStatuses(retryHistory));
      const afterRetry = retryHistory.length;
      writeFileSync(releaseFile, 'release');
      await closed;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(manager.getInfo(info.threadId)?.status).toBe('ready');
      expect(internals(manager).child(info.threadId)).toBe(replacement);
      const drainedHistory: StatusEvent[] = [];
      await manager.subscribe(info.threadId, 0, collectStatuses(drainedHistory));
      expect(drainedHistory.slice(afterRetry).some((event) => event.status === 'exited')).toBe(
        false,
      );
    } finally {
      writeFileSync(releaseFile, 'release');
      await closed;
    }
  }, 20_000);
});

describe('agent failures reach the server log', () => {
  test('an agent that dies before the handshake logs its last words', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const lines: { obj: Record<string, unknown>; msg: string }[] = [];
    writeCrashingAgentEntry(
      localDir,
      'crasher',
      'dyld[5034]: Library not loaded: libicui18n.74.dylib',
    );

    const manager = makeManager(contentDir, localDir, { log: capturingLog(lines) });
    const info = await manager.createThread({ agent: { source: 'custom', id: 'crasher' } });
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'error',
      15_000,
      'the thread to fail',
    );

    const failureLine = lines.find((l) => l.msg.includes('thread failure status'));
    expect(failureLine).toBeDefined();
    expect(String(failureLine?.obj.detail)).not.toContain('libicui18n.74.dylib');
    expect(String(failureLine?.obj.machineDetail)).toContain('libicui18n.74.dylib');
  }, 30_000);

  test.each(['terminated', 'unterminated'] as const)(
    'an agent that dies after going ready emits bounded redacted exit detail from %s stderr and logs it',
    async (shape) => {
      const contentDir = tmp();
      const localDir = tmp();
      const lines: { obj: Record<string, unknown>; msg: string }[] = [];
      const dieFile = join(localDir, 'die-now');
      const stderr = [
        ...Array.from({ length: 39 }, () => 'x'.repeat(480)),
        'agent ran out of memory https://alice:fixture-exit-secret@registry.example.test/pkg',
      ].join('\n');
      const { preExitStderr } = writeExitAfterReadyAgentEntry(
        localDir,
        'quitter',
        { text: stderr, terminated: shape === 'terminated' },
        dieFile,
      );

      const manager = makeManager(contentDir, localDir, { log: capturingLog(lines) });
      const info = await manager.createThread({ agent: { source: 'custom', id: 'quitter' } });
      const statuses: StatusEvent[] = [];
      await manager.subscribe(info.threadId, 0, collectStatuses(statuses));
      await waitUntil(
        () => manager.getInfo(info.threadId)?.status === 'ready',
        15_000,
        'the agent to go ready',
      );
      const child = internals(manager).child(info.threadId);
      if (child?.stderr == null) throw new Error('agent stderr is unavailable');
      let observedStderr = '';
      child.stderr.on('data', (chunk: string) => {
        observedStderr += chunk;
      });
      writeFileSync(`${dieFile}.stderr`, 'write');
      await waitUntil(
        () => observedStderr.includes(preExitStderr),
        5000,
        'parent receives crash stderr',
      );
      child.stderr.pause();
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      writeFileSync(dieFile, 'now');
      await exited;
      expect(internals(manager).child(info.threadId)).toBeNull();
      child.stderr.resume();
      await waitUntil(
        () => lines.some((line) => line.msg.includes('agent exited unexpectedly')),
        15_000,
        'the agent process exit to be logged',
      );

      await waitUntil(
        () =>
          statuses.some(
            (event) => event.status === 'exited' && event.detail?.startsWith('agent exited (7)'),
          ),
        5000,
        'the process exit status detail',
      );
      const exitEvent = statuses.find(
        (event) => event.status === 'exited' && event.detail?.startsWith('agent exited (7)'),
      );
      expect(exitEvent?.detail).toBe('agent exited (7)');
      expect(exitEvent?.failure?.reason).toBe('exited');
      expect(exitEvent?.failure?.agentMessage).toBeUndefined();
      expect(exitEvent?.failure?.exit).toEqual({
        exitCode: 7,
        signal: null,
        cause: 'out-of-memory',
      });
      expect(exitEvent?.failure?.machineDetail).toContain('ran out of memory');
      expect(exitEvent?.failure?.machineDetail).not.toContain('fixture-exit-secret');
      expect(exitEvent?.failure?.machineDetail?.length).toBeLessThanOrEqual(16_000);
      const exitLine = lines.find((l) => l.msg.includes('agent exited unexpectedly'));
      expect(exitLine).toBeDefined();
      expect(exitLine?.obj.code).toBe(7);
      expect(String(exitLine?.obj.machineDetail)).toContain('ran out of memory');
      expect(String(exitLine?.obj.machineDetail)).not.toContain('fixture-exit-secret');
    },
    30_000,
  );
});

const CODEX_WARNING_TEXT = codexFixture.candidates.find((c) => c.name === 'warning-skills-budget')
  ?.update.content.text as string;
const CODEX_NEIGHBOR_TEXTS = [
  codexFixture.neighbors.contextCompacted.update.content.text,
  codexFixture.neighbors.turnError.update.content.text,
] as const;

function codexLegacyTurnTexts(): string[] {
  const [compacted, turnError] = CODEX_NEIGHBOR_TEXTS;
  return [compacted, compacted, turnError, CODEX_WARNING_TEXT, turnError, compacted, turnError];
}

function agentTextUpdate(text: string): unknown {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } };
}

function writeRegistryAgentShims(binDir: string, updates: readonly unknown[]): void {
  const agentPath = join(binDir, 'agent.mjs');
  writeFileSync(
    agentPath,
    `
const write = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const UPDATES = ${JSON.stringify(updates)};
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    const reply = (result) => write({ jsonrpc: '2.0', id: msg.id, result });
    if (msg.method === 'initialize') {
      reply({ protocolVersion: 1, agentCapabilities: {} });
    } else if (msg.method === 'session/new') {
      reply({ sessionId: 'sess-fixed' });
    } else if (msg.method === 'session/prompt') {
      const burst = UPDATES.map((update) =>
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: 'sess-fixed', update },
        }),
      ).join('\\n');
      process.stdout.write(burst + '\\n');
      reply({ stopReason: 'end_turn' });
    } else if (msg.id !== undefined) {
      reply({});
    }
  }
});
`,
  );
  writeFileSync(join(binDir, 'npx'), `#!/bin/sh\nexec "${process.execPath}" "${agentPath}"\n`, {
    mode: 0o755,
  });
  writeFileSync(
    join(binDir, 'node'),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v${process.versions.node}; exit 0; fi\nexec "${process.execPath}" "$@"\n`,
    { mode: 0o755 },
  );
}

function registryManagerFor(
  agentId: string,
  contentDir: string,
  localDir: string,
  binDir: string,
  extra?: Parameters<typeof makeManager>[2],
): AcpThreadManager {
  const manifest = {
    id: agentId,
    name: agentId,
    version: '1.6.2',
    distribution: { npx: { package: `@fake/${agentId}`, env: { PATH: binDir } } },
  };
  return makeManager(contentDir, localDir, {
    registry: new AcpRegistry({
      localDir,
      log,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ agents: [manifest] }), {
          status: 200,
        })) as unknown as typeof fetch,
    }),
    ...extra,
  });
}

describe.skipIf(process.platform === 'win32')('Codex legacy warning event boundaries', () => {
  type Retained = { seq: number; event: ThreadEvent };

  const collectAll =
    (into: Retained[]) =>
    (frame: ThreadServerFrame): void => {
      if (frame.op === 'event') into.push({ seq: frame.seq, event: frame.event });
      if (frame.op === 'events') {
        for (const [i, event] of frame.events.entries()) {
          into.push({ seq: frame.fromSeq + i, event });
        }
      }
    };

  const messageTexts = (retained: Retained[]): string[] =>
    retained
      .map((r) => r.event)
      .filter((e) => e.kind === 'session_update')
      .map((e) => (e as { update: Record<string, unknown> }).update)
      .filter((u) => u.sessionUpdate === 'agent_message_chunk')
      .map((u) => (u.content as { text: string }).text);

  async function runTurn(
    agentId: string,
    contentDir: string,
    localDir: string,
    binDir: string,
  ): Promise<{ manager: AcpThreadManager; threadId: string; retained: Retained[] }> {
    writeRegistryAgentShims(binDir, codexLegacyTurnTexts().map(agentTextUpdate));
    const manager = registryManagerFor(agentId, contentDir, localDir, binDir);
    await manager.init();
    const info = await manager.createThread({ agent: { source: 'registry', id: agentId } });
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'ready',
      15_000,
      'agent ready',
    );
    manager.sendPrompt(info.threadId, 'go');
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'turn ended');
    const retained: Retained[] = [];
    await manager.subscribe(info.threadId, 0, collectAll(retained));
    return { manager, threadId: info.threadId, retained };
  }

  test('a registry Codex warning is retained as its own event, never merged', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const { retained } = await runTurn('codex-acp', contentDir, localDir, tmp());
    const texts = messageTexts(retained);

    expect(texts.filter((t) => t === CODEX_WARNING_TEXT)).toHaveLength(1);
    expect(texts.filter((t) => t !== CODEX_WARNING_TEXT && t.includes(CODEX_WARNING_TEXT))).toEqual(
      [],
    );
  }, 45_000);

  test('the retained log keeps the producer bytes, kinds, and order intact', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const { retained } = await runTurn('codex-acp', contentDir, localDir, tmp());

    expect(messageTexts(retained).join('')).toBe(codexLegacyTurnTexts().join(''));
    expect(retained.map((r) => r.event.kind)).not.toContain('agent_notice');
    expect(retained.map((r) => r.seq)).toEqual(retained.map((_, i) => i));
  }, 45_000);

  test('ordinary no-ID chrome around the warning still coalesces', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const { retained } = await runTurn('codex-acp', contentDir, localDir, tmp());
    const texts = messageTexts(retained);

    expect(texts.length).toBeLessThan(codexLegacyTurnTexts().length);
    expect(
      texts.some((t) => t !== CODEX_WARNING_TEXT && t.length > CODEX_NEIGHBOR_TEXTS[0].length),
    ).toBe(true);
  }, 45_000);

  test('the same envelope from another registry agent is coalesced as before', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const { retained } = await runTurn('claude-acp', contentDir, localDir, tmp());
    const texts = messageTexts(retained);

    expect(texts).not.toContain(CODEX_WARNING_TEXT);
    expect(texts.filter((t) => t.includes(CODEX_WARNING_TEXT))).toHaveLength(1);
    expect(texts.join('')).toBe(codexLegacyTurnTexts().join(''));
  }, 45_000);

  test('the warning occupies one NDJSON line at its own seq', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const { manager, threadId, retained } = await runTurn('codex-acp', contentDir, localDir, tmp());
    await manager.closeThread(threadId);

    const lines = readFileSync(join(localDir, 'threads', `${threadId}.ndjson`), 'utf8')
      .split('\n')
      .filter((line) => line !== '');
    const warningLines = lines.filter(
      (line) => messageTexts([{ seq: 0, event: JSON.parse(line) }])[0] === CODEX_WARNING_TEXT,
    );

    expect(warningLines).toHaveLength(1);
    expect(lines.indexOf(warningLines[0])).toBe(
      retained.find((r) => messageTexts([r])[0] === CODEX_WARNING_TEXT)?.seq,
    );
  }, 45_000);

  test('a persisted warning replays with the same bytes, kind, and position', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const binDir = tmp();
    const { manager, threadId, retained } = await runTurn(
      'codex-acp',
      contentDir,
      localDir,
      binDir,
    );
    const live = retained.map((r) => r.event);
    await manager.closeThread(threadId);

    const reopened = registryManagerFor('codex-acp', contentDir, localDir, binDir);
    await reopened.init();
    const replayed: Retained[] = [];
    await reopened.subscribe(threadId, 0, collectAll(replayed));

    const warningSeq = (rows: Retained[]): number[] =>
      rows.filter((r) => messageTexts([r])[0] === CODEX_WARNING_TEXT).map((r) => r.seq);

    expect(messageTexts(replayed)).toEqual(messageTexts(retained));
    expect(replayed.map((r) => r.event.kind).slice(0, live.length)).toEqual(
      live.map((e) => e.kind),
    );
    expect(warningSeq(replayed)).toEqual(warningSeq(retained));
    expect(replayed.map((r) => r.seq)).toEqual(replayed.map((_, i) => i));
  }, 60_000);
});

describe.skipIf(process.platform === 'win32')('a typed session notice mid-turn', () => {
  const BEFORE = 'chunk emitted before the notice';
  const AFTER = 'chunk emitted after the notice';

  const typedNotice = {
    sessionUpdate: 'notice',
    severity: 'warning',
    title: 'skill bundle exceeded its budget',
  };

  type NoticeTurns = {
    manager: AcpThreadManager;
    threadId: string;
    updates: () => Promise<Record<string, unknown>[]>;
    promptAgain: () => Promise<void>;
  };

  async function startThreadEmittingNotice(): Promise<NoticeTurns> {
    const contentDir = tmp();
    const localDir = tmp();
    const binDir = tmp();
    writeRegistryAgentShims(binDir, [agentTextUpdate(BEFORE), typedNotice, agentTextUpdate(AFTER)]);
    const manager = registryManagerFor('codex-acp', contentDir, localDir, binDir);
    await manager.init();
    const info = await manager.createThread({ agent: { source: 'registry', id: 'codex-acp' } });
    const ready = (what: string) =>
      waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, what);
    await ready('agent ready');

    const promptAgain = async () => {
      manager.sendPrompt(info.threadId, 'go');
      await ready('turn ended');
    };
    await promptAgain();

    return {
      manager,
      threadId: info.threadId,
      promptAgain,
      updates: async () => {
        const events: ThreadEvent[] = [];
        const sink = (frame: ThreadServerFrame) => {
          if (frame.op === 'event') events.push(frame.event);
          if (frame.op === 'events') events.push(...frame.events);
        };
        await manager.subscribe(info.threadId, 0, sink);
        manager.unsubscribe(info.threadId, sink);
        return events
          .filter((e) => e.kind === 'session_update')
          .map((e) => (e as { update: Record<string, unknown> }).update);
      },
    };
  }

  const textOf = (updates: Record<string, unknown>[]): string =>
    updates.map((u) => (u.content as { text?: string })?.text ?? '').join('');

  test('never reaches the thread event log, while its turn-mates do', async () => {
    const updates = await (await startThreadEmittingNotice()).updates();

    expect(new Set(updates.map((u) => u.sessionUpdate))).toEqual(new Set(['agent_message_chunk']));
    expect(textOf(updates)).toContain(BEFORE);
    expect(textOf(updates)).toContain(AFTER);
  }, 45_000);

  test('leaves the connection usable for a whole further turn', async () => {
    const thread = await startThreadEmittingNotice();
    const firstTurn = textOf(await thread.updates());

    await thread.promptAgain();
    const bothTurns = textOf(await thread.updates());

    expect(bothTurns.split(AFTER)).toHaveLength(3);
    expect(bothTurns.length).toBe(firstTurn.length * 2);
    expect(thread.manager.getInfo(thread.threadId)?.status).toBe('ready');
  }, 60_000);
});

describe('AcpThreadManager project skill delivery', () => {
  const BLOCKS_AGENT = `
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
const notify = (update) =>
  write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update } });
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    const reply = (result) =>
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    if (msg.method === 'initialize') {
      reply({
        protocolVersion: 1,
        agentCapabilities: {
          promptCapabilities: { embeddedContext: process.env.FAKE_EMBEDDED === '1' },
        },
      });
    } else if (msg.method === 'session/new') {
      reply({ sessionId: 's1' });
    } else if (msg.method === 'session/prompt') {
      notify({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'blocks:' + JSON.stringify(msg.params.prompt) },
      });
      reply({ stopReason: 'end_turn' });
    } else if (msg.id !== undefined) {
      reply({});
    }
  }
});
`;

  type EchoedBlock = { type: string; text?: string; resource?: Record<string, string> };

  function writeBlocksAgent(localDir: string, id: string, embeddedContext: boolean): void {
    const agentPath = join(localDir, `${id}-blocks-agent.mjs`);
    writeFileSync(agentPath, BLOCKS_AGENT);
    writeFileSync(
      join(localDir, 'acp-agents.json'),
      JSON.stringify([
        {
          id,
          name: `Fake ${id}`,
          command: 'node',
          args: [agentPath],
          env: { FAKE_EMBEDDED: embeddedContext ? '1' : '0' },
        },
      ]),
    );
  }

  async function firstPromptBlocks(
    manager: AcpThreadManager,
    agentId: string,
    prompt: string,
    source: 'custom' | 'registry' = 'custom',
  ): Promise<EchoedBlock[]> {
    const info = await manager.createThread({ agent: { source, id: agentId } });
    const events: ThreadEvent[] = [];
    await manager.subscribe(info.threadId, 0, (frame: ThreadServerFrame) => {
      if (frame.op === 'event') events.push(frame.event);
      if (frame.op === 'events') events.push(...frame.events);
    });
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');
    manager.sendPrompt(info.threadId, prompt);
    const echoed = (): string | undefined =>
      events
        .filter((e) => e.kind === 'session_update')
        .map((e) => (e.update as { content?: { text?: string } }).content?.text ?? '')
        .find((text) => text.startsWith('blocks:'));
    await waitUntil(() => echoed() !== undefined, 15_000, 'echoed prompt blocks');
    return JSON.parse((echoed() as string).slice('blocks:'.length)) as EchoedBlock[];
  }

  function geminiRegistryManager(
    localDir: string,
    embeddedContext: boolean,
    extra?: Parameters<typeof makeManager>[2],
  ): AcpThreadManager {
    const binDir = tmp();
    writeRegistryAgentShims(binDir, []);
    writeFileSync(
      join(binDir, 'agent.mjs'),
      `process.env.FAKE_EMBEDDED = ${JSON.stringify(embeddedContext ? '1' : '0')};\n${BLOCKS_AGENT}`,
    );
    return registryManagerFor('gemini', tmp(), localDir, binDir, extra);
  }

  const bundledSkillText = (): string =>
    readFileSync(
      join(resolveBundledSkillDir('project', { checkDesktop: false }), PROJECT_SKILL_ENTRY),
      'utf8',
    );

  test('stages the shipped bundle under localDir and points the first prompt at it', async () => {
    const localDir = tmp();
    writeBlocksAgent(localDir, 'pointer-agent', false);
    const manager = makeManager(tmp(), localDir);

    const blocks = await firstPromptBlocks(manager, 'pointer-agent', 'hello');
    expect(blocks).toEqual([{ type: 'text', text: `${stagedSkillNote(localDir)}\n\nhello` }]);
    expect(readFileSync(stagedSkillPath(localDir), 'utf8')).toBe(bundledSkillText());
    expect(existsSync(join(projectSkillStageDir(localDir), 'references'))).toBe(true);
  }, 30_000);

  test('a custom agent named gemini receives the ordinary path pointer', async () => {
    const localDir = tmp();
    writeBlocksAgent(localDir, 'gemini', true);
    const manager = makeManager(tmp(), localDir);

    const blocks = await firstPromptBlocks(manager, 'gemini', 'hello');
    expect(blocks).toEqual([{ type: 'text', text: `${stagedSkillNote(localDir)}\n\nhello` }]);
  }, 30_000);

  test('a content subfolder still receives the pointer above its cwd', async () => {
    const projectDir = tmp();
    const contentDir = join(projectDir, 'docs');
    const localDir = join(projectDir, '.ok', 'local');
    mkdirSync(contentDir, { recursive: true });
    mkdirSync(localDir, { recursive: true });
    writeBlocksAgent(localDir, 'subfolder-agent', false);
    const lines: { obj: Record<string, unknown>; msg: string }[] = [];
    const manager = makeManager(contentDir, localDir, { log: capturingLog(lines) });

    const blocks = await firstPromptBlocks(manager, 'subfolder-agent', 'hello');
    expect(isWithin(contentDir, stagedSkillPath(localDir))).toBe(false);
    expect(blocks).toEqual([{ type: 'text', text: `${stagedSkillNote(localDir)}\n\nhello` }]);
    expect(lines.some((line) => line.msg.includes('skill staged above agent cwd'))).toBe(true);
  }, 30_000);

  test('concurrent connects share staging and a later connect still repairs changes', async () => {
    const localDir = tmp();
    writeBlocksAgent(localDir, 'concurrent-agent', false);
    const lines: { obj: Record<string, unknown>; msg: string }[] = [];
    const barrier = Promise.withResolvers<void>();
    let coordinate = false;
    let arrivals = 0;
    const manager = makeManager(tmp(), localDir, {
      log: capturingLog(lines),
      resolveLoginShellPath: async () => {
        if (coordinate) {
          arrivals += 1;
          if (arrivals === 2) barrier.resolve();
          await barrier.promise;
        }
        return null;
      },
    });
    await manager.init();
    coordinate = true;
    const stage = vi.spyOn(projectSkillStaging, 'stageProjectSkill');
    await Promise.all([
      firstPromptBlocks(manager, 'concurrent-agent', 'first'),
      firstPromptBlocks(manager, 'concurrent-agent', 'second'),
    ]);
    expect(stage).toHaveBeenCalledTimes(1);
    const staged = lines.find((line) => line.msg.includes('project skill staged'));
    expect(staged?.obj).toMatchObject({ localDir });
    expect(staged?.obj).not.toHaveProperty('threadId');
    expect(staged?.obj).not.toHaveProperty('agentId');

    coordinate = false;
    writeFileSync(stagedSkillPath(localDir), 'modified');
    await firstPromptBlocks(manager, 'concurrent-agent', 'third');
    expect(stage).toHaveBeenCalledTimes(2);
    expect(readFileSync(stagedSkillPath(localDir), 'utf8')).toBe(bundledSkillText());
  }, 30_000);

  test.skipIf(process.platform === 'win32')(
    'registry gemini receives no pointer when the inline skill cannot be read',
    async () => {
      const localDir = tmp();
      const sourceDir = tmp();
      mkdirSync(join(sourceDir, PROJECT_SKILL_ENTRY));
      const lines: { obj: Record<string, unknown>; msg: string }[] = [];
      const manager = geminiRegistryManager(localDir, true, {
        projectSkillSourceDir: sourceDir,
        log: capturingLog(lines),
      });

      const blocks = await firstPromptBlocks(manager, 'gemini', 'hello', 'registry');
      expect(blocks).toEqual([{ type: 'text', text: `${ACP_ENVIRONMENT_NOTE}\n\nhello` }]);
      const failure = lines.find((line) => line.msg.includes('skill inline read failed'));
      expect(failure?.obj.err).toMatchObject({ code: 'EISDIR' });
    },
    30_000,
  );

  test('sends the plain note when staging fails, and never blocks the spawn', async () => {
    const localDir = tmp();
    writeBlocksAgent(localDir, 'degrade-agent', false);
    const manager = makeManager(tmp(), localDir, {
      projectSkillSourceDir: join(localDir, 'no-such-bundle'),
    });

    const blocks = await firstPromptBlocks(manager, 'degrade-agent', 'hello');
    expect(blocks).toEqual([{ type: 'text', text: `${ACP_ENVIRONMENT_NOTE}\n\nhello` }]);
    expect(existsSync(projectSkillStageDir(localDir))).toBe(false);
  }, 30_000);

  test('sends the plain note when staging is switched off', async () => {
    const localDir = tmp();
    writeBlocksAgent(localDir, 'off-agent', false);
    const manager = makeManager(tmp(), localDir, { projectSkillSourceDir: null });

    const blocks = await firstPromptBlocks(manager, 'off-agent', 'hello');
    expect(blocks).toEqual([{ type: 'text', text: `${ACP_ENVIRONMENT_NOTE}\n\nhello` }]);
    expect(existsSync(projectSkillStageDir(localDir))).toBe(false);
  }, 30_000);

  test.skipIf(process.platform === 'win32')(
    'registry gemini gets the skill body inline as an embedded resource',
    async () => {
      const localDir = tmp();
      const manager = geminiRegistryManager(localDir, true);

      const blocks = await firstPromptBlocks(manager, 'gemini', 'hello', 'registry');
      const skillPath = stagedSkillPath(localDir);
      expect(blocks).toEqual([
        { type: 'text', text: `${buildEnvironmentNote({ skillPath, inline: true })}\n\nhello` },
        {
          type: 'resource',
          resource: {
            uri: pathToFileURL(skillPath).href,
            mimeType: 'text/markdown',
            text: bundledSkillText(),
          },
        },
      ]);
    },
    30_000,
  );

  test.skipIf(process.platform === 'win32')(
    'registry gemini without embeddedContext still gets the body, as a text block',
    async () => {
      const localDir = tmp();
      const manager = geminiRegistryManager(localDir, false);

      const blocks = await firstPromptBlocks(manager, 'gemini', 'hello', 'registry');
      expect(blocks).toHaveLength(2);
      expect(blocks[0]?.type).toBe('text');
      expect(blocks[1]?.type).toBe('text');
      expect(blocks[1]?.text).toContain(bundledSkillText());
    },
    30_000,
  );
});

describe('status frames for an open that installs nothing', () => {
  test('a custom agent start never reports installing', async () => {
    const localDir = tmp();
    writeExampleAgentEntry(localDir);
    const manager = makeManager(tmp(), localDir);

    const info = await manager.createThread({ agent: { source: 'custom', id: 'example' } });
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'ready',
      15_000,
      'the custom agent to become ready',
    );

    const statuses = await statusesOf(manager, info.threadId);
    expect(info.status).toBe('spawning');
    expect(statuses[0]).toBe('spawning');
    expect(statuses).not.toContain('installing');
  }, 30_000);

  test('a custom agent retry never reports installing', async () => {
    const localDir = tmp();
    writeRequestingAgentEntry(
      localDir,
      'retry-no-install',
      "write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'prompt failed' } });",
    );
    const manager = makeManager(tmp(), localDir);

    const info = await manager.createThread({
      agent: { source: 'custom', id: 'retry-no-install' },
    });
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');
    manager.sendPrompt(info.threadId, 'fail this turn');
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'error',
      15_000,
      'the prompt failure',
    );
    writeRequestingAgentEntry(localDir, 'retry-no-install', 'finish();');
    const beforeRetry = (await statusesOf(manager, info.threadId)).length;

    expect((await manager.retryThread(info.threadId)).status).toBe('ready');

    const afterRetry = (await statusesOf(manager, info.threadId)).slice(beforeRetry);
    expect(afterRetry[0]).toBe('spawning');
    expect(afterRetry).not.toContain('installing');
  }, 45_000);

  test('a custom agent resume never reports installing', async () => {
    const localDir = tmp();
    writeResumableAgentEntry(localDir, 'resume-no-install', { FAKE_CAPS: 'resume,load' });
    const manager = makeManager(tmp(), localDir);
    await manager.init();

    const info = await manager.createThread({
      agent: { source: 'custom', id: 'resume-no-install' },
    });
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');
    manager.sendPrompt(info.threadId, 'retain this session');
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'turn ended');
    await manager.closeThread(info.threadId);
    const beforeResume = (await statusesOf(manager, info.threadId)).length;

    await manager.resumeThread(info.threadId);
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'ready',
      15_000,
      'the resumed thread to become ready',
    );

    const afterResume = (await statusesOf(manager, info.threadId)).slice(beforeResume);
    expect(afterResume[0]).toBe('spawning');
    expect(afterResume).not.toContain('installing');
  }, 45_000);
});

describe('registry adapter acquisition probe scope across thread opens', () => {
  const PINNED_ADAPTER = 'probe-scope-manager-fixture';
  const PINNED_DESCRIPTOR = `${PINNED_ADAPTER}@7.0.0`;

  const acquisitionBin = (home: string, agentSource: string): { bin: string; probeLog: string } => {
    const bin = join(home, 'bin');
    mkdirSync(bin);
    installNodeFixture(bin);
    const probeLog = join(home, 'probes.log');
    writeExecutable(
      join(bin, 'npx'),
      `if (process.argv.slice(2).join(' ') === '--version') process.exit(0);\n${agentSource}`,
    );
    writeRecordingNpm(bin, probeLog);
    return { bin, probeLog };
  };

  const recordingAcquisitionBin = (home: string): { bin: string; probeLog: string } =>
    acquisitionBin(
      home,
      `let buffer = '';
       process.stdin.setEncoding('utf8');
       process.stdin.on('data', (chunk) => {
         buffer += chunk;
         let idx = buffer.indexOf('\\n');
         while (idx !== -1) {
           const line = buffer.slice(0, idx);
           buffer = buffer.slice(idx + 1);
           idx = buffer.indexOf('\\n');
           if (line.trim() === '') continue;
           const reply = { jsonrpc: '2.0', id: JSON.parse(line).id, error: { code: -32603, message: 'fixture adapter declines to initialize' } };
           process.stdout.write(JSON.stringify(reply) + '\\n');
         }
       });`,
    );

  const resumableAcquisitionBin = (home: string): { bin: string; probeLog: string } =>
    acquisitionBin(home, RESUMABLE_AGENT_SOURCE);

  const pinnedAdapterManager = (
    home: string,
    bin: string,
    env?: Record<string, string>,
  ): { agentId: string; manager: AcpThreadManager } => {
    const localDir = tmp();
    const agent = registryPackage(PINNED_DESCRIPTOR, 'npx', { PATH: bin, ...env });
    const registry = new AcpRegistry({
      localDir,
      log,
      fetchImpl: async () => new Response(JSON.stringify({ agents: [agent] })),
    });
    return { agentId: agent.id, manager: makeManager(home, localDir, { registry }) };
  };

  test('two thread opens of one pinned registry adapter acquire it once', async () => {
    await withAcquisitionHome(async (home) => {
      const { bin, probeLog } = recordingAcquisitionBin(home);
      const { agentId, manager } = pinnedAdapterManager(home, bin);

      const first = await manager.createThread({ agent: { source: 'registry', id: agentId } });
      await waitUntil(
        () => manager.getInfo(first.threadId)?.status === 'error',
        20_000,
        'the first open to settle',
      );
      const second = await manager.createThread({ agent: { source: 'registry', id: agentId } });
      await waitUntil(
        () => manager.getInfo(second.threadId)?.status === 'error',
        20_000,
        'the second open to settle',
      );

      expect(probedDescriptors(probeLog)).toEqual([PINNED_DESCRIPTOR]);
    });
  }, 60_000);

  test('a retry re-acquires the pinned adapter instead of reusing the open probe', async () => {
    await withAcquisitionHome(async (home) => {
      const { bin, probeLog } = recordingAcquisitionBin(home);
      const { agentId, manager } = pinnedAdapterManager(home, bin);

      const info = await manager.createThread({ agent: { source: 'registry', id: agentId } });
      await waitUntil(
        () => manager.getInfo(info.threadId)?.status === 'error',
        20_000,
        'the open to settle',
      );
      expect(probedDescriptors(probeLog)).toEqual([PINNED_DESCRIPTOR]);

      await manager.retryThread(info.threadId).catch(() => {});

      expect(probedDescriptors(probeLog)).toEqual([PINNED_DESCRIPTOR, PINNED_DESCRIPTOR]);
    });
  }, 60_000);

  test('a resume reuses the acquisition its open made instead of probing again', async () => {
    await withAcquisitionHome(async (home) => {
      const { bin, probeLog } = resumableAcquisitionBin(home);
      const { agentId, manager } = pinnedAdapterManager(home, bin, {
        FAKE_CAPS: 'resume,load',
      });
      await manager.init();

      const info = await manager.createThread({ agent: { source: 'registry', id: agentId } });
      await waitUntil(
        () => manager.getInfo(info.threadId)?.status === 'ready',
        20_000,
        'the open to become ready',
      );
      manager.sendPrompt(info.threadId, 'retain this session');
      await waitUntil(
        () => manager.getInfo(info.threadId)?.status === 'ready',
        20_000,
        'the turn to end',
      );
      await manager.closeThread(info.threadId);
      const beforeResume = (await statusesOf(manager, info.threadId)).length;

      await manager.resumeThread(info.threadId);
      await waitUntil(
        () => manager.getInfo(info.threadId)?.status === 'ready',
        20_000,
        'the resumed thread to become ready',
      );

      expect(probedDescriptors(probeLog)).toEqual([PINNED_DESCRIPTOR]);
      const afterResume = (await statusesOf(manager, info.threadId)).slice(beforeResume);
      expect(afterResume[0]).toBe('spawning');
      expect(afterResume).not.toContain('installing');
    });
  }, 90_000);

  test('a resume whose runtime offer goes unanswered expires on the budget the resume waits on', async () => {
    await withAcquisitionHome(async (home) => {
      const { bin } = resumableAcquisitionBin(home);
      const localDir = tmp();
      const runtimeRoot = tmp();
      const agent = registryPackage(PINNED_DESCRIPTOR, 'npx', {
        PATH: bin,
        FAKE_CAPS: 'resume,load',
      });
      const registry = new AcpRegistry({
        localDir,
        log,
        fetchImpl: async () => new Response(JSON.stringify({ agents: [agent] })),
      });
      const manager = makeManager(home, localDir, {
        registry,
        runtimeInstall: { root: runtimeRoot },
      });
      await manager.init();

      const events: ThreadEvent[] = [];
      const info = await manager.createThread({ agent: { source: 'registry', id: agent.id } });
      await manager.subscribe(info.threadId, 0, (frame) => {
        if (frame.op === 'event') events.push(frame.event);
        else if (frame.op === 'events') events.push(...frame.events);
      });
      await waitUntil(
        () => manager.getInfo(info.threadId)?.status === 'ready',
        20_000,
        'the open to become ready',
      );
      manager.sendPrompt(info.threadId, 'retain this session');
      await waitUntil(
        () => manager.getInfo(info.threadId)?.status === 'ready',
        20_000,
        'the turn to end',
      );
      expect(internals(manager).sessionId(info.threadId)).toBe('sess-fixed');
      await manager.closeThread(info.threadId);
      expect(manager.getInfo(info.threadId)?.archived).toBe(true);

      for (const leaf of ['npx', 'npx.cjs', 'npx.cmd']) {
        rmSync(join(bin, leaf), { force: true });
      }

      let refusal: unknown;
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const resuming = manager.resumeThread(info.threadId).catch((error: unknown) => error);
        await waitUntil(
          () => events.some((event) => event.kind === 'runtime_consent_request'),
          20_000,
          'the resume to offer the managed runtime',
        );
        await vi.advanceTimersByTimeAsync(BLOCKING_CONSENT_BUDGET_MS + 1_000);
        await waitUntil(
          () => events.some((event) => event.kind === 'runtime_consent_resolved'),
          20_000,
          'the offer to expire on the budget the resume is waiting on',
        );
        refusal = await resuming;
      } finally {
        vi.useRealTimers();
      }

      const resolved = events.find(
        (event): event is Extract<ThreadEvent, { kind: 'runtime_consent_resolved' }> =>
          event.kind === 'runtime_consent_resolved',
      );
      expect(resolved?.decision).toBe('timeout');
      expect(refusal).toMatchObject({
        message: expect.stringContaining('expired before it was answered'),
      });

      await waitUntil(
        () => events.some((event) => event.kind === 'status' && event.status === 'exited'),
        20_000,
        'the resume to record its terminal status',
      );
      const terminal = events
        .filter(
          (event): event is Extract<ThreadEvent, { kind: 'status' }> => event.kind === 'status',
        )
        .at(-1);
      expect(terminal?.status).toBe('exited');
      expect(terminal?.failure?.agentMessage).toContain('expired before it was answered');
      expect(
        terminal?.failure?.agentMessage,
        're-offering the download would tell the user an offer they let expire was never made',
      ).not.toContain('OK can download a private copy');
    });
  }, 120_000);

  test('an open that really probes the registry reports installing while it probes', async () => {
    await withAcquisitionHome(async (home) => {
      const { bin, probeLog } = recordingAcquisitionBin(home);
      const { agentId, manager } = pinnedAdapterManager(home, bin);

      const info = await manager.createThread({ agent: { source: 'registry', id: agentId } });
      await waitUntil(
        () => manager.getInfo(info.threadId)?.status === 'error',
        20_000,
        'the open to settle',
      );

      expect(probedDescriptors(probeLog)).toEqual([PINNED_DESCRIPTOR]);
      expect(await statusesOf(manager, info.threadId)).toEqual([
        'spawning',
        'installing',
        'spawning',
        'error',
      ]);
    });
  }, 60_000);

  test('a second open served from the warm memo never reports installing', async () => {
    await withAcquisitionHome(async (home) => {
      const { bin, probeLog } = recordingAcquisitionBin(home);
      const { agentId, manager } = pinnedAdapterManager(home, bin);

      const first = await manager.createThread({ agent: { source: 'registry', id: agentId } });
      await waitUntil(
        () => manager.getInfo(first.threadId)?.status === 'error',
        20_000,
        'the first open to settle',
      );
      const second = await manager.createThread({ agent: { source: 'registry', id: agentId } });
      await waitUntil(
        () => manager.getInfo(second.threadId)?.status === 'error',
        20_000,
        'the second open to settle',
      );

      expect(probedDescriptors(probeLog)).toEqual([PINNED_DESCRIPTOR]);
      const statuses = await statusesOf(manager, second.threadId);
      expect(statuses[0]).toBe('spawning');
      expect(statuses).not.toContain('installing');
    });
  }, 60_000);

  test('an unpinned registry package resolves without reporting installing', async () => {
    await withAcquisitionHome(async (home) => {
      const { bin, probeLog } = recordingAcquisitionBin(home);
      const localDir = tmp();
      const agent = registryPackage(PINNED_ADAPTER, 'npx', { PATH: bin });
      const registry = new AcpRegistry({
        localDir,
        log,
        fetchImpl: async () => new Response(JSON.stringify({ agents: [agent] })),
      });
      const manager = makeManager(home, localDir, { registry });

      const info = await manager.createThread({ agent: { source: 'registry', id: agent.id } });
      await waitUntil(
        () => manager.getInfo(info.threadId)?.status === 'error',
        20_000,
        'the open to settle',
      );

      expect(probedDescriptors(probeLog)).toEqual([]);
      const statuses = await statusesOf(manager, info.threadId);
      expect(statuses[0]).toBe('spawning');
      expect(statuses).not.toContain('installing');
    });
  }, 60_000);

  test('a custom agent launched through the same npx never reports installing', async () => {
    await withAcquisitionHome(async (home) => {
      const { bin, probeLog } = recordingAcquisitionBin(home);
      const localDir = tmp();
      writeFileSync(
        join(localDir, 'acp-agents.json'),
        JSON.stringify([
          {
            id: 'custom-npx',
            name: 'Custom npx agent',
            command: join(bin, 'npx'),
            args: ['-y', PINNED_DESCRIPTOR],
          },
        ]),
      );
      const manager = makeManager(home, localDir);

      const info = await manager.createThread({ agent: { source: 'custom', id: 'custom-npx' } });
      await waitUntil(
        () => manager.getInfo(info.threadId)?.status === 'error',
        20_000,
        'the open to settle',
      );

      expect(probedDescriptors(probeLog)).toEqual([]);
      const statuses = await statusesOf(manager, info.threadId);
      expect(statuses[0]).toBe('spawning');
      expect(statuses).not.toContain('installing');
    });
  }, 60_000);

  test('a retry re-acquires its own adapter and leaves a second adapter memoized', async () => {
    const BYSTANDER_DESCRIPTOR = 'probe-scope-bystander-fixture@3.0.0';
    await withAcquisitionHome(async (home) => {
      const { bin, probeLog } = recordingAcquisitionBin(home);
      const localDir = tmp();
      const retried = {
        ...registryPackage(PINNED_DESCRIPTOR, 'npx', { PATH: bin }),
        id: 'adapter-retried',
      };
      const bystander = {
        ...registryPackage(BYSTANDER_DESCRIPTOR, 'npx', { PATH: bin }),
        id: 'adapter-bystander',
      };
      const registry = new AcpRegistry({
        localDir,
        log,
        fetchImpl: async () => new Response(JSON.stringify({ agents: [retried, bystander] })),
      });
      const manager = makeManager(home, localDir, { registry });
      const settle = async (agentId: string): Promise<string> => {
        const info = await manager.createThread({ agent: { source: 'registry', id: agentId } });
        await waitUntil(
          () => manager.getInfo(info.threadId)?.status === 'error',
          20_000,
          `the ${agentId} open to settle`,
        );
        return info.threadId;
      };

      const retriedThread = await settle(retried.id);
      await settle(bystander.id);
      expect(probedDescriptors(probeLog)).toEqual([PINNED_DESCRIPTOR, BYSTANDER_DESCRIPTOR]);

      await manager.retryThread(retriedThread).catch(() => {});
      expect(probedDescriptors(probeLog)).toEqual([
        PINNED_DESCRIPTOR,
        BYSTANDER_DESCRIPTOR,
        PINNED_DESCRIPTOR,
      ]);

      await settle(bystander.id);

      expect(probedDescriptors(probeLog)).toEqual([
        PINNED_DESCRIPTOR,
        BYSTANDER_DESCRIPTOR,
        PINNED_DESCRIPTOR,
      ]);
    });
  }, 90_000);
});

const NPX_ENTRY_HASH = '4142609e2aa780f6';
const NPX_RELAUNCH_LOG = '[acp-threads] cleared a stale npx cache entry; relaunching the agent';
const NPX_JOIN_LOG =
  '[acp-threads] npx cache entry was cleared by another launch moments ago; relaunching without clearing it again';

type NpxEnoentMode = 'while-entry-exists' | 'always' | 'stderr-after-stdout-eof';

function npmEnoentSource(entryDir: string, mode: NpxEnoentMode): string {
  const fail =
    mode === 'stderr-after-stdout-eof'
      ? `process.stdout.end(() => setTimeout(() => process.stderr.write(lines.join('\\n'), () => process.exit(254)), 150));`
      : `process.stderr.write(lines.join('\\n'), () => process.exit(254));`;
  return `
const entry = ${JSON.stringify(entryDir)};
if (${mode === 'always' ? 'true' : 'existsSync(entry)'}) {
  const lines = [
    'npm error code ENOENT',
    'npm error syscall open',
    'npm error path ' + entry + '/package.json',
    'npm error errno -2',
    "npm error enoent Could not read package.json: Error: ENOENT: no such file or directory, open '" + entry + "/package.json'",
    'npm error enoent This is related to npm not being able to find a file.',
    '',
  ];
  ${fail}
} else {
  import(${JSON.stringify(pathToFileURL(EXAMPLE_AGENT).href)});
}
`;
}

function writeNpxCacheFailingAgentEntry(
  localDir: string,
  id: string,
  entryDir: string,
  mode: NpxEnoentMode,
): void {
  const agentPath = join(localDir, `${id}.mjs`);
  writeFileSync(
    agentPath,
    `import { existsSync } from 'node:fs';\n${npmEnoentSource(entryDir, mode)}`,
  );
  writeFileSync(
    join(localDir, 'acp-agents.json'),
    JSON.stringify([{ id, name: 'npx cache fixture', command: 'node', args: [agentPath] }]),
  );
}

function logCount(warn: ReturnType<typeof vi.spyOn>, message: string): number {
  return warn.mock.calls.filter((call) => call[1] === message).length;
}

function hasLaunchFailureEntry(logPath: string, threadId: string): boolean {
  if (!existsSync(logPath)) return false;
  const text = readFileSync(logPath, 'utf8');
  return text.includes(`thread=${threadId}`) && text.endsWith('\n\n');
}

async function withNpxLaunchFixture(
  mode: NpxEnoentMode,
  run: (fixture: {
    manager: AcpThreadManager;
    agentId: string;
    entryDir: string;
    localDir: string;
    warn: ReturnType<typeof vi.spyOn>;
  }) => Promise<void>,
): Promise<void> {
  await withAcquisitionHome(async (home) => {
    const localDir = tmp();
    const bin = join(home, 'bin');
    mkdirSync(bin);
    installNodeFixture(bin);
    writeRecordingNpm(bin, join(home, 'npm-probes.log'));
    const entryDir = join(home, 'npm-cache', '_npx', NPX_ENTRY_HASH);
    writeExecutable(
      join(bin, 'npx'),
      `const { existsSync } = require('node:fs');
if (process.argv.includes('--version')) {
  process.stdout.write('11.17.0\\n');
  process.exit(0);
}
${npmEnoentSource(entryDir, mode)}`,
    );
    const env = { PATH: [bin, process.env.PATH ?? ''].join(delimiter) };
    const agent = registryPackage('fixture-bootstrap', 'npx', env);
    agent.distribution.npx = { package: 'fixture-bootstrap', env };
    const registry = new AcpRegistry({
      localDir,
      log,
      ttlMs: 0,
      fetchImpl: async () => new Response(JSON.stringify({ agents: [agent] })),
    });
    const warn = vi.spyOn(log, 'warn');
    const manager = makeManager(home, localDir, { registry });
    await manager.init();
    try {
      await run({ manager, agentId: agent.id, entryDir, localDir, warn });
    } finally {
      await manager.destroy();
    }
  });
}

describe('launch failure diagnostics and npx cache recovery', () => {
  test('a stale npx cache entry is cleared and the launch retried once', async () => {
    await withNpxLaunchFixture(
      'while-entry-exists',
      async ({ manager, agentId, entryDir, localDir, warn }) => {
        mkdirSync(entryDir, { recursive: true });
        const info = await manager.createThread({ agent: { source: 'registry', id: agentId } });
        await waitUntil(
          () => manager.getInfo(info.threadId)?.status === 'ready',
          20_000,
          'agent ready after relaunch',
        );
        expect(existsSync(entryDir)).toBe(false);
        expect(logCount(warn, NPX_RELAUNCH_LOG)).toBe(1);
        const statuses = await statusesOf(manager, info.threadId);
        expect(statuses).not.toContain('error');
        expect(statuses).not.toContain('exited');
        expect(existsSync(join(localDir, ACP_LAUNCH_FAILURE_LOG))).toBe(false);
      },
    );
  }, 40_000);

  test('the relaunch stays silent when the npm error lands after stdout closes', async () => {
    await withNpxLaunchFixture(
      'stderr-after-stdout-eof',
      async ({ manager, agentId, entryDir, warn }) => {
        mkdirSync(entryDir, { recursive: true });
        const info = await manager.createThread({ agent: { source: 'registry', id: agentId } });
        await waitUntil(
          () => manager.getInfo(info.threadId)?.status === 'ready',
          20_000,
          'agent ready after relaunch',
        );
        expect(existsSync(entryDir)).toBe(false);
        expect(logCount(warn, NPX_RELAUNCH_LOG)).toBe(1);
        const statuses = await statusesOf(manager, info.threadId);
        expect(statuses).not.toContain('exited');
        expect(statuses).not.toContain('error');
      },
    );
  }, 40_000);

  test('a launch that keeps failing on the npx cache is reported after one retry', async () => {
    await withNpxLaunchFixture('always', async ({ manager, agentId, entryDir, localDir, warn }) => {
      mkdirSync(entryDir, { recursive: true });
      const info = await manager.createThread({ agent: { source: 'registry', id: agentId } });
      await waitUntil(
        () => manager.getInfo(info.threadId)?.status === 'error',
        20_000,
        'launch failure',
      );
      expect(existsSync(entryDir)).toBe(false);
      expect(logCount(warn, NPX_RELAUNCH_LOG)).toBe(1);
      const statuses = await statusesOf(manager, info.threadId);
      expect(statuses.filter((status) => status === 'error')).toHaveLength(1);
      const logPath = join(localDir, ACP_LAUNCH_FAILURE_LOG);
      await waitUntil(
        () => hasLaunchFailureEntry(logPath, info.threadId),
        5_000,
        'launch failure log entry',
      );
      const logText = readFileSync(logPath, 'utf8');
      expect(logText.match(/=== acp launch failure /g)).toHaveLength(1);
      expect(logText).toContain(
        `thread=${info.threadId} agent=${agentId} source=registry reason=connect ===\ninitialize failed:`,
      );
      expect(logText).toContain('--- stderr tail ---');
      expect(logText).toContain('npm error code ENOENT');
    });
  }, 40_000);

  test.each(['package.json', 'concurrency.lock'])(
    'an npx cache entry that still holds %s is left alone',
    async (file) => {
      await withNpxLaunchFixture(
        'while-entry-exists',
        async ({ manager, agentId, entryDir, warn }) => {
          mkdirSync(entryDir, { recursive: true });
          writeFileSync(join(entryDir, file), '');
          const info = await manager.createThread({ agent: { source: 'registry', id: agentId } });
          await waitUntil(
            () => manager.getInfo(info.threadId)?.status === 'error',
            20_000,
            'launch failure',
          );
          expect(existsSync(join(entryDir, file))).toBe(true);
          expect(logCount(warn, NPX_RELAUNCH_LOG)).toBe(0);
        },
      );
    },
    40_000,
  );

  test('an entry left alone is probed again by the next launch, not treated as cleared', async () => {
    await withNpxLaunchFixture(
      'while-entry-exists',
      async ({ manager, agentId, entryDir, warn }) => {
        mkdirSync(entryDir, { recursive: true });
        writeFileSync(join(entryDir, 'concurrency.lock'), '');
        const held = await manager.createThread({ agent: { source: 'registry', id: agentId } });
        await waitUntil(
          () => manager.getInfo(held.threadId)?.status === 'error',
          20_000,
          'launch failure while the lock is held',
        );
        expect(existsSync(join(entryDir, 'concurrency.lock'))).toBe(true);
        rmSync(join(entryDir, 'concurrency.lock'));
        const retried = await manager.createThread({ agent: { source: 'registry', id: agentId } });
        await waitUntil(
          () => manager.getInfo(retried.threadId)?.status === 'ready',
          20_000,
          'second launch ready',
        );
        expect(existsSync(entryDir)).toBe(false);
        expect(logCount(warn, NPX_RELAUNCH_LOG)).toBe(1);
        expect(logCount(warn, NPX_JOIN_LOG)).toBe(0);
      },
    );
  }, 60_000);

  test('a second launch does not delete an entry another launch just cleared', async () => {
    await withNpxLaunchFixture(
      'while-entry-exists',
      async ({ manager, agentId, entryDir, warn }) => {
        mkdirSync(entryDir, { recursive: true });
        const first = await manager.createThread({ agent: { source: 'registry', id: agentId } });
        await waitUntil(
          () => manager.getInfo(first.threadId)?.status === 'ready',
          20_000,
          'first launch ready',
        );
        expect(existsSync(entryDir)).toBe(false);
        mkdirSync(entryDir, { recursive: true });
        const second = await manager.createThread({ agent: { source: 'registry', id: agentId } });
        await waitUntil(
          () => manager.getInfo(second.threadId)?.status === 'error',
          20_000,
          'second launch failure',
        );
        expect(existsSync(entryDir)).toBe(true);
        expect(logCount(warn, NPX_RELAUNCH_LOG)).toBe(1);
        expect(logCount(warn, NPX_JOIN_LOG)).toBe(1);
      },
    );
  }, 60_000);

  test('a custom agent that prints the npx cache signature is not retried', async () => {
    const localDir = tmp();
    const entryDir = join(tmp(), '_npx', NPX_ENTRY_HASH);
    mkdirSync(entryDir, { recursive: true });
    writeNpxCacheFailingAgentEntry(localDir, 'npx-cache', entryDir, 'while-entry-exists');
    const warn = vi.spyOn(log, 'warn');
    const manager = makeManager(tmp(), localDir);
    const info = await manager.createThread({ agent: { source: 'custom', id: 'npx-cache' } });
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'error',
      20_000,
      'launch failure',
    );
    expect(existsSync(entryDir)).toBe(true);
    expect(logCount(warn, NPX_RELAUNCH_LOG)).toBe(0);
    const logPath = join(localDir, ACP_LAUNCH_FAILURE_LOG);
    await waitUntil(
      () => hasLaunchFailureEntry(logPath, info.threadId),
      5_000,
      'launch failure log entry',
    );
    const logText = readFileSync(logPath, 'utf8');
    expect(logText).toContain(
      `thread=${info.threadId} agent=npx-cache source=custom reason=connect ===`,
    );
    expect(logText).toContain('npm error code ENOENT');
  }, 30_000);

  test('a session setup failure is recorded with its reason', async () => {
    const localDir = tmp();
    writeSessionFailingAgentEntry(
      localDir,
      'broken-agent',
      { code: -32603, message: 'Failed to initialize session services' },
      'boot: loading services',
    );
    const manager = makeManager(tmp(), localDir);
    const info = await manager.createThread({ agent: { source: 'custom', id: 'broken-agent' } });
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'error',
      15_000,
      'session setup failure',
    );
    const logPath = join(localDir, ACP_LAUNCH_FAILURE_LOG);
    await waitUntil(
      () => hasLaunchFailureEntry(logPath, info.threadId),
      5_000,
      'launch failure log entry',
    );
    const logText = readFileSync(logPath, 'utf8');
    expect(logText).toContain(
      `thread=${info.threadId} agent=broken-agent source=custom reason=session-setup ===\nsession setup failed: Failed to initialize session services`,
    );
    expect(logText).toContain('boot: loading services');
  }, 30_000);

  test('a prompt failure is not a launch failure and stays out of the log', async () => {
    const localDir = tmp();
    writeRequestingAgentEntry(
      localDir,
      'prompt-failure',
      "write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'prompt failed' } });",
    );
    const manager = makeManager(tmp(), localDir);
    const info = await manager.createThread({ agent: { source: 'custom', id: 'prompt-failure' } });
    const statuses: StatusEvent[] = [];
    await manager.subscribe(info.threadId, 0, collectStatuses(statuses));
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');
    manager.sendPrompt(info.threadId, 'edit');
    await waitUntil(
      () => statuses.some((event) => event.failure?.reason === 'prompt'),
      5_000,
      'prompt failure',
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(join(localDir, ACP_LAUNCH_FAILURE_LOG))).toBe(false);
  }, 30_000);
});

function writeTerminalAuthAgentEntry(
  localDir: string,
  id: string,
  env: Record<string, string>,
  capsFile: string,
): string {
  const agentPath = join(localDir, `${id}.mjs`);
  writeFileSync(
    agentPath,
    `
import { writeFileSync } from 'node:fs';
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf('\\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    idx = buffer.indexOf('\\n');
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      writeFileSync(${JSON.stringify(capsFile)}, JSON.stringify(msg.params.clientCapabilities ?? {}));
      write({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {},
          authMethods: [
            { type: 'terminal', id: 'cli-login', name: 'CLI login', args: ['login'], env: { FROM_METHOD: '1' } },
          ],
        },
      });
    } else if (msg.method === 'session/new') {
      write({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'sign in required' } });
    } else if (msg.id !== undefined) {
      write({ jsonrpc: '2.0', id: msg.id, result: {} });
    }
  }
});
`,
  );
  writeFileSync(
    join(localDir, 'acp-agents.json'),
    JSON.stringify([{ id, name: `Fake ${id}`, command: 'node', args: [agentPath], env }]),
  );
  return agentPath;
}

describe('terminal sign-in methods', () => {
  test('the persisted method only flags the launch, and the live launch carries the env', async () => {
    const localDir = tmp();
    const capsFile = join(localDir, 'caps.json');
    const agentPath = writeTerminalAuthAgentEntry(
      localDir,
      'term-auth',
      { FIXTURE_HOME: '/tmp/fixture-home' },
      capsFile,
    );
    const manager = makeManager(tmp(), localDir, { terminalAuthAvailable: true });
    const info = await manager.createThread({ agent: { source: 'custom', id: 'term-auth' } });
    const statuses: StatusEvent[] = [];
    await manager.subscribe(info.threadId, 0, collectStatuses(statuses));
    await waitUntil(
      () => statuses.some((event) => event.status === 'auth_required'),
      15_000,
      'sign in',
    );
    const failure = [...statuses]
      .reverse()
      .find((event) => event.status === 'auth_required')?.failure;
    expect(failure?.authMethods).toEqual([
      {
        id: 'cli-login',
        name: 'CLI login',
        kind: 'terminal',
        terminalLaunchAvailable: true,
      },
    ]);
    expect(JSON.stringify(failure)).not.toContain('fixture-home');
    expect(manager.terminalAuthLaunch(info.threadId, 'cli-login')).toEqual({
      executable: 'node',
      args: [agentPath, 'login'],
      env: { FIXTURE_HOME: '/tmp/fixture-home', FROM_METHOD: '1' },
      pathPrepend: [],
    });
    expect(() => manager.terminalAuthLaunch(info.threadId, 'missing')).toThrow(
      'no terminal sign-in',
    );
    expect(JSON.parse(readFileSync(capsFile, 'utf8'))).toMatchObject({ auth: { terminal: true } });
  }, 20_000);

  test('a host without a terminal does not advertise terminal sign-in', async () => {
    const localDir = tmp();
    const capsFile = join(localDir, 'caps.json');
    writeTerminalAuthAgentEntry(localDir, 'term-auth', {}, capsFile);
    const manager = makeManager(tmp(), localDir);
    const info = await manager.createThread({ agent: { source: 'custom', id: 'term-auth' } });
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'auth_required',
      15_000,
      'sign in',
    );
    expect(JSON.parse(readFileSync(capsFile, 'utf8'))).not.toHaveProperty('auth');
  }, 20_000);
});
