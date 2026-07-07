import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findEnclosingGitRoot } from './find-git-root.ts';

describe('findEnclosingGitRoot', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'find-git-root-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('returns { gitRoot: dir, distance: 0 } when dir has a .git directory', () => {
    mkdirSync(join(root, '.git'), { recursive: true });
    const result = findEnclosingGitRoot(root);
    expect(result).toEqual({ gitRoot: root, distance: 0 });
  });

  test('returns { gitRoot: dir, distance: 0 } when dir has a .git FILE (git worktree form)', () => {
    // `git worktree add` writes a regular file at <worktree>/.git with
    // contents like `gitdir: /path/to/.git/worktrees/foo`.
    writeFileSync(join(root, '.git'), 'gitdir: /tmp/fake-gitdir\n');
    const result = findEnclosingGitRoot(root);
    expect(result).toEqual({ gitRoot: root, distance: 0 });
  });

  test('returns ancestor with positive distance when an ancestor has .git', () => {
    mkdirSync(join(root, '.git'), { recursive: true });
    const nested = join(root, 'src', 'lib');
    mkdirSync(nested, { recursive: true });
    const result = findEnclosingGitRoot(nested);
    expect(result).toEqual({ gitRoot: root, distance: 2 });
  });

  test('returns null when no ancestor has .git', () => {
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    const result = findEnclosingGitRoot(nested);
    expect(result).toBeNull();
  });

  test('deeply nested temp dir with no .git anywhere returns null (filesystem-root stop)', () => {
    let cursor = root;
    for (let i = 0; i < 8; i++) {
      cursor = join(cursor, `level-${i}`);
    }
    mkdirSync(cursor, { recursive: true });
    const result = findEnclosingGitRoot(cursor);
    expect(result).toBeNull();
  });
});
