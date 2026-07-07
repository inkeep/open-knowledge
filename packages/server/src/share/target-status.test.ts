/**
 * Target-status verdicts verified against the real-git S1 fixture — one
 * case per verdict, no mocks. The receiver clones BEFORE the sender's mutation
 * in the move/delete cases, so the fetch inside `computeShareTargetStatus` is
 * what reveals the change (a stale local ref would otherwise misclassify it).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createGitTriangle, type GitTriangle } from './git-fixture.test-helper.ts';
import { computeShareTargetStatus } from './target-status.ts';

const triangles: GitTriangle[] = [];

function newTriangle(): GitTriangle {
  const t = createGitTriangle();
  triangles.push(t);
  return t;
}

afterEach(() => {
  for (const t of triangles.splice(0)) t.cleanup();
});

describe('computeShareTargetStatus', () => {
  test('stale-local: a recently-pushed doc the receiver has not fetched is on-origin', async () => {
    const t = newTriangle();
    t.seedAndPush('doc1.md', 'one\n');
    const receiver = t.cloneReceiver();
    // Sender pushes a second doc AFTER the clone; the receiver's origin ref is
    // now stale and does not know about it — until the fetch.
    t.seedAndPush('doc2.md', 'two\n');
    const status = await computeShareTargetStatus(receiver, t.branch, 'doc2.md', 'doc');
    expect(status.verdict).toBe('on-origin');
  });

  test('renamed doc: the fetch reveals the move; verdict renamed with the new path', async () => {
    const t = newTriangle();
    t.seedAndPush('old.md', '# stable content that survives the move intact\n');
    const receiver = t.cloneReceiver();
    t.renameOnOrigin('old.md', 'new.md');
    const status = await computeShareTargetStatus(receiver, t.branch, 'old.md', 'doc');
    expect(status.verdict).toBe('renamed');
    if (status.verdict === 'renamed') expect(status.renamedTo).toBe('new.md');
  });

  test('renamed via a merge commit: read through the first parent, not misparsed as deleted', async () => {
    const t = newTriangle();
    t.seedAndPush('old.md', '# stable content that survives the move intact\n');
    const receiver = t.cloneReceiver();
    // The removal lands in a merge commit, whose bare diff-tree is combined
    // format — a first-parent diff is what keeps the rename row readable.
    t.mergeRenameOnOrigin('old.md', 'new.md');
    const status = await computeShareTargetStatus(receiver, t.branch, 'old.md', 'doc');
    expect(status.verdict).toBe('renamed');
    if (status.verdict === 'renamed') expect(status.renamedTo).toBe('new.md');
  });

  test('renamed folder: per-file rename rows map to the new folder by common prefix', async () => {
    const t = newTriangle();
    t.seedAndPush('docs/a.md', 'alpha content long enough to match on similarity\n');
    t.seedAndPush('docs/b.md', 'beta content long enough to match on similarity\n');
    const receiver = t.cloneReceiver();
    t.renameFolderOnOrigin('docs', 'knowledge');
    const status = await computeShareTargetStatus(receiver, t.branch, 'docs', 'folder');
    expect(status.verdict).toBe('renamed');
    if (status.verdict === 'renamed') expect(status.renamedTo).toBe('knowledge');
  });

  test('deleted doc: a removal commit with a delete row is deleted', async () => {
    const t = newTriangle();
    t.seedAndPush('gone.md', '# will be removed with no successor\n');
    const receiver = t.cloneReceiver();
    t.deleteOnOrigin('gone.md');
    const status = await computeShareTargetStatus(receiver, t.branch, 'gone.md', 'doc');
    expect(status.verdict).toBe('deleted');
  });

  test('never-on-branch: a path that never existed is distinct from deleted', async () => {
    const t = newTriangle();
    const receiver = t.cloneReceiver();
    const status = await computeShareTargetStatus(receiver, t.branch, 'never.md', 'doc');
    expect(status.verdict).toBe('never-on-branch');
  });

  test('offline: a failed fetch degrades to unknown', async () => {
    const t = newTriangle();
    t.seedAndPush('doc.md', 'one\n');
    const receiver = t.cloneReceiver();
    // No reachable origin — the fetch fails fast.
    t.git(receiver, ['remote', 'remove', 'origin']);
    const status = await computeShareTargetStatus(receiver, t.branch, 'doc.md', 'doc', {
      fetchTimeoutMs: 5000,
    });
    expect(status.verdict).toBe('unknown');
  });

  test('fresh-clone leg (skipFetch): reads the clone ref without fetching', async () => {
    const t = newTriangle();
    t.seedAndPush('doc.md', 'one\n');
    const receiver = t.cloneReceiver();
    const status = await computeShareTargetStatus(receiver, t.branch, 'doc.md', 'doc', {
      skipFetch: true,
    });
    expect(status.verdict).toBe('on-origin');
  });

  test('chained rename whose destination is gone degrades to deleted (no dead redirect)', async () => {
    const t = newTriangle();
    t.seedAndPush('a.md', '# content that moves more than once before it settles\n');
    const receiver = t.cloneReceiver();
    t.renameOnOrigin('a.md', 'b.md');
    t.renameOnOrigin('b.md', 'c.md');
    const status = await computeShareTargetStatus(receiver, t.branch, 'a.md', 'doc');
    // a.md's removal commit renamed it to b.md, but b.md no longer resolves at
    // origin (it became c.md), so the redirect is refused in favor of deleted.
    expect(status.verdict).toBe('deleted');
  });

  test('fresh-clone leg (skipFetch): a target deleted before the clone is deleted, no fetch', async () => {
    const t = newTriangle();
    t.seedAndPush('gone.md', 'bye\n');
    t.deleteOnOrigin('gone.md');
    // Clone AFTER the delete: the clone's own history carries the removal, so
    // the verdict is reachable from local refs with no fetch.
    const receiver = t.cloneReceiver();
    const status = await computeShareTargetStatus(receiver, t.branch, 'gone.md', 'doc', {
      skipFetch: true,
    });
    expect(status.verdict).toBe('deleted');
  });

  test('split-folder rename (files scatter to different prefixes) degrades to deleted, not a garbage redirect', async () => {
    const t = newTriangle();
    t.seedAndPush('docs/a.md', 'a\n');
    t.seedAndPush('docs/b.md', 'b\n');
    const receiver = t.cloneReceiver();
    // One commit moves docs/ files to two DIFFERENT prefixes — no single new
    // folder, so the common-prefix inference is ambiguous and must not redirect.
    t.splitRenameOnOrigin([
      ['docs/a.md', 'x/a.md'],
      ['docs/b.md', 'y/b.md'],
    ]);
    const status = await computeShareTargetStatus(receiver, t.branch, 'docs', 'folder');
    expect(status.verdict).toBe('deleted');
  });

  test('local uncommitted delete: still on origin + in HEAD but gone from the working tree is changed-locally', async () => {
    const t = newTriangle();
    t.seedAndPush('local-del.md', '# committed, then deleted locally without syncing\n');
    const receiver = t.cloneReceiver();
    // The receiver removes their own copy WITHOUT committing/pushing: the path
    // is still on origin and in their HEAD, but absent from the working tree.
    // "Pull" would be wrong guidance — they are not behind.
    t.deleteInReceiverWorkingTree('local-del.md');
    const status = await computeShareTargetStatus(receiver, t.branch, 'local-del.md', 'doc');
    expect(status.verdict).toBe('changed-locally');
  });

  test('local uncommitted rename: the old path gone from the working tree but still in HEAD is changed-locally', async () => {
    const t = newTriangle();
    t.seedAndPush('local-mv.md', '# committed, then renamed locally without syncing\n');
    const receiver = t.cloneReceiver();
    // A local rename looks identical to a local delete from the OLD path's
    // vantage: present in HEAD, gone from the working tree.
    t.renameInReceiverWorkingTree('local-mv.md', 'renamed-local.md');
    const status = await computeShareTargetStatus(receiver, t.branch, 'local-mv.md', 'doc');
    expect(status.verdict).toBe('changed-locally');
  });
});
