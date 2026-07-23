import { symlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { walkFiles } from './fs-walk.ts';
import { makeTree } from './mktree.test-helper.ts';

describe('walkFiles', () => {
  test('lists files recursively', () => {
    const root = makeTree({
      'a.md': 'A',
      'sub/b.md': 'B',
      'sub/deep/c.md': 'C',
    });
    const names = walkFiles(root)
      .map((f) => basename(f))
      .sort();
    expect(names).toEqual(['a.md', 'b.md', 'c.md']);
  });

  test('skips dotfiles and dot-directories (.ok, .git)', () => {
    const root = makeTree({
      'keep.md': 'K',
      '.okignore': 'x',
      '.ok/local/server.lock': 'lock',
      '.git/HEAD': 'ref',
    });
    const names = walkFiles(root).map((f) => basename(f));
    expect(names).toEqual(['keep.md']);
  });

  test('returns empty for a missing directory without throwing', () => {
    expect(walkFiles('/no/such/dir/ok-migrate-xyz')).toEqual([]);
  });

  test('does not descend into directory symlinks (ancestor link would cycle forever)', () => {
    const root = makeTree({ 'a.md': 'A', 'sub/b.md': 'B' });
    symlinkSync(root, join(root, 'sub', 'loop'));
    const names = walkFiles(root)
      .map((f) => basename(f))
      .sort();
    expect(names).toEqual(['a.md', 'b.md']);
  });

  test('includes symlinks to files', () => {
    const root = makeTree({ 'real.md': 'R' });
    symlinkSync(join(root, 'real.md'), join(root, 'alias.md'));
    const names = walkFiles(root)
      .map((f) => basename(f))
      .sort();
    expect(names).toEqual(['alias.md', 'real.md']);
  });
});
