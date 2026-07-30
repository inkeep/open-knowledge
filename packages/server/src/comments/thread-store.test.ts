import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { getLogger } from '../logger.ts';
import { createAnchor } from './anchor.ts';
import { CommentThreadStore } from './thread-store.ts';
import { CommentThreadMetaSchema } from './types.ts';

const log = getLogger('comments-store-test');

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'comments-store-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function makeStore(): Promise<CommentThreadStore> {
  const store = new CommentThreadStore(tmp(), log);
  await store.init();
  return store;
}

const BODY = 'The rollout is scheduled for Q3. We expect minimal downtime.';
function anchorFor(quote: string) {
  const start = BODY.indexOf(quote);
  return createAnchor(BODY, start, start + quote.length);
}

async function newThread(store: CommentThreadStore, id = 'thread-1') {
  return store.createThread({
    threadId: id,
    docName: 'notes/rollout',
    anchor: anchorFor('minimal downtime'),
    createdBy: 'principal-abc',
    createdAt: 1000,
    body: 'is this still true?',
  });
}

describe('CommentThreadStore', () => {
  test('creates a thread carrying its comment, open and unqueued', async () => {
    const store = await makeStore();
    const meta = await newThread(store);
    await store.whenIdle('thread-1');

    expect(() => CommentThreadMetaSchema.parse(meta)).not.toThrow();
    expect(meta.state).toBe('anchored');
    expect(meta.queued).toBe(false);
    expect(meta.docName).toBe('notes/rollout');
    expect(meta.latestComment).toBe('is this still true?');
  });

  test('update patches only the named fields and persists the result', async () => {
    const store = await makeStore();
    const created = await newThread(store);

    const updated = await store.update('thread-1', { queued: true, state: 'orphaned' });
    await store.whenIdle('thread-1');

    expect(updated?.queued).toBe(true);
    expect(updated?.state).toBe('orphaned');
    // Untouched fields survive the patch.
    expect(updated?.latestComment).toBe(created.latestComment);
    expect(updated?.anchor).toEqual(created.anchor);
    expect(await store.readMeta('thread-1')).toEqual(updated);
  });

  test('identity fields are not patchable', async () => {
    // `threadId`, `createdBy` and `createdAt` are the thread's provenance and
    // exist nowhere else — a patch type that admitted them would let a caller
    // quietly rewrite who wrote a comment.
    const store = await makeStore();
    await newThread(store);
    // @ts-expect-error createdBy is deliberately outside CommentThreadPatch
    const updated = await store.update('thread-1', { createdBy: 'principal-someone-else' });
    expect(updated?.createdBy).toBe('principal-abc');
  });

  test('update on a missing thread returns null rather than creating one', async () => {
    const store = await makeStore();
    expect(await store.update('never-existed', { queued: true })).toBeNull();
    expect(await store.readMeta('never-existed')).toBeNull();
  });

  test('concurrent updates to different fields do not lose each other', async () => {
    // Each update is a read-modify-write. Without the per-thread queue both
    // would read the same starting thread and the second would clobber the
    // first's field — the classic lost update.
    const store = await makeStore();
    await newThread(store);

    await Promise.all([
      store.update('thread-1', { queued: true }),
      store.update('thread-1', { latestComment: 'reworded' }),
      store.update('thread-1', { state: 'orphaned' }),
    ]);
    await store.whenIdle('thread-1');

    const meta = await store.readMeta('thread-1');
    expect(meta?.queued).toBe(true);
    expect(meta?.latestComment).toBe('reworded');
    expect(meta?.state).toBe('orphaned');
  });

  test('a thread on disk always parses — there is no partial state to read', async () => {
    // The write is atomic (tmp + rename), so a reader never sees a blend of the
    // old thread and the new one. This asserts the observable consequence.
    const store = await makeStore();
    await newThread(store);
    for (const patch of [{ queued: true }, { state: 'resolved' as const }, { queued: false }]) {
      await store.update('thread-1', patch);
      const raw = readFileSync(store.metaPath('thread-1'), 'utf8');
      expect(() => CommentThreadMetaSchema.parse(JSON.parse(raw))).not.toThrow();
    }
  });

  test('an unreadable thread file is skipped, not crashed on', async () => {
    const store = await makeStore();
    await newThread(store, 'thread-1');
    await newThread(store, 'thread-2');
    await store.whenIdle('thread-1');
    await store.whenIdle('thread-2');

    writeFileSync(store.metaPath('broken'), 'not json');

    expect((await store.scanCoverSheets()).map((m) => m.threadId).sort()).toEqual([
      'thread-1',
      'thread-2',
    ]);
    expect(await store.readMeta('broken')).toBeNull();
  });

  test('a thread whose shape no longer validates is skipped', async () => {
    const store = await makeStore();
    await newThread(store);
    writeFileSync(store.metaPath('thread-1'), JSON.stringify({ threadId: 'thread-1' }));
    expect(await store.readMeta('thread-1')).toBeNull();
  });

  test('delete removes the thread', async () => {
    const store = await makeStore();
    await newThread(store);
    await store.whenIdle('thread-1');
    await store.delete('thread-1');
    expect(await store.readMeta('thread-1')).toBeNull();
    expect(await store.scanCoverSheets()).toEqual([]);
  });

  test('is written as pretty JSON that parses back', async () => {
    const store = await makeStore();
    await newThread(store);
    await store.whenIdle('thread-1');
    const raw = readFileSync(store.metaPath('thread-1'), 'utf8');
    expect(raw).toContain('\n');
    expect(() => CommentThreadMetaSchema.parse(JSON.parse(raw))).not.toThrow();
  });
});
