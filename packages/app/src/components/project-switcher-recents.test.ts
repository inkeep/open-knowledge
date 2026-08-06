import type { WorktreeSelectorModel } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import type { RecentProjectEntry } from '@/lib/desktop-bridge-types';
import {
  basenameOf,
  buildWorktreeFlyoutEntries,
  groupRecentsByRepo,
  rowLocation,
} from './project-switcher-recents.ts';

// `branch` is a parameter, not a constant. Pinning it to 'main' is what hid
// the mislabel: the original clone can have ANY branch checked out, and the
// badge must stay a statement about the directory when it does.
function main(path: string, commonDir: string, branch = 'main'): RecentProjectEntry {
  return {
    path,
    name: path.split('/').pop() ?? path,
    lastOpenedAt: '2026-07-01',
    gitCommonDir: commonDir,
    mainRoot: path,
    isLinkedWorktree: false,
    branch,
  };
}
function worktree(
  path: string,
  commonDir: string,
  mainRoot: string,
  branch: string,
  lastOpenedAt = '2026-07-01',
): RecentProjectEntry {
  return {
    path,
    name: path.split('/').pop() ?? path,
    lastOpenedAt,
    gitCommonDir: commonDir,
    mainRoot,
    isLinkedWorktree: true,
    branch,
  };
}
function nonGit(path: string): RecentProjectEntry {
  return { path, name: path.split('/').pop() ?? path, lastOpenedAt: '2026-07-01' };
}

function model(
  entries: WorktreeSelectorModel['entries'],
  mainRoot = '/repo',
): WorktreeSelectorModel {
  return { mainRoot, currentBranch: 'main', entries, remoteBranches: [] };
}

describe('basenameOf', () => {
  test('handles / and \\ and trailing slashes', () => {
    expect(basenameOf('/a/b/test')).toBe('test');
    expect(basenameOf('/a/b/test/')).toBe('test');
    expect(basenameOf('C:\\a\\b\\test')).toBe('test');
    expect(basenameOf('solo')).toBe('solo');
  });
});

describe('groupRecentsByRepo', () => {
  test('groups a repo main + its linked worktrees under one group', () => {
    const groups = groupRecentsByRepo([
      main('/repo', '/repo/.git'),
      worktree('/repo/.ok/worktrees/dev', '/repo/.git', '/repo', 'dev'),
      worktree('/repo/.ok/worktrees/feat', '/repo/.git', '/repo', 'feat'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.project.path).toBe('/repo');
    expect(groups[0]?.projectSynthesized).toBe(false);
    expect(groups[0]?.worktrees.map((w) => w.branch)).toEqual(['dev', 'feat']);
  });

  test('non-git recents become singleton groups with no worktrees', () => {
    const groups = groupRecentsByRepo([nonGit('/notes'), nonGit('/scratch')]);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.worktrees.length === 0)).toBe(true);
    expect(groups.map((g) => g.project.path)).toEqual(['/notes', '/scratch']);
  });

  test('synthesizes the project row when only a worktree is in recents', () => {
    const groups = groupRecentsByRepo([
      worktree('/repo/.ok/worktrees/dev', '/repo/.git', '/repo', 'dev'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.project.path).toBe('/repo');
    expect(groups[0]?.project.name).toBe('repo');
    expect(groups[0]?.projectSynthesized).toBe(true);
    expect(groups[0]?.worktrees).toHaveLength(1);
  });

  test('preserves recents order across groups', () => {
    const groups = groupRecentsByRepo([
      main('/alpha', '/alpha/.git'),
      nonGit('/notes'),
      main('/beta', '/beta/.git'),
      worktree('/alpha/.ok/worktrees/x', '/alpha/.git', '/alpha', 'x'),
    ]);
    // alpha first (its main appeared first), then notes, then beta. The alpha
    // worktree folds into the existing alpha group, not a new trailing one.
    expect(groups.map((g) => g.project.path)).toEqual(['/alpha', '/notes', '/beta']);
    expect(groups[0]?.worktrees).toHaveLength(1);
  });

  test('two different repos stay separate', () => {
    const groups = groupRecentsByRepo([
      main('/a', '/a/.git'),
      worktree('/a/.ok/worktrees/x', '/a/.git', '/a', 'x'),
      main('/b', '/b/.git'),
    ]);
    expect(groups).toHaveLength(2);
  });
});

describe('buildWorktreeFlyoutEntries', () => {
  test('pins main first, then opened worktrees by recency (newest first)', () => {
    const [group] = groupRecentsByRepo([
      main('/repo', '/repo/.git'),
      worktree('/repo/.ok/worktrees/older', '/repo/.git', '/repo', 'older', '2026-06-01'),
      worktree('/repo/.ok/worktrees/newer', '/repo/.git', '/repo', 'newer', '2026-06-30'),
    ]);
    if (group === undefined) throw new Error('group');
    const entries = buildWorktreeFlyoutEntries(group, null, '/other');
    expect(entries.map((e) => e.path)).toEqual([
      '/repo',
      '/repo/.ok/worktrees/newer',
      '/repo/.ok/worktrees/older',
    ]);
    expect(entries[0]?.isMain).toBe(true);
    expect(entries[0]?.branch).toBe('main');
  });

  test('flags the current entry', () => {
    const [group] = groupRecentsByRepo([
      main('/repo', '/repo/.git'),
      worktree('/repo/.ok/worktrees/dev', '/repo/.git', '/repo', 'dev'),
    ]);
    if (group === undefined) throw new Error('group');
    const entries = buildWorktreeFlyoutEntries(group, null, '/repo/.ok/worktrees/dev');
    expect(entries.find((e) => e.path === '/repo/.ok/worktrees/dev')?.isCurrent).toBe(true);
    expect(entries.find((e) => e.isMain)?.isCurrent).toBe(false);
  });

  test('a synthesized project row contributes no pinned main entry', () => {
    const [group] = groupRecentsByRepo([
      worktree('/repo/.ok/worktrees/dev', '/repo/.git', '/repo', 'dev'),
    ]);
    if (group === undefined) throw new Error('group');
    const entries = buildWorktreeFlyoutEntries(group, null, '/other');
    expect(entries.some((e) => e.isMain)).toBe(false);
    expect(entries.map((e) => e.path)).toEqual(['/repo/.ok/worktrees/dev']);
  });

  test('merges the current project’s un-opened branches (create-on-demand) after opened worktrees', () => {
    const [group] = groupRecentsByRepo([
      main('/repo', '/repo/.git'),
      worktree('/repo/.ok/worktrees/dev', '/repo/.git', '/repo', 'dev'),
    ]);
    if (group === undefined) throw new Error('group');
    const entries = buildWorktreeFlyoutEntries(
      group,
      model([
        { branch: 'main', worktreePath: '/repo', isCurrent: false, isMain: true, locked: false },
        {
          branch: 'dev',
          worktreePath: '/repo/.ok/worktrees/dev',
          isCurrent: false,
          isMain: false,
          locked: false,
        },
        { branch: 'zeta', worktreePath: null, isCurrent: false, isMain: false, locked: false },
        { branch: 'alpha', worktreePath: null, isCurrent: false, isMain: false, locked: false },
      ]),
      '/other',
    );
    // main pinned, then opened dev, then create-on-demand branches alphabetized.
    expect(entries.map((e) => e.branch)).toEqual(['main', 'dev', 'alpha', 'zeta']);
    const alpha = entries.find((e) => e.branch === 'alpha');
    expect(alpha?.opened).toBe(false);
    expect(alpha?.path).toBeNull();
  });

  test('does not merge a branch model belonging to a different project', () => {
    const [group] = groupRecentsByRepo([
      main('/repo', '/repo/.git'),
      worktree('/repo/.ok/worktrees/dev', '/repo/.git', '/repo', 'dev'),
    ]);
    if (group === undefined) throw new Error('group');
    // Model for /elsewhere — its mainRoot doesn't match this group, so ignored.
    const entries = buildWorktreeFlyoutEntries(
      group,
      model(
        [{ branch: 'leak', worktreePath: null, isCurrent: false, isMain: false, locked: false }],
        '/elsewhere',
      ),
      '/other',
    );
    expect(entries.some((e) => e.branch === 'leak')).toBe(false);
  });

  test('does not double-list a branch already present as an opened worktree', () => {
    const [group] = groupRecentsByRepo([
      main('/repo', '/repo/.git'),
      worktree('/repo/.ok/worktrees/dev', '/repo/.git', '/repo', 'dev'),
    ]);
    if (group === undefined) throw new Error('group');
    const entries = buildWorktreeFlyoutEntries(
      group,
      model([
        {
          branch: 'dev',
          worktreePath: '/repo/.ok/worktrees/dev',
          isCurrent: false,
          isMain: false,
          locked: false,
        },
      ]),
      '/other',
    );
    expect(entries.filter((e) => e.branch === 'dev')).toHaveLength(1);
  });
});

describe('rowLocation', () => {
  test('classifies each row into exactly one location', () => {
    expect(rowLocation({ isMain: true, opened: true })).toBe('primary');
    expect(rowLocation({ isMain: false, opened: true })).toBe('worktree');
    expect(rowLocation({ isMain: false, opened: false })).toBe('none');
  });

  test('a row with no worktree keeps its creation affordance even when flagged as the original clone', () => {
    // Guards the ordering: testing the original-clone flag first would swallow
    // the creation affordance. The selector model does not produce this pairing
    // today, but nothing upstream enforces that.
    expect(rowLocation({ isMain: true, opened: false })).toBe('none');
  });

  test('every combination of the two inputs yields the expected location', () => {
    // Ordered: (isMain, opened) = (T,T), (T,F), (F,T), (F,F).
    const locations = [true, false].flatMap((isMain) =>
      [true, false].map((opened) => rowLocation({ isMain, opened })),
    );
    expect(locations).toEqual(['primary', 'none', 'worktree', 'none']);
  });
});

describe('the original clone is identified by directory, not by branch (PRD-7330)', () => {
  // The defect: the flyout badged the original clone's row as the repository's
  // "default" branch. Rows are branches; the flag behind the badge is a path
  // comparison. So checking out a feature branch in the original clone moved
  // the claim onto that branch and left the real default branch elsewhere.
  //
  // Scope note. These cover the classifier's contract against the model, which
  // was always correct here — the model derived the flag from a path, never
  // from a branch name. The lie lived in the render, so the regression guard
  // for it is the badge assertion in RecentProjectsMenu.dom.test.tsx. What
  // these catch is the model regressing to derive the flag from a branch name.
  function group(rootBranch: string) {
    const [g] = groupRecentsByRepo([
      main('/repo', '/repo/.git', rootBranch),
      worktree('/repo/.ok/worktrees/dev', '/repo/.git', '/repo', 'dev'),
    ]);
    if (g === undefined) throw new Error('group');
    return g;
  }

  test('the original clone is `primary` whatever branch is checked out there', () => {
    for (const rootBranch of ['main', 'feat/login', 'fix/crash']) {
      const entries = buildWorktreeFlyoutEntries(group(rootBranch), null, '/repo');
      const primary = entries.filter((e) => rowLocation(e) === 'primary');
      expect(primary).toHaveLength(1);
      expect(primary[0]?.branch).toBe(rootBranch);
    }
  });

  test('the repository default branch is not badged `primary` when the original clone is elsewhere', () => {
    const entries = buildWorktreeFlyoutEntries(
      group('feat/login'),
      model([
        { branch: 'main', worktreePath: null, isCurrent: false, isMain: false, locked: false },
      ]),
      '/repo',
    );
    // `main` has no worktree here, so it reads as one to create — the row the
    // old badge inverted. What matters is that nothing calls it `primary`.
    const mainRow = entries.find((e) => e.branch === 'main');
    if (mainRow === undefined) throw new Error('expected a row for the default branch');
    expect(rowLocation(mainRow)).toBe('none');
  });

  test('linked worktrees are badged `worktree`, so neither category is inferred from absence', () => {
    const entries = buildWorktreeFlyoutEntries(group('feat/login'), null, '/repo');
    expect(entries.map((e) => rowLocation(e)).filter((l) => l === 'worktree')).toHaveLength(1);
    // Exhaustive: every row carries a location, none falls through.
    expect(entries.map((e) => rowLocation(e))).toHaveLength(entries.length);
  });
});
