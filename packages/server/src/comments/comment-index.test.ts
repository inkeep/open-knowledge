import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { getLogger } from '../logger.ts';
import { createAnchor } from './anchor.ts';
import { CommentIndex } from './comment-index.ts';
import { CommentThreadStore } from './thread-store.ts';
import type { CommentThreadMeta } from './types.ts';

const log = getLogger('comments-index-test');

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'comments-index-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const BODY = 'one two three four five';
const anchor = (q: string) => {
  const s = BODY.indexOf(q);
  return createAnchor(BODY, s, s + q.length);
};

/** A whole thread, since the index caches threads rather than doc pointers. */
function thread(threadId: string, docName: string, quote = 'one'): CommentThreadMeta {
  return {
    threadId,
    docName,
    anchor: anchor(quote),
    state: 'anchored',
    queued: false,
    latestComment: `note on ${threadId}`,
    createdBy: 'principal-x',
    createdAt: 1,
  };
}

describe('CommentIndex', () => {
  test('builds from disk at boot', async () => {
    const store = new CommentThreadStore(tmp(), log);
    await store.init();
    for (const [id, doc, quote] of [
      ['t1', 'a', 'one'],
      ['t2', 'a', 'two'],
      ['t3', 'b', 'three'],
    ] as const) {
      await store.createThread({
        threadId: id,
        docName: doc,
        anchor: anchor(quote),
        createdBy: 'principal-x',
        createdAt: 1,
        body: 'a note',
      });
      await store.whenIdle(id);
    }

    const index = new CommentIndex();
    await index.build(store);

    expect(index.size).toBe(3);
    expect(index.threadsForDoc('a').sort()).toEqual(['t1', 't2']);
    expect(index.threadsForDoc('b')).toEqual(['t3']);
    expect(index.threadsForDoc('missing')).toEqual([]);
    // The whole thread is cached, not just its doc — that's what lets listing
    // serve reads without going back to disk.
    expect(index.listForDoc('b')[0].latestComment).toBe('a note');
  });

  test('listAll returns every cached thread', () => {
    const index = new CommentIndex();
    index.upsert(thread('t1', 'a'));
    index.upsert(thread('t2', 'b'));
    expect(
      index
        .listAll()
        .map((m) => m.threadId)
        .sort(),
    ).toEqual(['t1', 't2']);
  });

  test('upsert replaces the cached thread, not just its doc', () => {
    // The index is read INSTEAD of the file, so an upsert that kept a stale
    // copy would serve the pre-mutation state forever.
    const index = new CommentIndex();
    index.upsert(thread('t1', 'a'));
    index.upsert({ ...thread('t1', 'a'), state: 'resolved', latestComment: 'revised' });

    const [meta] = index.listForDoc('a');
    expect(meta.state).toBe('resolved');
    expect(meta.latestComment).toBe('revised');
  });

  test('upsert moves a thread to a new doc', () => {
    const index = new CommentIndex();
    index.upsert(thread('t1', 'a'));
    index.upsert(thread('t1', 'b'));
    expect(index.listForDoc('a')).toEqual([]);
    expect(index.threadsForDoc('b')).toEqual(['t1']);
  });

  test('remove drops a thread and prunes an empty doc key', () => {
    const index = new CommentIndex();
    index.upsert(thread('t1', 'a'));
    index.remove('t1');
    expect(index.threadsForDoc('a')).toEqual([]);
    expect(index.listAll()).toEqual([]);
    expect(index.size).toBe(0);
  });

  test('renameDoc re-points every thread and rewrites its cached docName', () => {
    // Both halves matter: the lookup key AND the cached copy. Leaving the copy
    // behind would serve the old docName to the app after a rename.
    const index = new CommentIndex();
    index.upsert(thread('t1', 'old'));
    index.upsert(thread('t2', 'old'));
    index.renameDoc('old', 'new');

    expect(index.threadsForDoc('old')).toEqual([]);
    expect(index.threadsForDoc('new').sort()).toEqual(['t1', 't2']);
    expect(index.listAll().every((m) => m.docName === 'new')).toBe(true);
  });

  test('renameDoc merges into an existing destination doc', () => {
    const index = new CommentIndex();
    index.upsert(thread('t1', 'old'));
    index.upsert(thread('t2', 'new'));
    index.renameDoc('old', 'new');
    expect(index.threadsForDoc('new').sort()).toEqual(['t1', 't2']);
  });
});

/**
 * Counting is the read-side surface: it feeds the comment signal MCP `exec`
 * folds into every file and folder it reports, so what it counts decides what
 * an agent believes about a doc it is about to edit.
 */
describe('CommentIndex counting', () => {
  test('counts every requested doc, zero included', () => {
    // A requested doc with no threads must come back as 0 rather than absent —
    // the caller has to tell "clean" from "not asked about".
    const index = new CommentIndex();
    index.upsert(thread('t1', 'a'));
    index.upsert(thread('t2', 'a'));

    expect([...index.countsForDocs(['a', 'b'])]).toEqual([
      ['a', 2],
      ['b', 0],
    ]);
  });

  test('resolved threads do not count', () => {
    // Settled work must not leave a doc looking permanently outstanding to
    // every agent that reads it.
    const index = new CommentIndex();
    index.upsert(thread('t1', 'a'));
    index.upsert({ ...thread('t2', 'a'), state: 'resolved' });

    expect(index.countForDoc('a')).toBe(1);
    expect(index.countsForDocs(['a']).get('a')).toBe(1);
  });

  test('orphaned threads still count', () => {
    // The passage moved, but the request stands — an orphan is exactly the case
    // a reader most needs to know about before editing.
    const index = new CommentIndex();
    index.upsert({ ...thread('t1', 'a'), state: 'orphaned' });
    expect(index.countForDoc('a')).toBe(1);
  });

  test('prefix rollup is sparse and segment-bounded', () => {
    // `docs` must not swallow `docsite/*`: the rollup annotates a FOLDER, and a
    // sibling folder sharing a name prefix is a different folder.
    const index = new CommentIndex();
    index.upsert(thread('t1', 'docs/a'));
    index.upsert(thread('t2', 'docs/nested/b'));
    index.upsert(thread('t3', 'docsite/c'));
    index.upsert({ ...thread('t4', 'docs/resolved-only'), state: 'resolved' });

    const counts = index.countsUnderPrefix('docs');
    expect([...counts].sort()).toEqual([
      ['docs/a', 1],
      ['docs/nested/b', 1],
    ]);
    // Sparse: a doc whose only thread is resolved is absent, not 0 — the folder
    // line is drawn from the presence of entries.
    expect(counts.has('docs/resolved-only')).toBe(false);
    expect(counts.has('docsite/c')).toBe(false);
  });

  test('a trailing slash on the prefix means the same folder', () => {
    const index = new CommentIndex();
    index.upsert(thread('t1', 'docs/a'));
    expect([...index.countsUnderPrefix('docs/')]).toEqual([['docs/a', 1]]);
  });

  test('an empty prefix rolls up the whole project', () => {
    const index = new CommentIndex();
    index.upsert(thread('t1', 'docs/a'));
    index.upsert(thread('t2', 'top'));
    expect([...index.countsUnderPrefix('')].sort()).toEqual([
      ['docs/a', 1],
      ['top', 1],
    ]);
  });
});
