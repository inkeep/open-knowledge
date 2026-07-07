import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirtyFilesOverlapWith } from './git-dirty.ts';

let projectDir: string;

function run(cmd: string): string {
  return execSync(cmd, { cwd: projectDir, encoding: 'utf8' });
}

function write(relPath: string, content: string): void {
  writeFileSync(join(projectDir, relPath), content);
}

function commitAll(message: string): void {
  run('git add -A');
  run(`git commit -q -m "${message}"`);
}

function initRepo(): void {
  run('git init -q -b main');
  run('git config user.email "test@example.com"');
  run('git config user.name "Test"');
  run('git config commit.gpgsign false');
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'ok-git-dirty-test-'));
  initRepo();
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('dirtyFilesOverlapWith', () => {
  test('clean tree with no overlap returns no conflicts', async () => {
    write('a.md', 'a-on-main\n');
    commitAll('init');
    run('git checkout -q -b feature');
    write('a.md', 'a-on-feature\n');
    commitAll('feature edit');
    run('git checkout -q main');

    const result = await dirtyFilesOverlapWith(projectDir, 'feature');

    expect(result).toEqual({ conflicts: false, files: [] });
  });

  test('dirty file unrelated to target ref returns no conflicts', async () => {
    write('a.md', 'a-on-main\n');
    write('b.md', 'b-on-main\n');
    commitAll('init');
    run('git checkout -q -b feature');
    write('a.md', 'a-on-feature\n');
    commitAll('feature edits a');
    run('git checkout -q main');

    write('b.md', 'b-dirty\n');

    const result = await dirtyFilesOverlapWith(projectDir, 'feature');

    expect(result).toEqual({ conflicts: false, files: [] });
  });

  test('dirty file overlapping with change set returns conflicts with only the overlap', async () => {
    write('a.md', 'a-on-main\n');
    write('b.md', 'b-on-main\n');
    commitAll('init');
    run('git checkout -q -b feature');
    write('a.md', 'a-on-feature\n');
    commitAll('feature edits a');
    run('git checkout -q main');

    write('a.md', 'a-dirty\n');
    write('b.md', 'b-dirty\n');

    const result = await dirtyFilesOverlapWith(projectDir, 'feature');

    expect(result.conflicts).toBe(true);
    expect(result.files).toEqual(['a.md']);
  });

  test('untracked file overlapping with change set counts as a conflict', async () => {
    write('a.md', 'a-on-main\n');
    commitAll('init');
    run('git checkout -q -b feature');
    write('new-on-feature.md', 'feature-created\n');
    commitAll('feature adds file');
    run('git checkout -q main');

    write('new-on-feature.md', 'untracked-local\n');

    const result = await dirtyFilesOverlapWith(projectDir, 'feature');

    expect(result.conflicts).toBe(true);
    expect(result.files).toEqual(['new-on-feature.md']);
  });

  test('multiple overlapping dirty + untracked files produce sorted deduped list', async () => {
    write('a.md', 'a-on-main\n');
    write('b.md', 'b-on-main\n');
    commitAll('init');
    run('git checkout -q -b feature');
    write('a.md', 'a-on-feature\n');
    write('b.md', 'b-on-feature\n');
    write('z-new.md', 'feature-created\n');
    commitAll('feature edits + add');
    run('git checkout -q main');

    write('b.md', 'b-dirty\n');
    write('a.md', 'a-dirty\n');
    write('z-new.md', 'untracked-local\n');

    const result = await dirtyFilesOverlapWith(projectDir, 'feature');

    expect(result.conflicts).toBe(true);
    expect(result.files).toEqual(['a.md', 'b.md', 'z-new.md']);
  });

  test('files list is the intersection, excluding dirty files not in the change set', async () => {
    write('overlap.md', 'overlap-main\n');
    write('only-dirty.md', 'only-dirty-main\n');
    write('only-changed.md', 'only-changed-main\n');
    commitAll('init');
    run('git checkout -q -b feature');
    write('overlap.md', 'overlap-feature\n');
    write('only-changed.md', 'only-changed-feature\n');
    commitAll('feature edits');
    run('git checkout -q main');

    write('overlap.md', 'overlap-dirty\n');
    write('only-dirty.md', 'only-dirty-dirty\n');

    const result = await dirtyFilesOverlapWith(projectDir, 'feature');

    expect(result.conflicts).toBe(true);
    expect(result.files).toEqual(['overlap.md']);
    expect(result.files).not.toContain('only-dirty.md');
    expect(result.files).not.toContain('only-changed.md');
  });

  test('target ref that does not exist locally propagates an error', async () => {
    write('a.md', 'a\n');
    commitAll('init');

    await expect(dirtyFilesOverlapWith(projectDir, 'does-not-exist')).rejects.toThrow();
  });

  test('diverged branches: dirty file in HEAD-only change set is flagged as a conflict', async () => {
    // Setup a diverged repo where HEAD and target each have commits the other lacks.
    //  - file-A.md: HEAD changed it since merge-base; target did not.
    //  - file-B.md: target changed it since merge-base; HEAD did not.
    // A `git checkout target` will restore file-A.md to the merge-base version
    // (because target's view of file-A.md is the merge-base version, which differs
    // from HEAD's view). If file-A.md is dirty on the working tree, the checkout
    // would clobber the dirty change → must be flagged as a conflict.
    //
    // The three-dot diff `HEAD...target` resolves to `merge-base..target` and
    // therefore only includes file-B.md (the file target changed). file-A.md
    // is missed, even though it would actually be touched by the checkout.
    write('file-A.md', 'a-at-merge-base\n');
    write('file-B.md', 'b-at-merge-base\n');
    commitAll('merge-base');

    run('git checkout -q -b target');
    write('file-B.md', 'b-on-target\n');
    commitAll('target edits b');

    run('git checkout -q main');
    write('file-A.md', 'a-on-head\n');
    commitAll('head edits a');

    // Dirty file-A.md on the working tree.
    write('file-A.md', 'a-dirty\n');

    const result = await dirtyFilesOverlapWith(projectDir, 'target');

    expect(result.conflicts).toBe(true);
    expect(result.files).toEqual(['file-A.md']);
  });

  test('slashed branch name as targetRef works correctly', async () => {
    write('a.md', 'a-on-main\n');
    commitAll('init');
    run('git checkout -q -b feat/foo');
    write('a.md', 'a-on-feat-foo\n');
    commitAll('feat/foo edit');
    run('git checkout -q main');

    write('a.md', 'a-dirty\n');

    const result = await dirtyFilesOverlapWith(projectDir, 'feat/foo');

    expect(result.conflicts).toBe(true);
    expect(result.files).toEqual(['a.md']);
  });

  test('non-ASCII filename in the overlap is reported with its real name', async () => {
    write('hyvää yötä.md', 'base\n');
    commitAll('init');
    run('git checkout -q -b feature');
    write('hyvää yötä.md', 'feature edit\n');
    commitAll('feature edits non-ascii file');
    run('git checkout -q main');

    write('hyvää yötä.md', 'dirty\n');

    const result = await dirtyFilesOverlapWith(projectDir, 'feature');

    expect(result.conflicts).toBe(true);
    expect(result.files).toEqual(['hyvää yötä.md']);
  });

  test('staged rename reports the new path, not the original', async () => {
    write('old-name.md', 'base\n');
    commitAll('init');
    run('git checkout -q -b feature');
    write('new-name.md', 'feature version\n');
    commitAll('feature adds new-name');
    run('git checkout -q main');

    run('git mv old-name.md new-name.md');

    const result = await dirtyFilesOverlapWith(projectDir, 'feature');

    expect(result.conflicts).toBe(true);
    expect(result.files).toEqual(['new-name.md']);
  });
});

// Suppress unused-import warnings for lifecycle hooks
void beforeEach;
void afterEach;
