/**
 * Frame-level coverage of the `/collab/thread` socket for the history ops:
 * `resume` (success → `resumed` frame; failure → error frame carrying the
 * reqId + `resume-unsupported`), `delete` (refused live / applied archived,
 * followed by a refreshed `threads` list), `rename` (live + archived, manual
 * title wins over first-prompt adoption), and archived `subscribe` replay
 * through the socket's async path.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { attachAcpThreadSocket } from './thread-socket.ts';

const log = getLogger('acp-thread-socket-test');

const fakeSessionManager = {
  getSession: async () => {
    throw new Error('fixture agents never use client fs');
  },
  closeAllForAgent: async () => {},
} as unknown as AgentSessionManager;

let dirs: string[] = [];
let managers: AcpThreadManager[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'acp-socket-test-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.allSettled(managers.map((m) => m.destroy()));
  managers = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** Same minimal capability-matrix agent as the manager integration suite. */
function writeFixtureAgent(
  localDir: string,
  caps: string,
  extraEnv?: Record<string, string>,
): void {
  const agentPath = join(localDir, 'fixture-agent.mjs');
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
    if (msg.method === 'initialize') {
      const agentCapabilities = {};
      if (caps.includes('resume')) agentCapabilities.sessionCapabilities = { resume: {} };
      reply({ protocolVersion: 1, agentCapabilities });
    } else if (msg.method === 'session/new') {
      reply({ sessionId: 'sess-fixed' });
    } else if (msg.method === 'session/prompt') {
      if (caps.includes('gate-prompt')) {
        (async () => {
          const fs = await import('node:fs');
          while (!fs.existsSync(process.env.FAKE_RELEASE)) {
            await new Promise((r) => setTimeout(r, 20));
          }
          reply({ stopReason: 'end_turn' });
        })();
      } else {
        reply({ stopReason: 'end_turn' });
      }
    } else if (msg.method === 'session/resume') {
      reply({});
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
      {
        id: 'fixture',
        name: 'Fixture',
        command: 'node',
        args: [agentPath],
        env: { FAKE_CAPS: caps, ...extraEnv },
      },
    ]),
  );
}

interface FakeSocket {
  frames: ThreadServerFrame[];
  emit(raw: string): void;
  close(): void;
  awaitFrame<T extends ThreadServerFrame['op']>(
    op: T,
    ms?: number,
  ): Promise<Extract<ThreadServerFrame, { op: T }>>;
}

function attachFakeSocket(manager: AcpThreadManager): FakeSocket {
  const frames: ThreadServerFrame[] = [];
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const ws = {
    send(data: string) {
      frames.push(JSON.parse(data) as ThreadServerFrame);
    },
    close() {},
    on(event: string, listener: (...args: unknown[]) => void) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
  };
  attachAcpThreadSocket(ws, manager, log);
  return {
    frames,
    emit: (raw) => {
      for (const l of listeners.get('message') ?? []) l(raw);
    },
    close: () => {
      for (const l of listeners.get('close') ?? []) l();
    },
    awaitFrame: async (op, ms = 20_000) => {
      const deadline = Date.now() + ms;
      let cursor = 0;
      for (;;) {
        for (; cursor < frames.length; cursor++) {
          const frame = frames[cursor];
          if (frame.op === op) {
            cursor++;
            // biome-ignore lint/suspicious/noExplicitAny: op-narrowed by the guard above
            return frame as any;
          }
        }
        if (Date.now() > deadline) {
          throw new Error(`no '${op}' frame; saw: ${frames.map((f) => f.op).join(',')}`);
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    },
  };
}

function makeManager(contentDir: string, localDir: string): AcpThreadManager {
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
    // Hermetic (see the thread-manager integration suite): every launch merges
    // the login shell's PATH, and a test must not spawn the developer's shell.
    resolveLoginShellPath: async () => null,
  });
  managers.push(manager);
  return manager;
}

async function waitStatus(
  manager: AcpThreadManager,
  threadId: string,
  status: string,
  ms = 15_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (manager.getInfo(threadId)?.status !== status) {
    if (Date.now() > deadline) {
      throw new Error(`status never became ${status}: ${manager.getInfo(threadId)?.status}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('/collab/thread socket — history ops', () => {
  test('resume round-trips as a resumed frame; delete refuses live and applies archived', async () => {
    const localDir = tmp();
    writeFixtureAgent(localDir, 'resume');
    const manager = makeManager(tmp(), localDir);
    await manager.init();
    const socket = attachFakeSocket(manager);

    socket.emit(
      JSON.stringify({ op: 'create', reqId: 'c1', agent: { source: 'custom', id: 'fixture' } }),
    );
    const created = await socket.awaitFrame('created');
    const threadId = created.info.threadId;
    await waitStatus(manager, threadId, 'ready');

    // A real message makes it a conversation worth keeping — an untouched
    // thread is discarded on close, never archived.
    socket.emit(JSON.stringify({ op: 'prompt', threadId, reqId: 'p0', content: 'hello' }));
    await waitStatus(manager, threadId, 'ready');

    // Delete on a live thread → not-ready error, thread intact.
    socket.emit(JSON.stringify({ op: 'delete', threadId }));
    const err1 = await socket.awaitFrame('error');
    expect(err1.code).toBe('not-ready');
    expect(manager.getInfo(threadId)).toBeDefined();

    socket.emit(JSON.stringify({ op: 'close', threadId }));
    const threadsAfterClose = await socket.awaitFrame('threads');
    expect(threadsAfterClose.threads[0]?.archived).toBe(true);

    // Reopen the archived thread the way the client does (history open =
    // subscribe), then resume through the socket: the resumed frame carries
    // the reqId + live info.
    socket.emit(JSON.stringify({ op: 'subscribe', threadId, sinceSeq: 0 }));
    await socket.awaitFrame('subscribed');
    socket.emit(JSON.stringify({ op: 'resume', threadId, reqId: 'r1', prompt: 'go' }));
    const resumed = await socket.awaitFrame('resumed');
    expect(resumed.reqId).toBe('r1');
    expect(resumed.info.archived).toBe(false);
    // Optimistic echo: the carried prompt reached subscribers as a
    // user_message BEFORE the handshake finished (the resumed frame) — the
    // transcript never sits empty while the agent respawns.
    const resumedAt = socket.frames.indexOf(resumed);
    const echoAt = socket.frames.findIndex(
      (f) =>
        f.op === 'events' && f.events.some((e) => e.kind === 'user_message' && e.content === 'go'),
    );
    expect(echoAt).toBeGreaterThanOrEqual(0);
    expect(echoAt).toBeLessThan(resumedAt);
    await waitStatus(manager, threadId, 'ready');

    // Archive again, then delete for real: threads list refresh excludes it.
    socket.emit(JSON.stringify({ op: 'close', threadId }));
    await waitStatus(manager, threadId, 'exited');
    socket.emit(JSON.stringify({ op: 'delete', threadId }));
    const deadline = Date.now() + 10_000;
    for (;;) {
      const listFrames = socket.frames.filter(
        (f): f is Extract<ThreadServerFrame, { op: 'threads' }> => f.op === 'threads',
      );
      const last = listFrames[listFrames.length - 1];
      if (listFrames.length >= 2 && last?.threads.length === 0) break;
      if (Date.now() > deadline) throw new Error('delete never refreshed the list');
      await new Promise((r) => setTimeout(r, 25));
    }
    socket.close();
  }, 45_000);

  test('resume-unsupported surfaces as an error frame with the reqId', async () => {
    const localDir = tmp();
    writeFixtureAgent(localDir, '');
    const manager = makeManager(tmp(), localDir);
    await manager.init();
    const socket = attachFakeSocket(manager);

    socket.emit(
      JSON.stringify({ op: 'create', reqId: 'c1', agent: { source: 'custom', id: 'fixture' } }),
    );
    const created = await socket.awaitFrame('created');
    const threadId = created.info.threadId;
    await waitStatus(manager, threadId, 'ready');
    // A real message so close archives it (an untouched thread is discarded).
    socket.emit(JSON.stringify({ op: 'prompt', threadId, reqId: 'p0', content: 'hello' }));
    await waitStatus(manager, threadId, 'ready');
    socket.emit(JSON.stringify({ op: 'close', threadId }));
    // The close op's own `threads` response is the signal that the close
    // FINISHED: the 'exited' status flips mid-teardown, while the record is
    // still marked closing, and a resume that lands in that window is refused
    // for a reason that has nothing to do with what this test asserts.
    await socket.awaitFrame('threads');

    socket.emit(JSON.stringify({ op: 'resume', threadId, reqId: 'r9' }));
    const err = await socket.awaitFrame('error');
    expect(err.code).toBe('resume-unsupported');
    expect(err.reqId).toBe('r9');
    expect(manager.getInfo(threadId)?.archived).toBe(true);
    socket.close();
  }, 45_000);

  // The op is routed and its reqId echoed on the error path — the client
  // matches its pending promise on that id, so a dropped reqId hangs the UI.
  test('retry on a healthy thread answers the reqId with not-ready', async () => {
    const localDir = tmp();
    writeFixtureAgent(localDir, '');
    const manager = makeManager(tmp(), localDir);
    await manager.init();
    const socket = attachFakeSocket(manager);

    socket.emit(
      JSON.stringify({ op: 'create', reqId: 'c1', agent: { source: 'custom', id: 'fixture' } }),
    );
    const created = await socket.awaitFrame('created');
    const threadId = created.info.threadId;
    await waitStatus(manager, threadId, 'ready');

    socket.emit(JSON.stringify({ op: 'retry', threadId, reqId: 'rt1' }));
    const err = await socket.awaitFrame('error');
    expect(err.code).toBe('not-ready');
    expect(err.reqId).toBe('rt1');
    socket.close();
  }, 45_000);

  test('authenticate on a healthy thread answers the reqId with not-ready', async () => {
    const localDir = tmp();
    writeFixtureAgent(localDir, '');
    const manager = makeManager(tmp(), localDir);
    await manager.init();
    const socket = attachFakeSocket(manager);

    socket.emit(
      JSON.stringify({ op: 'create', reqId: 'c1', agent: { source: 'custom', id: 'fixture' } }),
    );
    const created = await socket.awaitFrame('created');
    const threadId = created.info.threadId;
    await waitStatus(manager, threadId, 'ready');

    socket.emit(
      JSON.stringify({ op: 'authenticate', threadId, reqId: 'au1', methodId: 'test_login' }),
    );
    const err = await socket.awaitFrame('error');
    expect(err.code).toBe('not-ready');
    expect(err.reqId).toBe('au1');
    socket.close();
  }, 45_000);

  test('rename round-trips live and archived; a manual title survives first-prompt adoption', async () => {
    const localDir = tmp();
    writeFixtureAgent(localDir, '');
    const manager = makeManager(tmp(), localDir);
    await manager.init();
    const socket = attachFakeSocket(manager);

    socket.emit(
      JSON.stringify({ op: 'create', reqId: 'c1', agent: { source: 'custom', id: 'fixture' } }),
    );
    const created = await socket.awaitFrame('created');
    const threadId = created.info.threadId;
    await waitStatus(manager, threadId, 'ready');

    // Live rename → confirmed via an info frame carrying the new title.
    socket.emit(JSON.stringify({ op: 'rename', threadId, title: 'Roadmap rewrite' }));
    const deadline = Date.now() + 10_000;
    while (manager.getInfo(threadId)?.title !== 'Roadmap rewrite') {
      if (Date.now() > deadline) throw new Error('rename never applied');
      await new Promise((r) => setTimeout(r, 25));
    }
    const infoFrames = socket.frames.filter(
      (f): f is Extract<ThreadServerFrame, { op: 'info' }> => f.op === 'info',
    );
    expect(infoFrames.some((f) => f.info.title === 'Roadmap rewrite')).toBe(true);

    // First-prompt title adoption must NOT clobber the manual title.
    socket.emit(JSON.stringify({ op: 'prompt', threadId, reqId: 'p1', content: 'do the thing' }));
    await waitStatus(manager, threadId, 'ready');
    expect(manager.getInfo(threadId)?.title).toBe('Roadmap rewrite');

    // Renames apply to archived threads too (the history menu keeps them).
    socket.emit(JSON.stringify({ op: 'close', threadId }));
    await waitStatus(manager, threadId, 'exited');
    socket.emit(JSON.stringify({ op: 'rename', threadId, title: 'Archived and renamed' }));
    const deadline2 = Date.now() + 10_000;
    while (manager.getInfo(threadId)?.title !== 'Archived and renamed') {
      if (Date.now() > deadline2) throw new Error('archived rename never applied');
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(manager.getInfo(threadId)?.archived).toBe(true);

    // Unknown thread → error frame, no crash.
    socket.emit(JSON.stringify({ op: 'rename', threadId: 'nope', title: 'x' }));
    const err = await socket.awaitFrame('error');
    expect(err.code).toBe('unknown-thread');
    socket.close();
  }, 45_000);

  test('archived subscribe replays the transcript through the socket', async () => {
    const localDir = tmp();
    writeFixtureAgent(localDir, 'resume');
    const manager = makeManager(tmp(), localDir);
    await manager.init();
    const socket = attachFakeSocket(manager);

    socket.emit(
      JSON.stringify({
        op: 'create',
        reqId: 'c1',
        agent: { source: 'custom', id: 'fixture' },
        prompt: 'hello world',
      }),
    );
    const created = await socket.awaitFrame('created');
    const threadId = created.info.threadId;
    await waitStatus(manager, threadId, 'ready');
    socket.emit(JSON.stringify({ op: 'close', threadId }));
    await waitStatus(manager, threadId, 'exited');

    // A SECOND socket (fresh client) subscribes to the archived thread.
    const viewer = attachFakeSocket(manager);
    viewer.emit(JSON.stringify({ op: 'subscribe', threadId, sinceSeq: 0 }));
    await viewer.awaitFrame('subscribed');
    const events = await viewer.awaitFrame('events');
    expect(events.fromSeq).toBe(0);
    const deadline = Date.now() + 10_000;
    for (;;) {
      const all = viewer.frames
        .filter((f): f is Extract<ThreadServerFrame, { op: 'events' }> => f.op === 'events')
        .flatMap((f) => f.events);
      if (all.some((e) => e.kind === 'user_message' && e.content === 'hello world')) break;
      if (Date.now() > deadline) throw new Error('replay never delivered the user message');
      await new Promise((r) => setTimeout(r, 25));
    }
    socket.close();
    viewer.close();
  }, 45_000);
});

describe('/collab/thread socket — steer', () => {
  test('steer routes to the manager; unknown thread and empty content fail distinctly', async () => {
    const localDir = tmp();
    writeFixtureAgent(localDir, '');
    const manager = makeManager(tmp(), localDir);
    await manager.init();
    const socket = attachFakeSocket(manager);

    const errors = () =>
      socket.frames.filter(
        (f): f is Extract<ThreadServerFrame, { op: 'error' }> => f.op === 'error',
      );
    const awaitErrors = async (count: number): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while (errors().length < count) {
        if (Date.now() > deadline) throw new Error(`saw ${errors().length}/${count} errors`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    socket.emit(
      JSON.stringify({ op: 'create', reqId: 'c1', agent: { source: 'custom', id: 'fixture' } }),
    );
    const created = await socket.awaitFrame('created', 20_000);
    const threadId = created.info.threadId;
    await waitStatus(manager, threadId, 'ready');

    // Empty content fails structural parse and never reaches the manager.
    socket.emit(JSON.stringify({ op: 'steer', threadId, reqId: 's0', content: '' }));
    socket.emit(
      JSON.stringify({ op: 'steer', threadId: 'missing', reqId: 's1', content: 'go left' }),
    );
    await awaitErrors(2);
    expect(errors().map((f) => f.code)).toEqual(['bad-frame', 'unknown-thread']);
    expect(errors()[1]).toMatchObject({ reqId: 's1', threadId: 'missing' });

    // No turn is running, so the steer dispatches as an ordinary prompt.
    socket.emit(JSON.stringify({ op: 'steer', threadId, reqId: 's2', content: 'go left' }));
    const deadline = Date.now() + 10_000;
    for (;;) {
      const echoed = socket.frames.some(
        (f) =>
          f.op === 'events' &&
          f.events.some((e) => e.kind === 'user_message' && e.content === 'go left'),
      );
      if (echoed) break;
      if (Date.now() > deadline) throw new Error('steer never reached the transcript');
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(errors()).toHaveLength(2);

    socket.close();
  }, 45_000);
});

describe('/collab/thread socket — queue ops', () => {
  test('queue_edit / queue_remove route to the manager; unknown thread → error frame', async () => {
    const manager = makeManager(tmp(), tmp());
    await manager.init();
    const socket = attachFakeSocket(manager);

    const errors = () =>
      socket.frames.filter((f): f is Extract<ThreadServerFrame, { op: 'error' }> => {
        return f.op === 'error';
      });
    const awaitErrors = async (count: number): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while (errors().length < count) {
        if (Date.now() > deadline) {
          throw new Error(`saw ${errors().length}/${count} errors`);
        }
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    socket.emit(
      JSON.stringify({ op: 'queue_edit', threadId: 'missing', id: 'q1', content: 'new text' }),
    );
    socket.emit(JSON.stringify({ op: 'queue_remove', threadId: 'missing', id: 'q1' }));
    // Empty content fails structural parse and never reaches the manager.
    socket.emit(JSON.stringify({ op: 'queue_edit', threadId: 'missing', id: 'q1', content: '' }));
    await awaitErrors(3);

    expect(errors().map((f) => f.code)).toEqual(['unknown-thread', 'unknown-thread', 'bad-frame']);
    expect(errors()[0]?.threadId).toBe('missing');
  });

  test('a queue_edit that lost its race answers the reqId; without one it stays silent', async () => {
    const localDir = tmp();
    writeFixtureAgent(localDir, '');
    const manager = makeManager(tmp(), localDir);
    await manager.init();
    const socket = attachFakeSocket(manager);

    socket.emit(
      JSON.stringify({ op: 'create', reqId: 'c1', agent: { source: 'custom', id: 'fixture' } }),
    );
    const created = await socket.awaitFrame('created', 20_000);
    const threadId = created.info.threadId;
    const errors = () =>
      socket.frames.filter(
        (f): f is Extract<ThreadServerFrame, { op: 'error' }> => f.op === 'error',
      );

    // Nothing is queued on this thread, so every id is already-dispatched.
    socket.emit(
      JSON.stringify({ op: 'queue_edit', threadId, id: 'gone', content: 'my correction' }),
    );
    socket.emit(JSON.stringify({ op: 'queue_hold', threadId, id: 'gone', held: true }));
    socket.emit(
      JSON.stringify({
        op: 'queue_edit',
        threadId,
        id: 'gone',
        content: 'my correction',
        reqId: 'qe-1',
      }),
    );

    const deadline = Date.now() + 10_000;
    while (errors().length === 0) {
      if (Date.now() > deadline) throw new Error('no error frame for the reqId-carrying edit');
      await new Promise((r) => setTimeout(r, 10));
    }
    // Exactly one: the reqId-less edit and the hold are fire-and-forget.
    expect(errors()).toHaveLength(1);
    expect(errors()[0]).toMatchObject({
      code: 'not-ready',
      reqId: 'qe-1',
      threadId,
      message: 'queued message already dispatched',
    });

    socket.close();
  }, 45_000);

  test('a queue_edit that applies answers its reqId with a queue_edited ack', async () => {
    const localDir = tmp();
    const releasePath = join(localDir, 'release-turn');
    writeFixtureAgent(localDir, 'gate-prompt', { FAKE_RELEASE: releasePath });
    const manager = makeManager(tmp(), localDir);
    await manager.init();
    const socket = attachFakeSocket(manager);

    socket.emit(
      JSON.stringify({ op: 'create', reqId: 'c1', agent: { source: 'custom', id: 'fixture' } }),
    );
    const created = await socket.awaitFrame('created', 20_000);
    const threadId = created.info.threadId;
    const status = () => manager.getInfo(threadId)?.status;
    let deadline = Date.now() + 15_000;
    while (status() !== 'ready') {
      if (Date.now() > deadline) throw new Error(`never ready (status ${status()})`);
      await new Promise((r) => setTimeout(r, 25));
    }

    // First prompt parks on the gate; the second queues behind it.
    socket.emit(JSON.stringify({ op: 'prompt', threadId, reqId: 'p1', content: 'hold the turn' }));
    deadline = Date.now() + 10_000;
    while (status() !== 'running') {
      if (Date.now() > deadline) throw new Error('turn never opened');
      await new Promise((r) => setTimeout(r, 10));
    }
    socket.emit(JSON.stringify({ op: 'prompt', threadId, reqId: 'p2', content: 'queued text' }));
    deadline = Date.now() + 10_000;
    while ((manager.getInfo(threadId)?.queue ?? []).length === 0) {
      if (Date.now() > deadline) throw new Error('prompt never queued');
      await new Promise((r) => setTimeout(r, 10));
    }
    const queued = manager.getInfo(threadId)?.queue?.[0];
    if (queued === undefined) throw new Error('queue entry missing');

    socket.emit(
      JSON.stringify({
        op: 'queue_edit',
        threadId,
        id: queued.id,
        content: 'edited text',
        reqId: 'qe-ok',
      }),
    );
    const ack = await socket.awaitFrame('queue_edited', 10_000);
    expect(ack).toMatchObject({ op: 'queue_edited', reqId: 'qe-ok', threadId });
    expect(manager.getInfo(threadId)?.queue?.[0]?.content).toBe('edited text');

    writeFileSync(releasePath, 'go');
    socket.close();
  }, 45_000);
});

describe('/collab/thread socket — crash-recovered replay bound', () => {
  /**
   * A crash leaves the meta behind the log: meta rewrites ride info changes,
   * not each appended event, so `lastSeq` on disk can name an event far short
   * of the log's real end. Both files are written by hand because that skew is
   * only reachable by killing a server mid-stream.
   */
  function writeCrashStaleThread(
    localDir: string,
    threadId: string,
    events: readonly ThreadEvent[],
    staleLastSeq: number,
  ): void {
    const threadsDir = join(localDir, 'threads');
    mkdirSync(threadsDir, { recursive: true });
    writeFileSync(
      join(threadsDir, `${threadId}.ndjson`),
      `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    );
    writeFileSync(
      join(threadsDir, `${threadId}.meta.json`),
      JSON.stringify({
        version: 1,
        info: {
          threadId,
          agent: { id: 'codex-acp', name: 'Codex', source: 'registry' },
          title: 'Crashed thread',
          status: 'running',
          createdAt: 1,
          lastActivityAt: 2,
          modes: null,
          configOptions: null,
          lastSeq: staleLastSeq,
        },
        sessionId: 'sess-fixed',
        cwd: localDir,
        agentRef: { source: 'registry', id: 'codex-acp' },
      }),
    );
  }

  /** Longer than one replay chunk, so the log walks back in more than one frame. */
  const MULTI_CHUNK_EVENTS: ThreadEvent[] = Array.from({ length: 600 }, (_, i) => ({
    kind: 'user_message',
    content: `m${i}`,
    ts: i + 1,
  }));

  test('subscribed announces the durable log end, ahead of every replayed event', async () => {
    const localDir = tmp();
    const threadId = 'crash-stale';
    writeCrashStaleThread(localDir, threadId, MULTI_CHUNK_EVENTS, 2);
    const manager = makeManager(tmp(), localDir);
    await manager.init();
    // The rehydrated record still believes the stale meta until the log is read.
    expect(manager.getInfo(threadId)?.lastSeq).toBe(2);

    const socket = attachFakeSocket(manager);
    socket.emit(JSON.stringify({ op: 'subscribe', threadId, sinceSeq: 0 }));
    const subscribed = await socket.awaitFrame('subscribed');

    // The announced bound covers the whole log, so a client that waits for
    // delivery to reach it cannot mistake a later replay chunk for live traffic.
    expect(subscribed.info.lastSeq).toBe(MULTI_CHUNK_EVENTS.length - 1);
    const ops = socket.frames.map((f) => f.op);
    expect(ops.indexOf('subscribed')).toBeLessThan(ops.indexOf('events'));

    const deadline = Date.now() + 10_000;
    for (;;) {
      const replayed = socket.frames.filter(
        (f): f is Extract<ThreadServerFrame, { op: 'events' }> => f.op === 'events',
      );
      const delivered = replayed.reduce((n, f) => n + f.events.length, 0);
      if (delivered === MULTI_CHUNK_EVENTS.length) {
        // More than one frame is the point: a single-chunk replay could not
        // separate an accurate bound from a stale one.
        expect(replayed.length).toBeGreaterThan(1);
        expect(replayed[0].fromSeq).toBe(0);
        break;
      }
      if (Date.now() > deadline) throw new Error(`replay stalled at ${delivered} events`);
      await new Promise((r) => setTimeout(r, 25));
    }
    socket.close();
  }, 45_000);

  test('a failed log resolution is retried rather than cached for the process', async () => {
    const localDir = tmp();
    const threadId = 'unreadable-log';
    const events: ThreadEvent[] = [{ kind: 'user_message', content: 'hello', ts: 1 }];
    writeCrashStaleThread(localDir, threadId, events, 0);
    // A directory where the log belongs: it exists, so resolution reaches it,
    // and reading it throws the way an EACCES/EIO log would.
    const logPath = join(localDir, 'threads', `${threadId}.ndjson`);
    rmSync(logPath);
    mkdirSync(logPath);

    const manager = makeManager(tmp(), localDir);
    await manager.init();

    const failing = attachFakeSocket(manager);
    failing.emit(JSON.stringify({ op: 'subscribe', threadId, sinceSeq: 0 }));
    await failing.awaitFrame('error');
    expect(failing.frames.map((f) => f.op)).not.toContain('subscribed');
    failing.close();

    // Whatever made the log unreadable is gone. The next subscribe has to read
    // it again: a memoized rejection would answer every later subscribe and
    // resume for the life of the process, and since `subscribed` is emitted
    // behind that resolution the thread would stay dark rather than merely
    // lose its transcript.
    rmSync(logPath, { recursive: true });
    writeFileSync(logPath, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

    const retry = attachFakeSocket(manager);
    retry.emit(JSON.stringify({ op: 'subscribe', threadId, sinceSeq: 0 }));
    const subscribed = await retry.awaitFrame('subscribed');
    expect(subscribed.info.lastSeq).toBe(events.length - 1);
    retry.close();
  }, 45_000);

  test('subscribing to a thread that does not exist errors without announcing a window', async () => {
    const manager = makeManager(tmp(), tmp());
    await manager.init();
    const socket = attachFakeSocket(manager);

    socket.emit(JSON.stringify({ op: 'subscribe', threadId: 'nope', sinceSeq: 0 }));
    const err = await socket.awaitFrame('error');

    expect(err.code).toBe('unknown-thread');
    expect(socket.frames.map((f) => f.op)).not.toContain('subscribed');
    socket.close();
  }, 45_000);
});
