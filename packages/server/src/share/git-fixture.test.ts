/**
 * Fidelity check for the real-git share fixture: every drift state the freshness
 * (send) and target-status (receive) paths care about is asserted here through
 * the exact git probe commands those paths use, so the substrate is proven
 * faithful before the handler tests depend on it. Synchronous `execFileSync`
 * git keeps this unskipped on CI (oven-sh/bun#11892 only bites async children).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createGitTriangle, type GitTriangle } from './git-fixture.test-helper.ts';

const triangles: GitTriangle[] = [];

function newTriangle(): GitTriangle {
  const t = createGitTriangle();
  triangles.push(t);
  return t;
}

afterEach(() => {
  for (const t of triangles.splice(0)) t.cleanup();
});

/** Exit status of a git probe without throwing — the freshness/verdict probes
 *  branch on cat-file / diff exit codes, not on stdout. */
function gitExit(cwd: string, args: string[]): number {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  return r.status ?? -1;
}

describe('createGitTriangle — send-side freshness drift cells', () => {
  test('a clean pushed doc: on origin (cat-file passes) and unchanged (diff clean) -> current', () => {
    const t = newTriangle();
    t.seedAndPush('doc.md', '# hello\n');
    const ref = `origin/${t.branch}`;
    expect(gitExit(t.senderDir, ['cat-file', '-e', `${ref}:doc.md`])).toBe(0);
    expect(gitExit(t.senderDir, ['diff', '--quiet', ref, '--', 'doc.md'])).toBe(0);
  });

  test('an untracked doc: missing from the origin ref -> absent', () => {
    const t = newTriangle();
    t.writeWorkingTree('new.md', '# never saved\n');
    const ref = `origin/${t.branch}`;
    expect(gitExit(t.senderDir, ['cat-file', '-e', `${ref}:new.md`])).not.toBe(0);
  });

  test('an uncommitted edit of a pushed doc: on origin but the working tree differs -> stale', () => {
    const t = newTriangle();
    t.seedAndPush('doc.md', 'v1\n');
    t.writeWorkingTree('doc.md', 'v2 edited, not committed\n');
    const ref = `origin/${t.branch}`;
    expect(gitExit(t.senderDir, ['cat-file', '-e', `${ref}:doc.md`])).toBe(0);
    expect(gitExit(t.senderDir, ['diff', '--quiet', ref, '--', 'doc.md'])).not.toBe(0);
  });

  test('a committed-but-unpushed edit: origin keeps the old blob, diff differs -> stale', () => {
    const t = newTriangle();
    t.seedAndPush('doc.md', 'v1\n');
    t.commitWithoutPush('doc.md', 'v2 committed, not pushed\n');
    const ref = `origin/${t.branch}`;
    expect(t.git(t.senderDir, ['show', `${ref}:doc.md`])).toBe('v1');
    expect(gitExit(t.senderDir, ['cat-file', '-e', `${ref}:doc.md`])).toBe(0);
    expect(gitExit(t.senderDir, ['diff', '--quiet', ref, '--', 'doc.md'])).not.toBe(0);
  });

  test('an untracked file inside a pushed folder: diff is blind to it, status catches it -> stale', () => {
    const t = newTriangle();
    t.seedAndPush('docs/a.md', 'a\n');
    t.writeWorkingTree('docs/new.md', 'brand new, unstaged\n');
    const ref = `origin/${t.branch}`;
    expect(gitExit(t.senderDir, ['cat-file', '-e', `${ref}:docs`])).toBe(0);
    expect(gitExit(t.senderDir, ['diff', '--quiet', ref, '--', 'docs'])).toBe(0);
    expect(
      t.git(t.senderDir, ['status', '--porcelain', '--untracked-files=all', '--', 'docs']),
    ).not.toBe('');
  });

  test('a clean pushed symlink: unchanged -> current, and stored as a symlink (mode 120000)', () => {
    const t = newTriangle();
    t.seedSymlinkAndPush('link.md', 'target.md', '# target\n');
    const ref = `origin/${t.branch}`;
    expect(gitExit(t.senderDir, ['cat-file', '-e', `${ref}:link.md`])).toBe(0);
    expect(gitExit(t.senderDir, ['diff', '--quiet', ref, '--', 'link.md'])).toBe(0);
    expect(t.git(t.senderDir, ['ls-files', '--stage', '--', 'link.md']).startsWith('120000')).toBe(
      true,
    );
  });
});

describe('createGitTriangle — receive-side rename / delete legs', () => {
  test('renaming a doc on origin: new path present, old path gone, classified R by -M', () => {
    const t = newTriangle();
    t.seedAndPush('old.md', '# stable content that survives the move intact\n');
    t.renameOnOrigin('old.md', 'new.md');
    const ref = `origin/${t.branch}`;
    expect(gitExit(t.senderDir, ['cat-file', '-e', `${ref}:new.md`])).toBe(0);
    expect(gitExit(t.senderDir, ['cat-file', '-e', `${ref}:old.md`])).not.toBe(0);

    const removingCommit = t.git(t.senderDir, ['log', '-1', '--format=%H', ref, '--', 'old.md']);
    expect(removingCommit).not.toBe('');
    const nameStatus = t.git(t.senderDir, [
      'diff-tree',
      '-M',
      '-r',
      '--name-status',
      removingCommit,
    ]);
    expect(nameStatus).toMatch(/^R\d*\told\.md\tnew\.md$/m);
  });

  test('a receiver clone observes the renamed path on origin', () => {
    const t = newTriangle();
    t.seedAndPush('old.md', '# content that moves\n');
    t.renameOnOrigin('old.md', 'renamed.md');
    const receiver = t.cloneReceiver();
    const ref = `origin/${t.branch}`;
    expect(gitExit(receiver, ['cat-file', '-e', `${ref}:renamed.md`])).toBe(0);
    expect(gitExit(receiver, ['cat-file', '-e', `${ref}:old.md`])).not.toBe(0);
  });

  test('renaming a folder on origin: per-file R rows share the old prefix', () => {
    const t = newTriangle();
    t.seedAndPush('docs/a.md', 'alpha content long enough to match on similarity\n');
    t.seedAndPush('docs/b.md', 'beta content long enough to match on similarity\n');
    t.renameFolderOnOrigin('docs', 'knowledge');
    const ref = `origin/${t.branch}`;
    expect(gitExit(t.senderDir, ['cat-file', '-e', `${ref}:knowledge/a.md`])).toBe(0);
    expect(gitExit(t.senderDir, ['cat-file', '-e', `${ref}:docs/a.md`])).not.toBe(0);

    const removingCommit = t.git(t.senderDir, ['log', '-1', '--format=%H', ref, '--', 'docs']);
    const nameStatus = t.git(t.senderDir, [
      'diff-tree',
      '-M',
      '-r',
      '--name-status',
      removingCommit,
    ]);
    expect(nameStatus).toMatch(/^R\d*\tdocs\/a\.md\tknowledge\/a\.md$/m);
    expect(nameStatus).toMatch(/^R\d*\tdocs\/b\.md\tknowledge\/b\.md$/m);
  });

  test('deleting a doc on origin: removal commit exists with a D row (not an R)', () => {
    const t = newTriangle();
    t.seedAndPush('gone.md', '# will be deleted with no successor\n');
    t.deleteOnOrigin('gone.md');
    const ref = `origin/${t.branch}`;
    expect(gitExit(t.senderDir, ['cat-file', '-e', `${ref}:gone.md`])).not.toBe(0);

    const removingCommit = t.git(t.senderDir, ['log', '-1', '--format=%H', ref, '--', 'gone.md']);
    expect(removingCommit).not.toBe('');
    const nameStatus = t.git(t.senderDir, [
      'diff-tree',
      '-M',
      '-r',
      '--name-status',
      removingCommit,
    ]);
    expect(nameStatus).toMatch(/^D\tgone\.md$/m);
    expect(nameStatus).not.toMatch(/^R/m);
  });

  test('a path that never existed: empty removal-commit lookup (never-on-branch, not deleted)', () => {
    const t = newTriangle();
    const ref = `origin/${t.branch}`;
    const removingCommit = t.git(t.senderDir, ['log', '-1', '--format=%H', ref, '--', 'never.md']);
    expect(removingCommit).toBe('');
  });
});

describe('createGitTriangle — lifecycle', () => {
  test('cleanup removes every temp repo it created', () => {
    // Intentionally unregistered: this test owns the cleanup it asserts.
    const t = createGitTriangle();
    const { senderDir, originDir } = t;
    const receiver = t.cloneReceiver();
    expect(existsSync(senderDir)).toBe(true);
    expect(existsSync(originDir)).toBe(true);
    expect(existsSync(receiver)).toBe(true);

    t.cleanup();

    expect(existsSync(senderDir)).toBe(false);
    expect(existsSync(originDir)).toBe(false);
    expect(existsSync(receiver)).toBe(false);
  });
});
