/**
 * Frame-level coverage of the `/collab/thread` socket for the history ops:
 * `resume` (success → `resumed` frame; failure → error frame carrying the
 * reqId + `resume-unsupported`), `delete` (refused live / applied archived,
 * followed by a refreshed `threads` list), `rename` (live + archived, manual
 * title wins over first-prompt adoption), and archived `subscribe` replay
 * through the socket's async path.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ThreadServerFrame } from '@inkeep/open-knowledge-core/acp/thread-protocol';
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
function writeFixtureAgent(localDir: string, caps: string): void {
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
      reply({ stopReason: 'end_turn' });
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
        env: { FAKE_CAPS: caps },
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
    await waitStatus(manager, threadId, 'exited');

    socket.emit(JSON.stringify({ op: 'resume', threadId, reqId: 'r9' }));
    const err = await socket.awaitFrame('error');
    expect(err.code).toBe('resume-unsupported');
    expect(err.reqId).toBe('r9');
    expect(manager.getInfo(threadId)?.archived).toBe(true);
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
