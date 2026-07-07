import { describe, expect, test } from 'bun:test';
import type { WorktreeSelectorModel } from '@inkeep/open-knowledge-core';
import type { RecentProjectEntry } from '@/lib/desktop-bridge-types';
import {
  basenameOf,
  buildWorktreeFlyoutEntries,
  groupRecentsByRepo,
} from './project-switcher-recents.ts';

function main(path: string, commonDir: string): RecentProjectEntry {
  return {
    path,
    name: path.split('/').pop() ?? path,
    lastOpenedAt: '2026-07-01',
    gitCommonDir: commonDir,
    mainRoot: path,
    isLinkedWorktree: false,
    branch: 'main',
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
