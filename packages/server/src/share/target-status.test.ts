import { afterEach, describe, expect, test } from 'vitest';
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
    t.seedAndPush('doc2.md', 'two\n');
    const status = await computeShareTargetStatus(receiver, t.branch, 'doc2.md', 'doc', {
      credentialConfig: [],
    });
    expect(status.verdict).toBe('on-origin');
  });

  test('renamed doc: the fetch reveals the move; verdict renamed with the new path', async () => {
    const t = newTriangle();
    t.seedAndPush('old.md', '# stable content that survives the move intact\n');
    const receiver = t.cloneReceiver();
    t.renameOnOrigin('old.md', 'new.md');
    const status = await computeShareTargetStatus(receiver, t.branch, 'old.md', 'doc', {
      credentialConfig: [],
    });
    expect(status.verdict).toBe('renamed');
    if (status.verdict === 'renamed') expect(status.renamedTo).toBe('new.md');
  });

  test('renamed via a merge commit: read through the first parent, not misparsed as deleted', async () => {
    const t = newTriangle();
    t.seedAndPush('old.md', '# stable content that survives the move intact\n');
    const receiver = t.cloneReceiver();
    t.mergeRenameOnOrigin('old.md', 'new.md');
    const status = await computeShareTargetStatus(receiver, t.branch, 'old.md', 'doc', {
      credentialConfig: [],
    });
    expect(status.verdict).toBe('renamed');
    if (status.verdict === 'renamed') expect(status.renamedTo).toBe('new.md');
  });

  test('renamed folder: per-file rename rows map to the new folder by common prefix', async () => {
    const t = newTriangle();
    t.seedAndPush('docs/a.md', 'alpha content long enough to match on similarity\n');
    t.seedAndPush('docs/b.md', 'beta content long enough to match on similarity\n');
    const receiver = t.cloneReceiver();
    t.renameFolderOnOrigin('docs', 'knowledge');
    const status = await computeShareTargetStatus(receiver, t.branch, 'docs', 'folder', {
      credentialConfig: [],
    });
    expect(status.verdict).toBe('renamed');
    if (status.verdict === 'renamed') expect(status.renamedTo).toBe('knowledge');
  });

  test('deleted doc: a removal commit with a delete row is deleted', async () => {
    const t = newTriangle();
    t.seedAndPush('gone.md', '# will be removed with no successor\n');
    const receiver = t.cloneReceiver();
    t.deleteOnOrigin('gone.md');
    const status = await computeShareTargetStatus(receiver, t.branch, 'gone.md', 'doc', {
      credentialConfig: [],
    });
    expect(status.verdict).toBe('deleted');
  });

  test('never-on-branch: a path that never existed is distinct from deleted', async () => {
    const t = newTriangle();
    const receiver = t.cloneReceiver();
    const status = await computeShareTargetStatus(receiver, t.branch, 'never.md', 'doc', {
      credentialConfig: [],
    });
    expect(status.verdict).toBe('never-on-branch');
  });

  test('offline: a failed fetch degrades to unknown', async () => {
    const t = newTriangle();
    t.seedAndPush('doc.md', 'one\n');
    const receiver = t.cloneReceiver();
    t.git(receiver, ['remote', 'remove', 'origin']);
    const status = await computeShareTargetStatus(receiver, t.branch, 'doc.md', 'doc', {
      credentialConfig: [],
      fetchTimeoutMs: 5000,
    });
    expect(status.verdict).toBe('unknown');
  });

  test('fresh-clone leg (skipFetch): reads the clone ref without fetching', async () => {
    const t = newTriangle();
    t.seedAndPush('doc.md', 'one\n');
    const receiver = t.cloneReceiver();
    const status = await computeShareTargetStatus(receiver, t.branch, 'doc.md', 'doc', {
      credentialConfig: [],
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
    const status = await computeShareTargetStatus(receiver, t.branch, 'a.md', 'doc', {
      credentialConfig: [],
    });
    expect(status.verdict).toBe('deleted');
  });

  test('fresh-clone leg (skipFetch): a target deleted before the clone is deleted, no fetch', async () => {
    const t = newTriangle();
    t.seedAndPush('gone.md', 'bye\n');
    t.deleteOnOrigin('gone.md');
    const receiver = t.cloneReceiver();
    const status = await computeShareTargetStatus(receiver, t.branch, 'gone.md', 'doc', {
      credentialConfig: [],
      skipFetch: true,
    });
    expect(status.verdict).toBe('deleted');
  });

  test('split-folder rename (files scatter to different prefixes) degrades to deleted, not a garbage redirect', async () => {
    const t = newTriangle();
    t.seedAndPush('docs/a.md', 'a\n');
    t.seedAndPush('docs/b.md', 'b\n');
    const receiver = t.cloneReceiver();
    t.splitRenameOnOrigin([
      ['docs/a.md', 'x/a.md'],
      ['docs/b.md', 'y/b.md'],
    ]);
    const status = await computeShareTargetStatus(receiver, t.branch, 'docs', 'folder', {
      credentialConfig: [],
    });
    expect(status.verdict).toBe('deleted');
  });

  test('local uncommitted delete: still on origin + in HEAD but gone from the working tree is changed-locally', async () => {
    const t = newTriangle();
    t.seedAndPush('local-del.md', '# committed, then deleted locally without syncing\n');
    const receiver = t.cloneReceiver();
    t.deleteInReceiverWorkingTree('local-del.md');
    const status = await computeShareTargetStatus(receiver, t.branch, 'local-del.md', 'doc', {
      credentialConfig: [],
    });
    expect(status.verdict).toBe('changed-locally');
  });

  test('local uncommitted rename: the old path gone from the working tree but still in HEAD is changed-locally', async () => {
    const t = newTriangle();
    t.seedAndPush('local-mv.md', '# committed, then renamed locally without syncing\n');
    const receiver = t.cloneReceiver();
    t.renameInReceiverWorkingTree('local-mv.md', 'renamed-local.md');
    const status = await computeShareTargetStatus(receiver, t.branch, 'local-mv.md', 'doc', {
      credentialConfig: [],
    });
    expect(status.verdict).toBe('changed-locally');
  });
});
