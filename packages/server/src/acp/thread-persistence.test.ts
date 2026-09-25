import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ThreadEvent, ThreadInfo } from '@inkeep/open-knowledge-core/acp/thread-protocol';
import { afterEach, describe, expect, test } from 'vitest';
import { getLogger } from '../logger.ts';
import { type PersistedThreadMeta, ThreadPersistenceStore } from './thread-persistence.ts';

const log = getLogger('acp-persist-test');

const T1 = '0a1b2c3d-0000-4000-8000-000000000001';
const MINE = '0a1b2c3d-0000-4000-8000-000000000002';
const OTHER = '0a1b2c3d-0000-4000-8000-000000000003';
const LEGACY = '0a1b2c3d-0000-4000-8000-000000000004';
const TL = '0a1b2c3d-0000-4000-8000-000000000005';
const TN = '0a1b2c3d-0000-4000-8000-000000000006';
const TD = '0a1b2c3d-0000-4000-8000-000000000007';
const NEVER = '0a1b2c3d-0000-4000-8000-000000000008';
const NOSESSION = '0a1b2c3d-0000-4000-8000-000000000009';
const NUMERIC = '0a1b2c3d-0000-4000-8000-00000000000a';
const NOCWD = '0a1b2c3d-0000-4000-8000-00000000000b';
const NOAGENT = '0a1b2c3d-0000-4000-8000-00000000000c';

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
  const store = new ThreadPersistenceStore({ primaryDir: tmp(), log });
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
    store.appendEvents(T1, [ev(0), ev(1)]);
    store.appendEvents(T1, [ev(2)]);
    await store.whenIdle(T1);
    const all = await readAll(store, T1, 0, 100);
    expect(all.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(all.map((e) => (e.event.kind === 'user_message' ? e.event.content : ''))).toEqual([
      'm0',
      'm1',
      'm2',
    ]);
    const window = await readAll(store, T1, 1, 2);
    expect(window).toHaveLength(1);
    expect(window[0]?.seq).toBe(1);
  });

  test('a torn final line (crash mid-append) is dropped, not surfaced', async () => {
    const store = await makeStore();
    store.appendEvents(T1, [ev(0), ev(1)]);
    await store.whenIdle(T1);
    appendFileSync(store.eventsPath(T1), '{"kind":"user_message","content":"tor');
    const resolved = await store.resolveEventLog(T1);
    expect(resolved.count).toBe(2);
    const all = await readAll(store, T1, 0, 100);
    expect(all).toHaveLength(2);
  });

  test('resolveEventLog reports a log that ends mid-turn', async () => {
    const store = await makeStore();
    store.appendEvents(T1, [
      ev(0),
      { kind: 'turn_started', ts: 1 },
      { kind: 'turn_ended', stopReason: 'end_turn', ts: 2 },
      { kind: 'turn_started', ts: 3 },
    ]);
    await store.whenIdle(T1);
    expect((await store.resolveEventLog(T1)).midTurn).toBe(true);
    store.appendEvents(T1, [{ kind: 'turn_ended', stopReason: 'cancelled', ts: 4 }]);
    await store.whenIdle(T1);
    expect((await store.resolveEventLog(T1)).midTurn).toBe(false);
    expect((await store.resolveEventLog('missing')).count).toBe(0);
  });

  test('meta round-trips through scan; junk and unknown versions are skipped', async () => {
    const store = await makeStore();
    store.queueMetaWrite(T1, meta(T1));
    await store.whenIdle(T1);
    writeFileSync(store.metaPath('junk'), 'not json');
    writeFileSync(store.metaPath('future'), JSON.stringify({ ...meta('future'), version: 99 }));
    const metas = await store.scan();
    expect(metas).toHaveLength(1);
    expect(metas[0]?.info.threadId).toBe(T1);
    expect(metas[0]?.sessionId).toBe('sess-1');
    expect(metas[0]?.cwd).toBe('/tmp/x');
  });

  test('a meta with no usable session id keeps its transcript and reads as unresumable', async () => {
    const store = await makeStore();
    store.queueMetaWrite(T1, meta(T1));
    await store.whenIdle(T1);
    const { sessionId: _sessionId, ...withoutSessionId } = meta(NOSESSION);
    writeFileSync(store.metaPath(NOSESSION), JSON.stringify(withoutSessionId));
    writeFileSync(store.metaPath(NUMERIC), JSON.stringify({ ...meta(NUMERIC), sessionId: 7 }));
    writeFileSync(store.metaPath(NEVER), JSON.stringify({ ...meta(NEVER), sessionId: null }));

    const metas = await store.scan();
    expect(metas.map((m) => m.info.threadId).sort()).toEqual(
      [NEVER, NOSESSION, NUMERIC, T1].sort(),
    );
    for (const threadId of [NEVER, NOSESSION, NUMERIC]) {
      expect(metas.find((m) => m.info.threadId === threadId)?.sessionId).toBeNull();
    }
    expect(metas.find((m) => m.info.threadId === T1)?.sessionId).toBe('sess-1');
  });

  test('a meta missing a field with no safe substitute is still skipped', async () => {
    const store = await makeStore();
    store.queueMetaWrite(T1, meta(T1));
    await store.whenIdle(T1);
    const { cwd: _cwd, ...withoutCwd } = meta(NOCWD);
    writeFileSync(store.metaPath(NOCWD), JSON.stringify(withoutCwd));
    const { agentRef: _agentRef, ...withoutAgent } = meta(NOAGENT);
    writeFileSync(store.metaPath(NOAGENT), JSON.stringify(withoutAgent));

    const metas = await store.scan();
    expect(metas.map((m) => m.info.threadId)).toEqual([T1]);
  });

  test('a meta whose id OpenKnowledge did not mint is skipped, so the id never becomes a path', async () => {
    const store = await makeStore();
    store.queueMetaWrite(T1, meta(T1));
    await store.whenIdle(T1);
    const dir = dirname(store.metaPath(T1));
    for (const [i, threadId] of ['../../..', '', '.', `${T1}/..`, 'thread-1'].entries()) {
      writeFileSync(join(dir, `planted-${i}.meta.json`), JSON.stringify(meta(threadId)));
    }
    writeFileSync(store.metaPath(MINE), JSON.stringify(meta(OTHER)));

    const metas = await store.scan();
    expect(metas.map((m) => m.info.threadId)).toEqual([T1]);
  });

  test('an unparseable middle line is substituted, preserving later seqs', async () => {
    const store = await makeStore();
    store.appendEvents(T1, [ev(0)]);
    await store.whenIdle(T1);
    appendFileSync(store.eventsPath(T1), 'garbage line\n');
    store.appendEvents(T1, [ev(2)]);
    await store.whenIdle(T1);
    const all = await readAll(store, T1, 0, 100);
    expect(all.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(all[1]?.event.kind).toBe('agent_stderr');
    expect(all[2]?.event.kind === 'user_message' && all[2].event.content).toBe('m2');
  });

  test('delete removes both files; scan and reads go empty', async () => {
    const store = await makeStore();
    store.appendEvents(T1, [ev(0)]);
    store.queueMetaWrite(T1, meta(T1));
    await store.whenIdle(T1);
    expect(readFileSync(store.eventsPath(T1), 'utf8')).toContain('m0');
    await store.delete(T1);
    expect(await store.scan()).toHaveLength(0);
    expect(await readAll(store, T1, 0, 100)).toHaveLength(0);
    expect((await store.resolveEventLog(T1)).count).toBe(0);
  });
});

const metaCwd = (threadId: string, cwd: string): PersistedThreadMeta => ({
  version: 1,
  info: info(threadId),
  sessionId: 'sess-1',
  cwd,
  agentRef: { source: 'custom', id: 'a' },
});

describe('ThreadPersistenceStore global dir + legacy fallback', () => {
  test('scan cwd-filters the shared global dir (by realpath) but never the legacy dir', async () => {
    const global = tmp();
    const legacy = tmp();
    const rawCwd = tmp();
    const canonCwd = realpathSync(rawCwd);
    const otherCwd = realpathSync(tmp());

    const globalWriter = new ThreadPersistenceStore({
      primaryDir: global,
      legacyDir: legacy,
      cwd: canonCwd,
      log,
    });
    await globalWriter.init();
    globalWriter.queueMetaWrite(MINE, metaCwd(MINE, rawCwd));
    globalWriter.queueMetaWrite(OTHER, metaCwd(OTHER, otherCwd));
    await globalWriter.whenIdle(MINE);
    await globalWriter.whenIdle(OTHER);

    const legacyWriter = new ThreadPersistenceStore({ primaryDir: legacy, log });
    await legacyWriter.init();
    legacyWriter.queueMetaWrite(LEGACY, metaCwd(LEGACY, otherCwd));
    await legacyWriter.whenIdle(LEGACY);

    const reader = new ThreadPersistenceStore({
      primaryDir: global,
      legacyDir: legacy,
      cwd: canonCwd,
      log,
    });
    const ids = (await reader.scan()).map((m) => m.info.threadId).sort();
    expect(ids).toEqual([LEGACY, MINE].sort());
  });

  test('a legacy-homed thread stays in legacy for append and delete (never split)', async () => {
    const global = tmp();
    const legacy = tmp();
    const cwd = realpathSync(tmp());

    const seed = new ThreadPersistenceStore({ primaryDir: legacy, log });
    await seed.init();
    seed.queueMetaWrite(TL, metaCwd(TL, cwd));
    seed.appendEvents(TL, [ev(0), ev(1)]);
    await seed.whenIdle(TL);

    const store = new ThreadPersistenceStore({
      primaryDir: global,
      legacyDir: legacy,
      cwd,
      log,
    });
    await store.init();
    expect((await store.scan()).map((m) => m.info.threadId)).toContain(TL);

    store.appendEvents(TL, [ev(2)]);
    await store.whenIdle(TL);
    expect(store.eventsPath(TL)).toContain(legacy);
    expect(existsSync(join(global, 'threads', `${TL}.ndjson`))).toBe(false);
    expect((await store.resolveEventLog(TL)).count).toBe(3);

    await store.delete(TL);
    expect(existsSync(join(legacy, 'threads', `${TL}.ndjson`))).toBe(false);
    expect((await store.resolveEventLog(TL)).count).toBe(0);
  });

  test('new threads write to the global primary dir', async () => {
    const global = tmp();
    const legacy = tmp();
    const cwd = realpathSync(tmp());
    const store = new ThreadPersistenceStore({ primaryDir: global, legacyDir: legacy, cwd, log });
    await store.init();
    store.queueMetaWrite(TN, metaCwd(TN, cwd));
    store.appendEvents(TN, [ev(0)]);
    await store.whenIdle(TN);
    expect(store.eventsPath(TN)).toContain(global);
    expect(existsSync(join(global, 'threads', `${TN}.ndjson`))).toBe(true);
  });

  test('an unwritable primary dir degrades to legacy without failing init', async () => {
    const fileAsDir = join(tmp(), 'not-a-dir');
    writeFileSync(fileAsDir, 'x');
    const legacy = tmp();
    const store = new ThreadPersistenceStore({
      primaryDir: fileAsDir,
      legacyDir: legacy,
      cwd: null,
      log,
    });
    await store.init();
    store.queueMetaWrite(TD, metaCwd(TD, '/x'));
    store.appendEvents(TD, [ev(0)]);
    await store.whenIdle(TD);
    expect(store.eventsPath(TD)).toContain(legacy);
    expect(existsSync(join(legacy, 'threads', `${TD}.ndjson`))).toBe(true);
  });
});
