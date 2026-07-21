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

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ThreadEvent,
  ThreadServerFrame,
} from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { afterEach, describe, expect, test } from 'vitest';
import type { AgentSessionManager } from '../agent-sessions.ts';
import { getLogger } from '../logger.ts';
import { AcpPermissionStore } from './permissions.ts';
import { AcpRegistry } from './registry.ts';
import { AcpThreadManager } from './thread-manager.ts';

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
    unwatchedTurnCancelMs?: number;
    unwatchedTurnKillMs?: number;
    isIgnoredPath?: (relPosix: string) => boolean;
    registry?: AcpRegistry;
  },
): AcpThreadManager {
  const manager = new AcpThreadManager({
    contentDir,
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
    log,
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
} {
  const m = manager as unknown as {
    reapIdleThreads: () => void;
    threads: Map<string, { pendingPermissions: Map<unknown, unknown>; turnActive: boolean }>;
  };
  return {
    sweep: () => m.reapIdleThreads(),
    pendingPermissionCount: (threadId) => m.threads.get(threadId)?.pendingPermissions.size ?? 0,
    turnActive: (threadId) => m.threads.get(threadId)?.turnActive ?? false,
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

    manager.setConfigOption(info.threadId, 'model', 'opus');
    await waitFor(
      () => manager.getInfo(info.threadId)?.configOptions?.[0]?.currentValue === 'opus',
      10_000,
    );

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
const caps = (process.env.FAKE_CAPS ?? '').split(',').filter(Boolean);
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
      reply({ sessionId: 'sess-fixed' });
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
        reply({});
      }
    } else if (msg.method === 'session/resume') {
      if (msg.params.sessionId !== 'sess-fixed') replyErr(-32002, 'unknown session');
      else reply({});
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
  const agentChunks = (events: Collected): string[] =>
    events
      .map((e) => e.event)
      .filter((e) => e.kind === 'session_update')
      .map((e) => {
        const update = (e as { update?: { content?: { text?: string } } }).update;
        return update?.content?.text ?? '';
      });

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
    expect(agentChunks(replayed)).toContain('echo:hello there');
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

  test('resume via session/resume: same thread continues, no history duplication', async () => {
    const contentDir = tmp();
    const localDir = tmp();
    writeResumableAgentEntry(localDir, 'fake-resume', { FAKE_CAPS: 'resume,load' });
    const manager = makeManager(contentDir, localDir);
    await manager.init();
    const threadId = await runOneTurn(manager, 'fake-resume', 'first message');
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
    expect(agentChunks(replayed)).toEqual(['echo:first message', 'echo:second message']);

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
    expect(agentChunks(replayed)).toEqual(['echo:first message', 'echo:second message']);
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
    expect(agentChunks(replayed)).toContain('echo:first message');
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
    expect(agentChunks(replayed)).toContain('echo:survives shutdown');
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
async function handlePrompt(msg) {
  const finish = () => write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
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
