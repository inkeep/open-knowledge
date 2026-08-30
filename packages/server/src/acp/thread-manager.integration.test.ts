/**
 * End-to-end ACP loop against a real spawned agent subprocess — the SDK's
 * bundled example agent (`dist/examples/agent.js`), registered as a custom
 * agent. Covers: custom-agent launch, initialize + session/new handshake,
 * streamed session updates, an edit-kind permission request resolved through
 * the manager's respondPermission path, and clean thread close (process
 * killed).
 *
 * No fs stubs needed: the example agent never calls `fs/*`; the fake
 * session manager below exists only to satisfy the constructor and the
 * close path.
 */

import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ThreadEvent,
  ThreadInfo,
  ThreadServerFrame,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import codexFixture from '../../../../test-support/fixtures/codex-legacy-warning-envelopes.json' with {
  type: 'json',
};
import type { AgentPresenceBroadcaster } from '../agent-presence.ts';
import type { AgentSessionManager } from '../agent-sessions.ts';
import { getLogger, type PinoLogger } from '../logger.ts';
import { RUNTIME_VERSION } from '../version-constants.ts';
import { AcpPermissionStore } from './permissions.ts';
import { AcpRegistry } from './registry.ts';
import { ACP_ENVIRONMENT_NOTE, AcpThreadManager, MAX_QUEUED_PROMPTS } from './thread-manager.ts';

const log = getLogger('acp-thread-test');

// Resolve through the module graph — survives hoisting differences between
// per-package and workspace-root node_modules.
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
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function makeManager(
  contentDir: string,
  localDir: string,
  extra?: {
    steerStallMs?: number;
    authenticateTimeoutMs?: number;
    unwatchedTurnCancelMs?: number;
    unwatchedTurnKillMs?: number;
    isIgnoredPath?: (relPosix: string) => boolean;
    registry?: AcpRegistry;
    resolveLoginShellPath?: () => Promise<string | null>;
    agentPresenceBroadcaster?: AgentPresenceBroadcaster;
    sessionManager?: AgentSessionManager;
    log?: PinoLogger;
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
    // Hermetic by default: every launch now merges the login shell's PATH, and
    // a test must not spawn the developer's own shell to find out what it is.
    resolveLoginShellPath: async () => null,
    ...extra,
  });
  managers.push(manager);
  return manager;
}

/** Test seams into manager internals (private fields; same-package test). */
function internals(manager: AcpThreadManager): {
  sweep: () => void;
  pendingPermissionCount: (threadId: string) => number;
  turnActive: (threadId: string) => boolean;
  child: (threadId: string) => ChildProcess | null | undefined;
} {
  const m = manager as unknown as {
    reapIdleThreads: () => void;
    threads: Map<
      string,
      {
        pendingPermissions: Map<unknown, unknown>;
        turnActive: boolean;
        child: ChildProcess | null;
      }
    >;
  };
  return {
    sweep: () => m.reapIdleThreads(),
    pendingPermissionCount: (threadId) => m.threads.get(threadId)?.pendingPermissions.size ?? 0,
    turnActive: (threadId) => m.threads.get(threadId)?.turnActive ?? false,
    child: (threadId) => m.threads.get(threadId)?.child,
  };
}

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
    // Custom launches resolve synchronously now (no second disk read), so the
    // create snapshot may already have progressed past 'installing'.
    expect(['installing', 'spawning']).toContain(info.status);
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

    // Handshake completes → ready.
    await waitFor(
      () => events.some((e) => e.event.kind === 'status' && e.event.status === 'ready'),
      15_000,
    );

    manager.sendPrompt(info.threadId, 'Improve my project please');

    // The example agent streams chunks then asks permission for an
    // edit-kind tool call — policy must ASK (not auto-allow).
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

    // Streamed chunks arrived and seqs are strictly increasing.
    expect(events.some((e) => e.event.kind === 'session_update')).toBe(true);
    const seqs = events.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

    // A late subscriber replays the same history from seq 0.
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

    // Close archives (transcript kept) rather than destroying.
    await manager.closeThread(info.threadId);
    expect(manager.listThreads().filter((t) => t.archived !== true)).toHaveLength(0);
    expect(manager.listThreads()[0]?.archived).toBe(true);
  }, 45_000);

  test('closeThread kills a SIGTERM-ignoring agent tree before resolving', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    // Simulates the npx shape: a TERM-ignoring wrapper whose TERM-ignoring
    // child is the "real" agent. Speaks no ACP — the kill path must not
    // depend on a completed handshake.
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

    // closeThread resolving IS the death guarantee — no grace-period sleep.
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
    // Never subscribed → unwatched since creation; cancel threshold is
    // effectively immediate, kill threshold far away.
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
    // Deterministic mid-turn point: the agent is blocked awaiting our
    // permission response — exactly the shape a headless runaway takes.
    await waitUntil(
      () => pendingPermissionCount(info.threadId) > 0,
      20_000,
      'pending permission request',
    );

    sweep();

    // Cancel resolves the pending permission as 'cancelled'; the example
    // agent then ends the turn with stopReason 'cancelled'.
    await waitUntil(() => !turnActive(info.threadId), 10_000, 'turn cancelled');
    expect(manager.getInfo(info.threadId)?.status).toBe('ready');
    // Cancel stage never closes the thread — reattach still works.
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
    // makeManager's registry fetch is offline with no cache — that's a
    // registry FAILURE, which must surface as such, not as "unknown agent".
    await expect(
      manager.createThread({ agent: { source: 'registry', id: 'ghost' } }),
    ).rejects.toThrow('agent registry unavailable');

    // A working registry that simply lacks the id IS "unknown agent".
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
    // Minimal stdio ACP agent that advertises a model selector and applies
    // `session/set_config_option` — the surface the SDK example agent lacks.
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
    // Agent advertised no prompt capabilities: the handshake still resolves
    // the field to {} ("baseline content only"), never leaves it absent.
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
    // The fake persists the initialize params it received — the only way to
    // observe the client half of the handshake from outside the process.
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
    // Minimal stdio ACP agent that advertises slash commands right after
    // session/new, echoes each prompt's WIRE text back as a message chunk (so
    // the test can see exactly what the agent received), and re-advertises a
    // grown command list after the first turn (the wholesale-replace contract).
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
    // Not yet advertised is null — a different answer than "advertised none".
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

    // A first message that IS a command invocation must reach the agent with
    // `/` as its first byte — ACP command dispatch is prefix-based, so the
    // environment note defers rather than break the command.
    manager.sendPrompt(info.threadId, '/review the diff');
    await waitFor(() => receivedTexts().length === 1, 15_000);
    expect(receivedTexts()[0]).toBe('received:/review the diff');

    // The mid-turn re-advertisement replaced the list wholesale.
    await waitFor(
      () => (manager.getInfo(info.threadId)?.availableCommands ?? []).length === 2,
      10_000,
    );

    await waitFor(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000);
    // The note survives ANY number of consecutive command-first prompts —
    // deferral is per-prompt, not one-shot.
    manager.sendPrompt(info.threadId, '/plan the rollout');
    await waitFor(() => receivedTexts().length === 2, 15_000);
    expect(receivedTexts()[1]).toBe('received:/plan the rollout');

    await waitFor(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000);
    // The deferred note rides the first NON-command prompt: wire text = note +
    // user text; the transcript echo stays the user's.
    manager.sendPrompt(info.threadId, 'first hello');
    await waitFor(() => receivedTexts().length === 3, 15_000);
    expect(receivedTexts()[2]).toBe(`received:${ACP_ENVIRONMENT_NOTE}\n\nfirst hello`);
    const userMessages = events
      .map((e) => e.event)
      .filter((e) => e.kind === 'user_message')
      .map((e) => e.content);
    expect(userMessages).toEqual(['/review the diff', '/plan the rollout', 'first hello']);

    await waitFor(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000);
    manager.sendPrompt(info.threadId, 'second hello');
    await waitFor(() => receivedTexts().length === 4, 15_000);
    // Consumed: the note never rides a later prompt of the same session.
    expect(receivedTexts()[3]).toBe('received:second hello');

    await manager.closeThread(info.threadId);
  }, 30_000);
});

/**
 * Minimal stdio ACP agent for the persistence/resume matrix. Capabilities
 * come from FAKE_CAPS ("resume,load" | "load" | ""); FAIL_LOAD=1 rejects
 * `session/load` with -32002 (the expired-session shape). `session/load`
 * replays two history chunks BEFORE its response, per protocol — the shape
 * the manager's replay suppression must swallow.
 */
function writeResumableAgentEntry(localDir: string, id: string, env: Record<string, string>): void {
  const agentPath = join(localDir, `${id}.mjs`);
  writeFileSync(
    agentPath,
    `
import { appendFileSync } from 'node:fs';
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
`,
  );
  writeFileSync(
    join(localDir, 'acp-agents.json'),
    JSON.stringify([{ id, name: `Fake ${id}`, command: 'node', args: [agentPath], env }]),
  );
}

/**
 * Minimal stdio ACP agent that, on each prompt, streams a burst of single-char
 * chunks: a message run, an interleaved thought run, then a second message run.
 * The tight synchronous burst is what the manager's fold-on-flush collapses;
 * the thought between the two message runs is a fold boundary (different
 * sessionUpdate kind) that must survive.
 */
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
  /** The wire echo of the FIRST prompt of a new session: dispatch prepends the
   *  environment note (wire-only; the `user_message` event keeps the user's
   *  text). Later prompts — including everything sent over a resumed session —
   *  echo bare. */
  const notedEcho = (text: string): string => `echo:${ACP_ENVIRONMENT_NOTE}\n\n${text}`;
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
    // The agent streams 16 message chars + 5 thought chars in one burst.
    const threadId = await runOneTurn(manager, 'streamer', 'go');

    const live: Collected = [];
    await manager.subscribe(threadId, 0, collector(live));

    // Folding assigns no new seq, so line-index-IS-the-seq still holds.
    expect(live.map((e) => e.seq)).toEqual(live.map((_, i) => i));

    const messageChunks = chunksOfKind(live, 'agent_message_chunk');
    const thoughtChunks = chunksOfKind(live, 'agent_thought_chunk');
    // Exact text survives the fold, and the interleaved thought never bleeds
    // into the message stream (or vice versa).
    expect(messageChunks.map(chunkText).join('')).toBe('ABCDEFGHIJKLMNOP');
    expect(thoughtChunks.map(chunkText).join('')).toBe('think');
    // 16 streamed message chars collapsed to a handful of events — and at least
    // two, since the thought run splits the message stream (a fold boundary).
    expect(messageChunks.length).toBeGreaterThanOrEqual(2);
    expect(messageChunks.length).toBeLessThan(16);
    expect(thoughtChunks.length).toBeLessThan(5);

    // The same folded, contiguous log rehydrates from disk on a fresh manager.
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
    // Title adopted from the first prompt survives into the archive.
    expect(archivedInfo?.title).toBe('hello there');

    // A second manager on the same localDir sees the thread and replays the
    // whole transcript from disk with the same seq contract.
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
    expect(agentChunks(replayed)).toContain(notedEcho('hello there'));
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
    // No prompt: the user spawned the agent then closed it untouched.
    await manager.closeThread(info.threadId);

    // Discarded, not archived — gone from the list…
    expect(manager.listThreads().find((t) => t.threadId === info.threadId)).toBeUndefined();
    // …and off disk, so a fresh manager doesn't rehydrate it as history.
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
    // First-prompt adoption drops the filler lead-in.
    expect(manager.getInfo(threadId)?.title).toBe('Update the roadmap');

    await manager.closeThread(threadId);
    await manager.renameThread(threadId, 'Q3 roadmap thread');
    expect(manager.getInfo(threadId)?.title).toBe('Q3 roadmap thread');

    // A fresh manager sees the manual title in the rehydrated meta, and the
    // rename's transcript event replays under the intact seq contract.
    const manager2 = makeManager(contentDir, localDir);
    await manager2.init();
    const rehydrated = manager2.listThreads().find((t) => t.threadId === threadId);
    expect(rehydrated?.title).toBe('Q3 roadmap thread');
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

    // titleHint (the user's raw ask) is carried on create and stored on the
    // record; the launch prompt itself opens with the fixed handoff preamble.
    const info = await manager.createThread({
      agent: { source: 'custom', id: 'example' },
      titleHint: 'Fix the login redirect',
    });
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'ready',
      15_000,
      'agent ready',
    );

    // The first prompt carries the preamble; without the hint the tab would
    // read "You're an agent working inside OpenKnowledge, w…". The stored hint
    // wins, so the title is the user's actual ask.
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

  /**
   * A resumed thread keeps answering on the model it was answering on. The
   * agent comes up on its own defaults (the fake resets `modelValue` because
   * resume spawns a new process), and the manager re-applies what the thread
   * had settled on.
   *
   * The pid tag is what makes the assertion honest: the manager's cached
   * options survive the archive, so `currentValue` alone would read 'opus'
   * whether or not anything reached the agent. A name carrying the NEW pid can
   * only have come from the resumed session's own response.
   */
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
    // Different pid ⇒ these options came back from the resumed agent, so the
    // set actually reached it rather than the manager replaying stale meta.
    expect(afterResume?.name).not.toBe(beforeArchive?.name);

    await manager.closeThread(threadId);
  }

  test('resume re-applies the thread settled config when the agent reports it', async () => {
    await resumeWithConfig(true);
  }, 45_000);

  test('resume re-applies the thread settled config when the agent reports none', async () => {
    // configOptions is optional in both resume responses. With none reported,
    // the cached values look already-correct, so the re-apply has to fire on
    // the unverified-cache path or the agent silently stays on its default.
    await resumeWithConfig(false);
  }, 45_000);

  /**
   * The mode half of the same contract. The manager records a successful mode
   * set locally instead of storing an agent-returned object, so — unlike the
   * config options — its own state cannot show whether the set reached the
   * agent. The fake's set_mode log is the evidence: it is truncated before the
   * resume, so anything in it afterwards came from the resumed process.
   */
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

    // No agent to call, so this records intent — nothing should reach the wire.
    manager.setMode(threadId, 'plan');
    expect(manager.getInfo(threadId)?.modes?.currentModeId).toBe('plan');
    expect(readFileSync(setModeLog, 'utf8')).toBe('');
    // A mode the settled surface does not offer is refused rather than stored.
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
    // The flag clears well before the session is back — two awaits precede it —
    // so from here the archived branch no longer covers picks and the
    // in-flight guard is the only thing standing between a pick and a session
    // the agent has not resumed yet.
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

    // No agent is running, so this records intent rather than calling one.
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
    // New pid ⇒ the pick reached the resumed agent, not just our own record.
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

    // Recording intent still validates against the settled options — otherwise
    // the resume would carry a value the agent will refuse.
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
    // The fixture advertises commands after session/new — captured pre-close.
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
    // Contiguous seqs across the disk (pre-archive) + memory (post-resume) stitch.
    expect(replayed.map((e) => e.seq)).toEqual(replayed.map((_, i) => i));
    const userMessages = replayed
      .map((e) => e.event)
      .filter((e): e is Extract<ThreadEvent, { kind: 'user_message' }> => e.kind === 'user_message')
      .map((e) => e.content);
    expect(userMessages).toEqual(['first message', 'second message']);
    expect(agentChunks(replayed)).toEqual([notedEcho('first message'), 'echo:second message']);
    // session/resume never re-runs session/new, and the fixture advertises
    // only there — so the pre-archive list must have been RESET to "not yet
    // known", not carried over as if this session had advertised it.
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
    // The fixture replayed 'old-user'/'old-agent' chunks during session/load —
    // they duplicate the retained log and must NOT appear as new events.
    expect(agentChunks(replayed)).toEqual([notedEcho('first message'), 'echo:second message']);
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

    // No session/resume, no session/load advertised.
    await expect(manager.resumeThread(threadId, 'again')).rejects.toMatchObject({
      code: 'resume-unsupported',
    });
    expect(manager.getInfo(threadId)?.archived).toBe(true);

    // Advertises load but rejects the stored sessionId (agent-side expiry).
    writeResumableAgentEntry(localDir, 'fake-none', { FAKE_CAPS: 'load', FAIL_LOAD: '1' });
    await expect(manager.resumeThread(threadId, 'again')).rejects.toMatchObject({
      code: 'resume-unsupported',
    });
    expect(manager.getInfo(threadId)?.archived).toBe(true);
    // The transcript survived both failed attempts.
    const replayed: Collected = [];
    await manager.subscribe(threadId, 0, collector(replayed));
    expect(agentChunks(replayed)).toContain(notedEcho('first message'));
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
    expect(agentChunks(replayed)).toContain(notedEcho('survives shutdown'));
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

    // A non-markdown write OUTSIDE the ignored namespaces still lands on disk.
    await m.handleFsWrite(record, join(contentDir, 'assets', 'note.txt'), 'hi');
    expect(readFileSync(join(contentDir, 'assets', 'note.txt'), 'utf8')).toBe('hi');
  });
});

/**
 * Shared scaffolding for scripted agents that issue their OWN client
 * requests (terminal/*, fs/*, session/request_permission) and await the
 * responses — the half of the wire the reply-only fakes above never
 * exercise. `promptBody` runs per `session/prompt` with `request`,
 * `notify`, and `finish` in scope.
 */
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

    // The client capability was advertised and the agent saw OK's terminal
    // execute the command: its own message carries the output + exit code.
    const text = agentText(events);
    expect(text).toContain('terminal-cap:true;');
    expect(text).toContain('boolean-config-cap:true;');
    expect(text).toContain('observed:terminal says hi;exit=0');

    // The transcript carries the terminal lifecycle for the UI to render.
    const created = events.find((e) => e.event.kind === 'terminal_created')?.event;
    if (created?.kind !== 'terminal_created') throw new Error('no terminal_created event');
    // The agent script runs under node, so the command it passed is node's
    // execPath — not the bun binary this test runs under.
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

  /** Scripted permission agent: asks to write, writes ONLY on approval. */
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
    // The parked turn is a first-class status, not a generic "running".
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
    // Effect oracle: approval produced the real artifact.
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
    // Effect oracle: absence is the asserted outcome, not just wire traffic.
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

/**
 * A stdio ACP agent whose thought-level options depend on the model — picking
 * `opus` unlocks `xhigh`, which `sonnet` doesn't offer. Exercises the initial-
 * config apply's model-first ordering + per-step re-validation.
 */
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

/**
 * A stdio ACP agent that advertises legacy `SessionModeState` modes (Claude's
 * permission-mode surface) and accepts `session/set_mode`. Exercises the
 * opt-in mode restore via `session/set_mode`.
 */
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

/**
 * A stdio ACP agent that exposes mode through a generalized mode-category
 * config option (the newer surface) rather than legacy `modes`. Exercises the
 * opt-in mode restore falling through to `session/set_config_option`.
 */
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

/**
 * A legacy-modes agent that *rejects* every `session/set_mode` with a JSON-RPC
 * error. Proves the opt-in mode restore is best-effort: a rejected set is
 * caught and the thread still reaches `ready` on the agent's default mode.
 */
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
      // `ghost` isn't in availableModes → no set_mode is sent; the session
      // stays on its own default rather than arming a retired mode.
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
    // The set_mode rejection is caught (best-effort) — startup must not hang.
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    // The refused mode did not stick; the session stays on its own default.
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
      // thought_level listed first on purpose: it's only valid AFTER the model
      // switches to opus, so a correct apply must order model → thought_level.
      // `retired_option` pins the skip contract: a remembered key this agent
      // version no longer advertises must be ignored, not fail the launch.
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
      // No model change → the model stays sonnet, whose options lack `xhigh`,
      // so the stored thought_level is dropped rather than sent-and-rejected.
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

  /** Agent that echoes each prompt and holds a WAIT-marked turn open until
   *  `releasePath` exists — the deterministic gate the queue forms behind. */
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

  /**
   * The same gate, but this agent HONORS `session/cancel` the compliant way:
   * it stops waiting and answers the in-flight prompt with stopReason
   * 'cancelled'. The gate agent above ignores cancel entirely — between them
   * they cover both halves of what real adapters do.
   */
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

    // Edit the head in place, drop the middle; unknown ids are silent no-ops.
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

    // FIFO order with the edit applied; the removed entry never ran.
    const text = agentText(events);
    expect(text).toContain('ran:second final;');
    expect(text).toContain('ran:fourth;');
    expect(text).not.toContain('second draft');
    expect(text).not.toContain('ran:third;');
    expect(text.indexOf('ran:second final;')).toBeLessThan(text.indexOf('ran:fourth;'));

    // Each drained prompt landed as a normal user turn in the transcript.
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

    // Turn ends: the drain skips the held head and takes the entry behind it.
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

    // Released while nothing is running, it has no turn-end continuation left
    // to ride — the release itself has to dispatch it.
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

    // The save IS the resubmit: the hold clears with the content, and since the
    // turn already ended the edit dispatches on the spot.
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

    // The entry is gone, so a second save on the same id is a lost race — the
    // socket needs the `false` to tell the user their edit never landed.
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

    // The gate agent ignores session/cancel — release it and confirm the
    // cleared queue never drains.
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

    // Killing the agent mid-turn takes the thread terminal. The queue has to go
    // with it: entries that outlive the agent render as messages the user can
    // see but can never dispatch.
    await manager.closeThread(info.threadId);
    expect(manager.getInfo(info.threadId)?.queue).toBeUndefined();
  }, 40_000);

  test('neither the queue nor a parked steer is persisted — a rehydrated thread comes back empty', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeGateAgent(localDir, join(localDir, 'release-turn'));
    // Long stall window: the steer has to still be PARKED when the thread
    // archives, or the demotion would fold it into the queue and this test
    // would only re-cover the queue.
    const manager = makeManager(contentDir, localDir, { steerStallMs: 60_000 });
    // init() creates the threads dir — without it the archive's meta write has
    // nowhere to land and there is nothing for manager2 to rehydrate.
    await manager.init();
    const info = await manager.createThread({ agent: { source: 'custom', id: 'gate-agent' } });
    await manager.subscribe(info.threadId, 0, () => {});
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    manager.sendPrompt(info.threadId, 'WAIT at the gate');
    await waitUntil(() => internals(manager).turnActive(info.threadId), 5_000, 'turn active');
    manager.sendPrompt(info.threadId, 'queued while busy');
    expect(manager.getInfo(info.threadId)?.queue?.length).toBe(1);
    // The gate agent ignores session/cancel, so the correction stays parked.
    manager.steerPrompt(info.threadId, 'steered while busy');
    expect(manager.getInfo(info.threadId)?.steer?.content).toBe('steered while busy');

    await manager.closeThread(info.threadId);

    // A fresh manager over the same persistence dir rehydrates the archived
    // thread from its meta. `buildMeta` strips both on the way out, so neither
    // may come back — otherwise a restart resurrects undispatchable prompts.
    const manager2 = makeManager(contentDir, localDir);
    await manager2.init();
    expect(manager2.getInfo(info.threadId)).toBeDefined();
    expect(manager2.getInfo(info.threadId)?.queue).toBeUndefined();
    expect(manager2.getInfo(info.threadId)?.steer).toBeUndefined();
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
    // Parked, not queued — and the queue keeps its place behind it.
    expect(manager.getInfo(info.threadId)?.steer?.content).toBe('do this instead');
    expect((manager.getInfo(info.threadId)?.queue ?? []).map((m) => m.content)).toEqual([
      'queued before the steer',
    ]);

    // Three turns: the cancelled one, the correction, then the queued message.
    // The gate is never released — the cancel is what ends turn one.
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
    // This gate agent never reads session/cancel — the stall fallback is the
    // only thing that can rescue the correction.
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

  /**
   * The same ignore-the-cancel gate, but this agent answers the release by
   * REJECTING the in-flight `session/prompt` instead of resolving it — the
   * other half of what real adapters do with a cancel, and the path that
   * lands in `dispatchPrompt`'s `.catch` with a cancel already requested.
   */
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

    // The rejection ends the turn on the cancel path, which used to emit
    // 'ready' and stop — leaving the demoted correction queued forever.
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
    // Long stall window: the point is what Stop does, not what the fallback does.
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

    // The gate agent ignores cancel — release it and confirm neither the steer
    // nor the queue comes back to life through the turn-end continuation.
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
});

describe.skipIf(process.platform === 'win32')('login-shell PATH fallback', () => {
  /**
   * The nvm/fnm shape: the agent's command exists, but only in a directory
   * that the inherited PATH and its static augmentation cannot name. The shim
   * dir stands in for `~/.nvm/versions/node/<v>/bin` — reachable from a
   * terminal, invisible to a Dock-launched server.
   */
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
    // Reaching 'ready' means preflight, spawn, and the ACP handshake all ran
    // against a binary that only the injected login-shell PATH could find.
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

/**
 * Agent that reports the PATH it was spawned with as its first message. The
 * top-level command (`node`) resolves from the inherited PATH, so preflight
 * succeeds without help — what this proves is what the agent's own nested
 * lookups (`npx pi-acp` spawning `pi`) would see.
 */
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
  /**
   * The `npx pi-acp` shape: the top-level command is findable, the binary the
   * adapter goes on to spawn is not. Preflight passes, so the failure-only
   * fallback never fired and the nested lookup ran against a PATH that had
   * never seen the user's profile.
   */
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
    // Reaching 'ready' at all means preflight resolved `node` without the shim.
    expect(manager.getInfo(info.threadId)?.status).toBe('ready');
    expect(reportedPath()).toContain(shimDir);
  }, 30_000);
});

/**
 * Agent that fails `session/new` until `markerPath` exists — the "install the
 * thing the error told you to install, then retry" shape, made deterministic.
 */
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

    // Still broken: the retry has to report the failure it landed on rather
    // than resolve on a thread that is right back where it started.
    await expect(manager.retryThread(info.threadId)).rejects.toThrow(/harness not installed/);
    expect(manager.getInfo(info.threadId)?.status).toBe('error');

    writeFileSync(marker, '');
    const retried = await manager.retryThread(info.threadId);
    expect(retried.status).toBe('ready');
    expect(manager.getInfo(info.threadId)?.status).toBe('ready');

    // The retried thread is a working thread, not just a green status.
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

    // Unlike every other failure, `auth_required` keeps its process alive so a
    // sign-in costs no respawn — which makes the retry responsible for killing
    // it. A leaked agent here is a real orphan, not a status artifact.
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

  test('refuses a thread that started fine', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeExampleAgentEntry(localDir);

    const manager = makeManager(contentDir, localDir);
    const info = await manager.createThread({ agent: { source: 'custom', id: 'example' } });
    await manager.subscribe(info.threadId, 0, () => {});
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'ready', 15_000, 'ready');

    // A live session means a live agent — respawning under it would strand a
    // process whose output the user can still see.
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
    // A failed thread archives on close (its transcript is the only record of
    // what went wrong), so the record is still addressable afterwards.
    await manager.closeThread(info.threadId);
    expect(manager.getInfo(info.threadId)?.archived).toBe(true);
    await expect(manager.retryThread(info.threadId)).rejects.toThrow(/archived/);
  }, 40_000);
});

/**
 * Agent that advertises an auth method at `initialize` and then rejects
 * `session/new` with a baked-in JSON-RPC error — the wire shape that decides
 * whether OK reads a failure as "sign in" or as a broken launch.
 */
function writeSessionFailingAgentEntry(
  localDir: string,
  id: string,
  error: { code: number; message: string; data: unknown },
  /** Startup chatter on stderr — the boot banners and package-manager warnings
   *  a real agent writes before it says anything about the failure. */
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

/**
 * Agent that parks on sign-in and then lets it through: `session/new` fails
 * with the auth code until an `authenticate` for `test_login` arrives, after
 * which it opens a session normally. Advertises one agent-driven method and
 * one `env_var` method so both discriminant shapes cross the wire.
 */
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

/**
 * Agent that opens a session normally but rejects every `session/prompt` with
 * the ACP AUTH_REQUIRED code — the shape a real adapter takes when the user's
 * OAuth token expired between the initialize handshake and the first user
 * turn.
 */
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

/**
 * Agent that rejects `session/prompt` with the Claude Agent SDK's shape for
 * mid-turn OAuth expiry: JSON-RPC `-32603` "Internal error" plus a data
 * payload of `{ errorKind: 'authentication_failed' }`. The wire code is NOT
 * the ACP `-32000` — the discriminator lives in `data.errorKind`.
 */
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

/**
 * Agent parked on sign-in that NEVER answers `authenticate` — the abandoned
 * browser-tab shape. `session/new` keeps failing with the auth code until
 * `markerPath` exists, so a retry (which respawns) can still reach ready and
 * the recovery paths around an unanswered sign-in are drivable end to end.
 */
/**
 * An agent that reads its credentials once at startup, the way a real CLI does:
 * `authenticate` succeeds and writes the marker, but THIS process still refuses
 * `session/new` because it decided at boot that it was signed out. Only a fresh
 * process sees the credential.
 */
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
  /** Emit a device-code flow's stderr prose: boot noise, then a code once
   *  `authenticate` arrives — the shape a real OAuth-device agent has. */
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

describe('AcpThreadManager auth classification', () => {
  type StatusEvent = Extract<ThreadEvent, { kind: 'status' }>;

  const collectStatuses = (into: StatusEvent[]) => (frame: ThreadServerFrame) => {
    const push = (event: ThreadEvent): void => {
      if (event.kind === 'status') into.push(event);
    };
    if (frame.op === 'event') push(frame.event);
    if (frame.op === 'events') for (const event of frame.events) push(event);
  };

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
    // The broadcast is batched, so the status event lands after the snapshot
    // flips — wait for the event itself, which is what the app renders from.
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
    // The wire payload belongs in the disclosure, never in the headline the
    // user reads first.
    expect(event?.detail ?? '').not.toContain('"detail":"x"');

    await manager.closeThread(info.threadId);
  }, 30_000);

  // Nothing has gone wrong on a thread waiting to authenticate — the process is
  // healthy — so its stderr is only startup chatter, and burying the agent's own
  // "where to sign in" line under it helps nobody.
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

    // An agent that advertises auth methods used to make every session failure
    // look like a sign-in prompt — the classification now comes from the error
    // code alone.
    expect(withStatus(statuses, 'auth_required')).toBeUndefined();
    const event = withStatus(statuses, 'error');
    expect(event?.failure?.reason).toBe('session-setup');
    expect(event?.failure?.agentMessage).toBe('Failed to initialize session services');
    expect(event?.failure?.machineDetail).toContain('"cause":"services"');
    // A real failure is the case the disclosure exists for: stderr is often the
    // only evidence of why the agent died, so the tail stays attached here.
    expect(event?.failure?.machineDetail).toContain('boot: loading services');

    // A session that never opened leaves the process nothing to do.
    await waitUntil(
      () => internals(manager).child(info.threadId) === null,
      10_000,
      'agent child torn down',
    );

    await manager.closeThread(info.threadId);
  }, 30_000);

  test('closing a failed thread archives it instead of erasing its evidence', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeSessionFailingAgentEntry(localDir, 'broken-agent', {
      code: -32603,
      message: 'Failed to initialize session services',
      data: { cause: 'services' },
    });
    const manager = makeManager(contentDir, localDir);
    // init() creates the threads dir the archive's meta write lands in.
    await manager.init();
    const info = await manager.createThread({ agent: { source: 'custom', id: 'broken-agent' } });
    await manager.subscribe(info.threadId, 0, () => {});
    await waitUntil(() => manager.getInfo(info.threadId)?.status === 'error', 15_000, 'error');

    // The thread never took a user message (the composer is disabled on a
    // failed start), so the empty-thread discard used to delete the only
    // record of what went wrong.
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
    // The SDK's discriminant rides the wire: the client has to tell a sign-in
    // it can drive from one that needs the user's own environment.
    expect(withStatus(statuses, 'auth_required')?.failure?.authMethods).toEqual([
      { id: 'test_login', name: 'Test Login', description: 'Sign in via test' },
      { id: 'test_env', name: 'Env Login', kind: 'env_var' },
    ]);

    // The child's identity IS the assertion: a thread parked on sign-in keeps
    // its agent alive precisely so authenticating costs no respawn.
    const child = internals(manager).child(info.threadId);
    expect(child).toBeDefined();

    const signedIn = await manager.authenticateThread(info.threadId, 'test_login');
    expect(signedIn.status).toBe('ready');
    expect(manager.getInfo(info.threadId)?.status).toBe('ready');
    expect(internals(manager).child(info.threadId)).toBe(child);

    // …and the session that opened behind the sign-in takes a real turn.
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
    // A refused sign-in is an answer the user can act on again, so it leaves
    // its own notice — with the methods still offered.
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

  // A device-code flow prints its code to stderr, because before a session
  // exists ACP gives the agent no other channel — and the browser asks the user
  // to confirm that code against what their device shows. Dropping it leaves
  // them nothing to compare, so the confirmation step checks nothing.
  test('a sign-in prompt keeps what the agent printed during the sign-in', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const marker = join(tmp(), 'signed-in-elsewhere');
    writeSilentAuthAgentEntry(localDir, 'coded-auth', marker, true);
    // Long enough that the child's stderr reaches the parent before the sign-in
    // gives up — the assertion is about what the prompt carries, not timing.
    const manager = makeManager(contentDir, localDir, { authenticateTimeoutMs: 1_500 });
    const statuses: StatusEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'custom', id: 'coded-auth' } });
    await manager.subscribe(info.threadId, 0, collectStatuses(statuses));
    await waitUntil(() => withStatus(statuses, 'auth_required') !== undefined, 15_000, 'auth');

    // Before any sign-in: startup noise only, and none of it is worth showing.
    expect(withStatus(statuses, 'auth_required')?.failure?.machineDetail ?? '').not.toContain(
      'npm warn',
    );

    await expect(manager.authenticateThread(info.threadId, 'test_login')).rejects.toThrow(
      /didn't complete in time/,
    );

    // The broadcast coalesces, so the re-prompt lands a tick after the rejection.
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

    // Live: the code has to reach the user while the browser still wants it,
    // not batched behind the next status change.
    await waitUntil(
      () => infos.some((i) => (i.signInOutput ?? []).some((l) => l.includes('CRQT-NXNT'))),
      10_000,
      `the code to publish; got ${JSON.stringify(infos.map((i) => i.signInOutput))}`,
    );
    // Startup noise stays out — it was written before the sign-in began.
    const published = infos.flatMap((i) => i.signInOutput ?? []);
    expect(published.join('\n')).not.toContain('npm warn');

    expect(String(await signIn)).toMatch(/didn't complete in time/);
    // The wait is over, so the transient output goes with it.
    await waitUntil(
      () => manager.getInfo(info.threadId)?.signInOutput === undefined,
      10_000,
      'the sign-in output to clear',
    );

    await manager.closeThread(info.threadId);
  }, 40_000);

  // A CLI that reads its credentials at startup cannot see a sign-in that
  // happened after it booted, so `session/new` refuses even though the sign-in
  // worked. Handing the user back the prompt they just answered is the wrong
  // answer when relaunching demonstrably fixes it.
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

    // The sign-in resolves as a sign-in: ready, not parked on a second prompt.
    expect(signedIn.status).toBe('ready');
    expect(manager.getInfo(info.threadId)?.status).toBe('ready');
    expect(statuses.filter((e) => e.status === 'auth_required').length).toBe(promptsBeforeSignIn);

    // …and the thread genuinely works, on the relaunched process.
    const events: ThreadEvent[] = [];
    await manager.subscribe(info.threadId, 0, (frame: ThreadServerFrame) => {
      if (frame.op === 'event') events.push(frame.event);
      if (frame.op === 'events') events.push(...frame.events);
    });
    manager.sendPrompt(info.threadId, 'hello');
    await waitUntil(() => events.some((e) => e.kind === 'turn_ended'), 15_000, 'a completed turn');

    await manager.closeThread(info.threadId);
  }, 40_000);

  // The relaunch can fail before it reports anything: `resolveAgentInfo`
  // rejects on an unknown agent ahead of the first `emitStatus`. Leaving
  // `authenticating` standing would wedge the thread, because the retry guard
  // admits only `error` / `auth_required`.
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

    // The agent disappears from the registry mid-sign-in, so the relaunch
    // rejects in `resolveAgentInfo` — before it can emit a status of its own.
    writeFileSync(join(localDir, 'acp-agents.json'), JSON.stringify([]));

    await expect(manager.authenticateThread(info.threadId, 'test_login')).rejects.toThrow();

    const settled = manager.getInfo(info.threadId)?.status;
    expect(settled).not.toBe('authenticating');
    expect(settled).toBe('auth_required');
    // Still actionable: the retry guard admits `auth_required`, so the user's
    // Retry reaches the launch instead of being refused.
    await expect(manager.retryThread(info.threadId)).rejects.toThrow(/no custom agent/);

    await manager.closeThread(info.threadId);
  }, 40_000);

  // The sign-in buffer belongs to the sign-in. A relaunch spawns a different
  // process, and its boot chatter must not reach the next prompt as if it were
  // this sign-in's device code.
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

    // Nothing is left publishing into the sign-in channel once it is over.
    expect(manager.getInfo(info.threadId)?.signInOutput).toBeUndefined();
    expect(infos.at(-1)?.signInOutput).toBeUndefined();

    await manager.closeThread(info.threadId);
  }, 40_000);

  // The field documents itself as never persisted; `buildMeta` has to agree,
  // or a spent device code rides back out of the meta file on rehydrate.
  // The field documents itself as never persisted; `buildMeta` has to agree,
  // or a spent device code rides back out of the meta file on rehydrate.
  test('sign-in output never reaches the persisted meta', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const marker = join(tmp(), 'credential-written-by-authenticate');
    writeStartupCredentialAgentEntry(localDir, 'meta-scope', marker);
    const manager = makeManager(contentDir, localDir);
    // Persistence only opens its `threads/` dir once the manager boots.
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

    // A thread with no user message is discarded on close rather than
    // archived, and discarding takes the meta with it — so give it a turn.
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

    // ACP puts no ceiling on `authenticate`; without one of our own an
    // abandoned browser flow held the thread's latch forever.
    await expect(manager.authenticateThread(info.threadId, 'test_login')).rejects.toThrow(
      /didn't complete in time/,
    );
    expect(manager.getInfo(info.threadId)?.status).toBe('auth_required');
    const latest = statuses.filter((e) => e.status === 'auth_required').at(-1);
    expect(latest?.failure?.authMethods?.map((m) => m.id)).toEqual(['test_login']);

    // …and the thread still takes a retry, which is the way out of it.
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
    // No authenticate timeout worth waiting for — the retry is what ends it.
    const manager = makeManager(contentDir, localDir);
    const statuses: StatusEvent[] = [];
    const info = await manager.createThread({ agent: { source: 'custom', id: 'silent-auth' } });
    await manager.subscribe(info.threadId, 0, collectStatuses(statuses));
    await waitUntil(() => withStatus(statuses, 'auth_required') !== undefined, 15_000, 'auth');

    const authNoticesBeforeRetry = statuses.filter((e) => e.status === 'auth_required').length;
    // Captured as a settled value, not left dangling: the retry rejects it and
    // an unobserved rejection would fail the run.
    const signIn = manager
      .authenticateThread(info.threadId, 'test_login')
      .then(() => null)
      .catch((err: unknown) => err);
    // A sign-in in flight has a status of its own: reporting `installing` here
    // told the user the agent was starting when it was waiting on them.
    expect(manager.getInfo(info.threadId)?.status).toBe('authenticating');

    writeFileSync(marker, '');
    const retried = await manager.retryThread(info.threadId);
    expect(retried.status).toBe('ready');

    // The sign-in stands down without a word — its own failure notice would
    // otherwise overwrite the ready state the retry just established.
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

    // The agent opens a session normally — the auth failure lives on the
    // prompt path, not the startup path.
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'ready',
      15_000,
      `ready; got ${JSON.stringify(statuses.map((e) => e.status))}`,
    );

    // Send the prompt whose rejection is the reproduction. Before this branch
    // existed the prompt-catch classified every non-cancel rejection as
    // `reason: 'prompt'`, which the client renders as the opaque
    // "Your message didn't reach X" card with no reauth affordance.
    manager.sendPrompt(info.threadId, 'hello');

    await waitUntil(
      () => withStatus(statuses, 'auth_required') !== undefined,
      15_000,
      `auth_required from prompt; got ${JSON.stringify(statuses.map((e) => e.status))}`,
    );

    const notice = withStatus(statuses, 'auth_required');
    expect(notice?.failure?.reason).toBe('auth-required');
    expect(notice?.failure?.agentMessage).toContain('OAuth session expired');
    // The buttons the client renders come from the still-live connection's
    // initialize response — the record keeps `lastInit` exactly so this reopen
    // path has them without a fresh handshake.
    expect(notice?.failure?.authMethods).toEqual([
      { id: 'reauth_login', name: 'Reauth Login', description: 'Sign back in' },
    ]);
    // Not `error`: the manager must not tear the thread down or drop the queue —
    // the child stays alive so `authenticate` can run on the same connection.
    expect(withStatus(statuses, 'error')).toBeUndefined();
    expect(manager.getInfo(info.threadId)?.status).toBe('auth_required');

    await manager.closeThread(info.threadId);
  }, 30_000);

  test('a Claude-shape `-32603` + errorKind=authentication_failed prompt rejection parks on sign-in', async () => {
    // Claude Agent SDK returns a JSON-RPC internal-error code when its OAuth
    // token expires mid-turn — the ACP `-32000` is only what `session/new`
    // uses. The classifier has to recognize BOTH shapes; the first mid-turn
    // fix landed with only the ACP shape and reproduced as the unchanged
    // "message didn't reach" card against a real Claude adapter.
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

  /** Enough of a session for `handleFsWrite`'s markdown branch to apply a write. */
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
    // A turn that only talks — the example agent parks on a permission prompt,
    // which is not the path under test here.
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

    // Ready, turn start, and turn settle used to publish an entry each, which
    // blinked a chip into the presence bar and back out every prompt. The
    // agent's own MCP connection carries persistent presence already.
    expect(published).toEqual([]);
  }, 45_000);

  test('an ACP fs write publishes presence for that doc, under the agent brand icon', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    // The id doubles as the presence icon lookup, so name it as the registry
    // does — that is the shape the icon table has to resolve.
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

    // Exactly one entry — the write. No adapter-side MCP entry stands in for
    // an ACP-native fs write, and follow-the-file reads this.
    expect(published).toHaveLength(1);
    expect(published[0]?.entry.currentDoc).toBe('notes/planted');
    expect(published[0]?.entry.mode).toBe('writing');
    // Before the icon table learned the registry ids, every ACP agent landed
    // on the generic 'bot' mark.
    expect(published[0]?.entry.icon).toBe('openai');

    await manager.closeThread(info.threadId);
  }, 45_000);
});

/**
 * A thread's failure detail is what a bug report is diagnosed from, and the
 * transcript that shows it to the user is neither collected into a diagnostic
 * bundle nor guaranteed to survive (the user can delete a thread). The server
 * log is, so an agent's own last words have to reach it explicitly — nothing
 * else on these paths forwards them.
 */
function writeCrashingAgentEntry(localDir: string, id: string, stderrLine: string): void {
  const agentPath = join(localDir, `${id}.mjs`);
  // Dies before the handshake, the way an interpreter that can't load its own
  // libraries does — the last thing it says is on stderr.
  writeFileSync(agentPath, `process.stderr.write(${JSON.stringify(`${stderrLine}\n`)});\n`);
  writeFileSync(
    join(localDir, 'acp-agents.json'),
    JSON.stringify([{ id, name: `Fake ${id}`, command: 'node', args: [agentPath] }]),
  );
}

/**
 * Agent that completes the handshake, then dies mid-session with something on
 * stderr — the "it was working and then it wasn't" shape.
 */
function writeExitAfterReadyAgentEntry(
  localDir: string,
  id: string,
  stderrLine: string,
  dieFile: string,
): void {
  const agentPath = join(localDir, `${id}.mjs`);
  writeFileSync(
    agentPath,
    `
import { existsSync } from 'node:fs';
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
// Dies only when the test says so, and with no request in flight. A timed
// exit raced session setup: landing first, it failed the pending session/new,
// which puts the thread in 'error' — a status whose exit is a known echo and
// is deliberately not logged again.
setInterval(() => {
  if (!existsSync(${JSON.stringify(dieFile)})) return;
  process.stderr.write(${JSON.stringify(stderrLine)} + '\\n');
  process.exit(7);
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
}

/** Logger that keeps every line so a test can assert on what an operator sees. */
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

    // The user-facing detail names only the symptom ("ACP connection closed");
    // the cause rides on machineDetail, so the log line must carry that too.
    const failureLine = lines.find((l) => l.msg.includes('thread failure status'));
    expect(failureLine).toBeDefined();
    expect(String(failureLine?.obj.detail)).not.toContain('libicui18n.74.dylib');
    expect(String(failureLine?.obj.machineDetail)).toContain('libicui18n.74.dylib');
  }, 30_000);

  test('an agent that dies after going ready logs the unexpected exit', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const lines: { obj: Record<string, unknown>; msg: string }[] = [];
    const dieFile = join(localDir, 'die-now');
    writeExitAfterReadyAgentEntry(localDir, 'quitter', 'agent ran out of memory', dieFile);

    const manager = makeManager(contentDir, localDir, { log: capturingLog(lines) });
    const info = await manager.createThread({ agent: { source: 'custom', id: 'quitter' } });
    // Ready FIRST, then kill it: with no request in flight, the exit is the
    // only thing that can move the status, so the assertion can't race.
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'ready',
      15_000,
      'the agent to go ready',
    );
    writeFileSync(dieFile, 'now');
    await waitUntil(
      () => manager.getInfo(info.threadId)?.status === 'exited',
      15_000,
      'the agent to exit',
    );

    // 'exited' is not a failure status, so nothing else would have logged it —
    // yet an agent vanishing mid-session is exactly what a report is about.
    const exitLine = lines.find((l) => l.msg.includes('agent exited unexpectedly'));
    expect(exitLine).toBeDefined();
    expect(exitLine?.obj.code).toBe(7);
    expect(String(exitLine?.obj.machineDetail)).toContain('ran out of memory');
  }, 30_000);
});

/**
 * The one legacy producer envelope the transcript restyles as runtime status.
 * Recorded from the registry-selected adapter; the fake agent below replays
 * those exact bytes so the server's retention decision is made against real
 * producer output rather than a paraphrase of it.
 */
const CODEX_WARNING_TEXT = codexFixture.candidates.find((c) => c.name === 'warning-skills-budget')
  ?.update.content.text as string;
const CODEX_NEIGHBOR_TEXTS = [
  codexFixture.neighbors.contextCompacted.update.content.text,
  codexFixture.neighbors.turnError.update.content.text,
] as const;

/**
 * A turn that emits real no-ID Codex chrome on both sides of a real warning
 * envelope, written to stdout in ONE call so the whole run reaches the
 * coalescer inside a single flush window. Neighbours on both sides are what
 * makes the retention verdict observable: a boundary can then only come from
 * the guard, never from a flush landing there.
 */
function codexLegacyTurnTexts(): string[] {
  const [compacted, turnError] = CODEX_NEIGHBOR_TEXTS;
  return [compacted, compacted, turnError, CODEX_WARNING_TEXT, turnError, compacted, turnError];
}

function agentTextUpdate(text: string): unknown {
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } };
}

/**
 * A fake ACP agent reachable the way a registry agent is: through an `npx`
 * shim on the manifest's own overlay PATH. Registry source is not cosmetic
 * here — it is half of the identity the retention guard consults, and a custom
 * entry could never carry it.
 *
 * `updates` are emitted verbatim as the payloads of one prompt turn, so a
 * caller can put a shape the SDK does not accept on the wire.
 */
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
  // The launch path probes `node --version` for npx compatibility before it
  // spawns anything, and the overlay PATH is the only place it can look.
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
    // Retention is all the guard changes: no event kind was invented for it,
    // and folding still assigns no seq of its own.
    expect(retained.map((r) => r.event.kind)).not.toContain('agent_notice');
    expect(retained.map((r) => r.seq)).toEqual(retained.map((_, i) => i));
  }, 45_000);

  test('ordinary no-ID chrome around the warning still coalesces', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    const { retained } = await runTurn('codex-acp', contentDir, localDir, tmp());
    const texts = messageTexts(retained);

    // Seven emitted chunks; the guard draws exactly two boundaries, so the
    // neighbours on each side must still have folded into far fewer events.
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

    // The identity is what the decision turns on: byte-identical output from a
    // different registry agent must stay ordinary prose. A flush cannot fake
    // this — isolating the warning would take two timer fires inside one burst.
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
    // The line index IS the seq, so a line-for-line match with the broadcast
    // proves durability rode the same boundaries the subscriber saw.
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
    // Close appends its own status after the live subscription was taken, so
    // the live log is a prefix of the replayed one rather than equal to it.
    expect(replayed.map((r) => r.event.kind).slice(0, live.length)).toEqual(
      live.map((e) => e.kind),
    );
    expect(warningSeq(replayed)).toEqual(warningSeq(retained));
    expect(replayed.map((r) => r.seq)).toEqual(replayed.map((_, i) => i));
  }, 60_000);
});

/**
 * The SDK-level canary characterizes the installed validator in isolation.
 * This one asks the question the product actually cares about: when an agent
 * puts a typed notice on the wire mid-turn, does OK's own thread keep working?
 * The rejection happens inside the SDK's static router, upstream of
 * `handleSessionUpdate`, so nothing short of a real spawned connection can
 * show whether the surrounding turn survives it.
 */
describe.skipIf(process.platform === 'win32')('a typed session notice mid-turn', () => {
  const BEFORE = 'chunk emitted before the notice';
  const AFTER = 'chunk emitted after the notice';

  /**
   * A `notice` session update carrying the required severity + title of ACP's
   * unstable Session Notices schema.
   */
  const typedNotice = {
    sessionUpdate: 'notice',
    severity: 'warning',
    title: 'skill bundle exceeded its budget',
  };

  type NoticeTurns = {
    manager: AcpThreadManager;
    threadId: string;
    /** Every retained session_update payload, in source order. */
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
        // Read the log, don't keep watching it: a live subscriber also pins
        // the thread's unwatched-turn clock, which this is not testing.
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

    // Asserted as the WHOLE discriminator set, not as the absence of one
    // string: an extractor reading the wrong key would report nothing but
    // `undefined` and still satisfy a bare `not.toContain('notice')`.
    expect(new Set(updates.map((u) => u.sessionUpdate))).toEqual(new Set(['agent_message_chunk']));
    // Both neighbours landing is the other half of the control: an empty
    // transcript would satisfy the absence claim without proving anything.
    expect(textOf(updates)).toContain(BEFORE);
    expect(textOf(updates)).toContain(AFTER);
  }, 45_000);

  test('leaves the connection usable for a whole further turn', async () => {
    const thread = await startThreadEmittingNotice();
    const firstTurn = textOf(await thread.updates());

    await thread.promptAgain();
    const bothTurns = textOf(await thread.updates());

    // A connection torn down by the notice would strand the second prompt
    // rather than answer it, so the doubling is the survival evidence.
    expect(bothTurns.split(AFTER)).toHaveLength(3);
    expect(bothTurns.length).toBe(firstTurn.length * 2);
    expect(thread.manager.getInfo(thread.threadId)?.status).toBe('ready');
  }, 60_000);
});
