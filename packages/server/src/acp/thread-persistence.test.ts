import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ThreadEvent, ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { afterEach, describe, expect, test } from 'vitest';
import { getLogger } from '../logger.ts';
import { type PersistedThreadMeta, ThreadPersistenceStore } from './thread-persistence.ts';

const log = getLogger('acp-persist-test');

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'acp-persist-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function makeStore(): Promise<ThreadPersistenceStore> {
  const store = new ThreadPersistenceStore(tmp(), log);
  await store.init();
  return store;
}

const info = (threadId: string): ThreadInfo => ({
  threadId,
  agent: { id: 'a', name: 'A', source: 'custom' },
  title: 'T',
  status: 'exited',
  createdAt: 1,
  lastActivityAt: 2,
  modes: null,
  configOptions: null,
  lastSeq: -1,
  archived: true,
});

const meta = (threadId: string): PersistedThreadMeta => ({
  version: 1,
  info: info(threadId),
  sessionId: 'sess-1',
  cwd: '/tmp/x',
  agentRef: { source: 'custom', id: 'a' },
});

const ev = (i: number): ThreadEvent => ({ kind: 'user_message', content: `m${i}`, ts: i });

async function readAll(
  store: ThreadPersistenceStore,
  threadId: string,
  from: number,
  to: number,
): Promise<Array<{ seq: number; event: ThreadEvent }>> {
  const out: Array<{ seq: number; event: ThreadEvent }> = [];
  await store.readEvents(threadId, from, to, (chunkFrom, events) => {
    for (const [i, event] of events.entries()) out.push({ seq: chunkFrom + i, event });
  });
  return out;
}

describe('ThreadPersistenceStore', () => {
  test('append → read round-trips with line index == seq', async () => {
    const store = await makeStore();
    store.appendEvents('t1', [ev(0), ev(1)]);
    store.appendEvents('t1', [ev(2)]);
    await store.whenIdle('t1');
    const all = await readAll(store, 't1', 0, 100);
    expect(all.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(all.map((e) => (e.event.kind === 'user_message' ? e.event.content : ''))).toEqual([
      'm0',
      'm1',
      'm2',
    ]);
    // Window reads slice by seq.
    const window = await readAll(store, 't1', 1, 2);
    expect(window).toHaveLength(1);
    expect(window[0]?.seq).toBe(1);
  });

  test('a torn final line (crash mid-append) is dropped, not surfaced', async () => {
    const store = await makeStore();
    store.appendEvents('t1', [ev(0), ev(1)]);
    await store.whenIdle('t1');
    appendFileSync(store.eventsPath('t1'), '{"kind":"user_message","content":"tor');
    const resolved = await store.resolveEventLog('t1');
    expect(resolved.count).toBe(2);
    const all = await readAll(store, 't1', 0, 100);
    expect(all).toHaveLength(2);
  });

  test('resolveEventLog reports a log that ends mid-turn', async () => {
    const store = await makeStore();
    store.appendEvents('t1', [
      ev(0),
      { kind: 'turn_started', ts: 1 },
      { kind: 'turn_ended', stopReason: 'end_turn', ts: 2 },
      { kind: 'turn_started', ts: 3 },
    ]);
    await store.whenIdle('t1');
    expect((await store.resolveEventLog('t1')).midTurn).toBe(true);
    store.appendEvents('t1', [{ kind: 'turn_ended', stopReason: 'cancelled', ts: 4 }]);
    await store.whenIdle('t1');
    expect((await store.resolveEventLog('t1')).midTurn).toBe(false);
    expect((await store.resolveEventLog('missing')).count).toBe(0);
  });

  test('meta round-trips through scan; junk and unknown versions are skipped', async () => {
    const store = await makeStore();
    store.queueMetaWrite('t1', meta('t1'));
    await store.whenIdle('t1');
    // Corrupt sibling + future-version sibling must not break the scan.
    writeFileSync(store.metaPath('junk'), 'not json');
    writeFileSync(store.metaPath('future'), JSON.stringify({ ...meta('future'), version: 99 }));
    const metas = await store.scan();
    expect(metas).toHaveLength(1);
    expect(metas[0]?.info.threadId).toBe('t1');
    expect(metas[0]?.sessionId).toBe('sess-1');
    expect(metas[0]?.cwd).toBe('/tmp/x');
  });

  test('an unparseable middle line is substituted, preserving later seqs', async () => {
    const store = await makeStore();
    store.appendEvents('t1', [ev(0)]);
    await store.whenIdle('t1');
    appendFileSync(store.eventsPath('t1'), 'garbage line\n');
    store.appendEvents('t1', [ev(2)]);
    await store.whenIdle('t1');
    const all = await readAll(store, 't1', 0, 100);
    expect(all.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(all[1]?.event.kind).toBe('agent_stderr');
    expect(all[2]?.event.kind === 'user_message' && all[2].event.content).toBe('m2');
  });

  test('delete removes both files; scan and reads go empty', async () => {
    const store = await makeStore();
    store.appendEvents('t1', [ev(0)]);
    store.queueMetaWrite('t1', meta('t1'));
    await store.whenIdle('t1');
    expect(readFileSync(store.eventsPath('t1'), 'utf8')).toContain('m0');
    await store.delete('t1');
    expect(await store.scan()).toHaveLength(0);
    expect(await readAll(store, 't1', 0, 100)).toHaveLength(0);
    expect((await store.resolveEventLog('t1')).count).toBe(0);
  });
});
