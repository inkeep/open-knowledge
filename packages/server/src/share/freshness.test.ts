/**
 * Freshness verdicts verified against the real-git S1 fixture — one case
 * per drift cell, no mocks. The fail-open cases are behavioral pins: a probe
 * that can't run returns `undefined` (the share still ships) rather than a
 * wrong verdict or a throw.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeShareFreshness } from './freshness.ts';
import { createGitTriangle, type GitTriangle } from './git-fixture.test-helper.ts';

const triangles: GitTriangle[] = [];
const scratchDirs: string[] = [];

function newTriangle(): GitTriangle {
  const t = createGitTriangle();
  triangles.push(t);
  return t;
}

afterEach(() => {
  for (const t of triangles.splice(0)) t.cleanup();
  for (const d of scratchDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('computeShareFreshness — doc drift cells', () => {
  test('a clean pushed doc is current', async () => {
    const t = newTriangle();
    t.seedAndPush('doc.md', '# hello\n');
    expect(await computeShareFreshness(t.senderDir, t.branch, 'doc.md', 'doc')).toBe('current');
  });

  test('an untracked doc is absent', async () => {
    const t = newTriangle();
    t.writeWorkingTree('new.md', '# never saved\n');
    expect(await computeShareFreshness(t.senderDir, t.branch, 'new.md', 'doc')).toBe('absent');
  });

  test('an uncommitted edit of a pushed doc is stale', async () => {
    const t = newTriangle();
    t.seedAndPush('doc.md', 'v1\n');
    t.writeWorkingTree('doc.md', 'v2 edited, not committed\n');
    expect(await computeShareFreshness(t.senderDir, t.branch, 'doc.md', 'doc')).toBe('stale');
  });

  test('a committed-but-unpushed edit is stale', async () => {
    const t = newTriangle();
    t.seedAndPush('doc.md', 'v1\n');
    t.commitWithoutPush('doc.md', 'v2 committed, not pushed\n');
    expect(await computeShareFreshness(t.senderDir, t.branch, 'doc.md', 'doc')).toBe('stale');
  });

  test('a clean pushed symlink doc is current', async () => {
    const t = newTriangle();
    t.seedSymlinkAndPush('link.md', 'target.md', '# target\n');
    expect(await computeShareFreshness(t.senderDir, t.branch, 'link.md', 'doc')).toBe('current');
  });
});

describe('computeShareFreshness — folder drift cells', () => {
  test('a clean pushed folder is current', async () => {
    const t = newTriangle();
    t.seedAndPush('docs/a.md', 'a\n');
    expect(await computeShareFreshness(t.senderDir, t.branch, 'docs', 'folder')).toBe('current');
  });

  test('an untracked file inside a pushed folder makes the folder stale', async () => {
    const t = newTriangle();
    t.seedAndPush('docs/a.md', 'a\n');
    t.writeWorkingTree('docs/new.md', 'brand new, unstaged\n');
    expect(await computeShareFreshness(t.senderDir, t.branch, 'docs', 'folder')).toBe('stale');
  });

  test('a folder never pushed to origin is absent', async () => {
    const t = newTriangle();
    t.writeWorkingTree('drafts/x.md', 'unstaged\n');
    expect(await computeShareFreshness(t.senderDir, t.branch, 'drafts', 'folder')).toBe('absent');
  });
});

describe('computeShareFreshness — content-root folder share (empty path)', () => {
  test('a clean content root is current (root tree exists; pathspec falls back to ".")', async () => {
    const t = newTriangle();
    expect(await computeShareFreshness(t.senderDir, t.branch, '', 'folder')).toBe('current');
  });

  test('an uncommitted edit anywhere under the content root is stale', async () => {
    const t = newTriangle();
    t.writeWorkingTree('README.md', '# base changed, not committed\n');
    expect(await computeShareFreshness(t.senderDir, t.branch, '', 'folder')).toBe('stale');
  });

  test('a new untracked file at the content root is stale', async () => {
    const t = newTriangle();
    t.writeWorkingTree('loose.md', 'untracked at root\n');
    expect(await computeShareFreshness(t.senderDir, t.branch, '', 'folder')).toBe('stale');
  });
});

describe('computeShareFreshness — fail-open', () => {
  test('a non-git directory omits freshness (returns undefined, does not throw)', async () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'ok-share-not-a-repo-'));
    scratchDirs.push(notARepo);
    expect(await computeShareFreshness(notARepo, 'main', 'doc.md', 'doc')).toBeUndefined();
  });

  test('an unresolvable branch ref omits freshness rather than guessing', async () => {
    const t = newTriangle();
    t.seedAndPush('doc.md', 'v1\n');
    expect(
      await computeShareFreshness(t.senderDir, 'branch-that-was-never-pushed', 'doc.md', 'doc'),
    ).toBeUndefined();
  });
});
