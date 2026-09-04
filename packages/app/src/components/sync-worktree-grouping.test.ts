import type { GitWorktreeEntry } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import {
  commonDirPrefix,
  groupWorktreeEntries,
  MAX_WORKTREE_GROUPS,
} from './sync-worktree-grouping.ts';

function entry(path: string): GitWorktreeEntry {
  return { path, code: 'M', syncScoped: true };
}

describe('commonDirPrefix', () => {
  test('compares whole segments, never partial names', () => {
    expect(commonDirPrefix(['notes/alpha/x.md', 'notes/apex/y.md'])).toBe('notes');
  });

  test('is empty when the paths share no directory', () => {
    expect(commonDirPrefix(['a/x.md', 'b/y.md'])).toBe('');
    expect(commonDirPrefix(['x.md', 'a/y.md'])).toBe('');
  });

  test('a single path contributes its whole directory', () => {
    expect(commonDirPrefix(['a/b/c/x.md'])).toBe('a/b/c');
  });
});

describe('groupWorktreeEntries', () => {
  test('a lone entry keeps its full path rather than hoisting its folder', () => {
    const { prefix, groups, loose } = groupWorktreeEntries([entry('src/git/status.ts')]);
    expect(prefix).toBe('');
    expect(groups).toEqual([]);
    expect(loose.map((r) => r.label)).toEqual(['src/git/status.ts']);
  });

  test('an empty listing produces nothing', () => {
    expect(groupWorktreeEntries([])).toEqual({ prefix: '', groups: [], loose: [] });
  });

  test('the shared directory is hoisted once instead of repeating per row', () => {
    const { prefix, groups, loose } = groupWorktreeEntries([
      entry('public/ok/reports/a.md'),
      entry('public/ok/reports/b.md'),
    ]);
    expect(prefix).toBe('public/ok/reports');
    expect(groups).toEqual([]);
    expect(loose.map((r) => r.label)).toEqual(['a.md', 'b.md']);
  });

  test('a lone file never gets its own disclosure', () => {
    const { groups, loose } = groupWorktreeEntries([
      entry('root/.agents/skills/one.md'),
      entry('root/.codex/skills/two.md'),
      entry('root/specs/three.md'),
      entry('root/reports/pierre/a.md'),
      entry('root/reports/pierre/b.md'),
    ]);
    expect(groups.map((g) => g.dir)).toEqual(['reports/pierre']);
    expect(loose.map((r) => r.label)).toEqual([
      '.agents/skills/one.md',
      '.codex/skills/two.md',
      'specs/three.md',
    ]);
  });

  test('loose rows keep enough path to stay identifiable', () => {
    const { loose } = groupWorktreeEntries([
      entry('root/deep/nested/only.md'),
      entry('root/a.md'),
      entry('root/b.md'),
    ]);
    expect(loose.map((r) => r.label)).toContain('deep/nested/only.md');
  });

  test('sibling leaf directories roll up into their shared parent', () => {
    const locales = ['ar', 'bn', 'es', 'fr', 'hi', 'id', 'ko', 'pt-BR', 'ur', 'zh-Hans'];
    const { prefix, groups, loose } = groupWorktreeEntries(
      locales.flatMap((l) => [
        entry(`app/src/locales/${l}/messages.po`),
        entry(`app/src/locales/${l}/messages.json`),
      ]),
    );
    expect(prefix).toBe('app/src/locales');
    expect(groups).toEqual([]);
    expect(loose).toHaveLength(20);
    const paths = loose.map((r) => r.entry.path).sort();
    const expected = locales
      .flatMap((l) => [`app/src/locales/${l}/messages.po`, `app/src/locales/${l}/messages.json`])
      .sort();
    expect(paths).toEqual(expected);
  });

  test('roll-up shortens the deepest groups and leaves shallow ones intact', () => {
    const deep = Array.from({ length: 10 }, (_, i) =>
      entry(`repo/app/src/locales/l${i}/messages.po`),
    );
    const { groups } = groupWorktreeEntries([
      ...deep,
      entry('repo/core/a.ts'),
      entry('repo/core/b.ts'),
      entry('repo/server/c.ts'),
      entry('repo/server/d.ts'),
    ]);
    expect(groups.length).toBeLessThanOrEqual(MAX_WORKTREE_GROUPS);
    const dirs = groups.map((g) => g.dir);
    expect(dirs).toContain('core');
    expect(dirs).toContain('server');
  });

  test('groups come back biggest-first so the noisiest one is on top', () => {
    const { groups } = groupWorktreeEntries([
      entry('r/small/a.md'),
      entry('r/small/b.md'),
      entry('r/big/a.md'),
      entry('r/big/b.md'),
      entry('r/big/c.md'),
    ]);
    expect(groups.map((g) => g.dir)).toEqual(['big', 'small']);
  });

  test('every entry survives grouping exactly once', () => {
    const paths = ['a/b/c/one.md', 'a/b/d/two.md', 'a/e/three.md', 'f/four.md', 'five.md'];
    const { groups, loose } = groupWorktreeEntries(paths.map(entry), 2);
    const seen = [...groups.flatMap((g) => g.rows), ...loose].map((r) => r.entry.path);
    expect(seen.sort()).toEqual([...paths].sort());
  });

  test('a cap smaller than the number of root buckets terminates', () => {
    const { groups, loose } = groupWorktreeEntries(
      [entry('a/one.md'), entry('a/two.md'), entry('b/three.md'), entry('b/four.md')],
      1,
    );
    expect([...groups.flatMap((g) => g.rows), ...loose]).toHaveLength(4);
  });
});
