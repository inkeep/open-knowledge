import type { WorktreeInventoryModel, WorktreeSelectorModel } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import type { RecentProjectEntry } from '@/lib/desktop-bridge-types';
import {
  basenameOf,
  buildWorktreeFlyoutEntries,
  groupRecentsByRepo,
  rowLocation,
} from './project-switcher-recents.ts';

function recent(input: {
  path: string;
  commonDir?: string;
  mainRoot?: string;
  checkoutRoot?: string;
  projectSubPath?: string;
  linked?: boolean;
  branch?: string;
  opened?: string;
}): RecentProjectEntry {
  return {
    path: input.path,
    name: basenameOf(input.path),
    lastOpenedAt: input.opened ?? '2026-07-01',
    ...(input.commonDir === undefined ? {} : { gitCommonDir: input.commonDir }),
    ...(input.mainRoot === undefined ? {} : { mainRoot: input.mainRoot }),
    ...(input.checkoutRoot === undefined ? {} : { checkoutRoot: input.checkoutRoot }),
    ...(input.projectSubPath === undefined ? {} : { projectSubPath: input.projectSubPath }),
    ...(input.linked === undefined ? {} : { isLinkedWorktree: input.linked }),
    ...(input.branch === undefined ? {} : { branch: input.branch }),
  };
}

function repoRecent(
  path: string,
  checkoutRoot: string,
  branch: string,
  options: { linked?: boolean; projectSubPath?: string; opened?: string } = {},
): RecentProjectEntry {
  const projectSubPath = options.projectSubPath ?? '';
  return recent({
    path,
    commonDir: '/repo/.git',
    mainRoot: '/repo',
    checkoutRoot,
    projectSubPath,
    linked: options.linked ?? checkoutRoot !== '/repo',
    branch,
    opened: options.opened,
  });
}

function inventory(projectSubPath = ''): WorktreeInventoryModel {
  const suffix = projectSubPath === '' ? '' : `/${projectSubPath}`;
  return {
    gitCommonDir: '/repo/.git',
    primaryCheckoutRoot: '/repo',
    projectSubPath,
    entries: [
      {
        checkoutRoot: '/repo',
        projectPath: `/repo${suffix}`,
        branch: 'main',
        headSha: '11111111',
        location: 'primary',
        availability: 'available',
        locked: false,
        prunable: false,
      },
      {
        checkoutRoot: '/repo/.ok/worktrees/dev',
        projectPath: `/repo/.ok/worktrees/dev${suffix}`,
        branch: 'dev',
        headSha: '22222222',
        location: 'internal',
        availability: 'available',
        locked: true,
        prunable: false,
      },
      {
        checkoutRoot: '/external/repo-feat',
        projectPath: `/external/repo-feat${suffix}`,
        branch: null,
        headSha: '33333333',
        location: 'external',
        availability: 'missing',
        locked: false,
        prunable: true,
      },
    ],
  };
}

function selector(entries: WorktreeSelectorModel['entries']): WorktreeSelectorModel {
  return { mainRoot: '/repo', currentBranch: 'main', entries, remoteBranches: [] };
}

describe('basenameOf', () => {
  test('handles platform separators and trailing slashes', () => {
    expect(basenameOf('/a/b/test/')).toBe('test');
    expect(basenameOf('C:\\a\\b\\test')).toBe('test');
  });
});

describe('groupRecentsByRepo', () => {
  test('groups by repository identity plus project-relative root', () => {
    const groups = groupRecentsByRepo([
      repoRecent('/repo', '/repo', 'main'),
      repoRecent('/repo/.ok/worktrees/dev', '/repo/.ok/worktrees/dev', 'dev'),
      repoRecent('/repo/packages/docs', '/repo', 'main', { projectSubPath: 'packages/docs' }),
      repoRecent('/external/repo-docs/packages/docs', '/external/repo-docs', 'docs', {
        linked: true,
        projectSubPath: 'packages/docs',
      }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.projectSubPath)).toEqual(['', 'packages/docs']);
    expect(groups[0]?.worktrees.map((entry) => entry.branch)).toEqual(['dev']);
    expect(groups[1]?.worktrees.map((entry) => entry.branch)).toEqual(['docs']);
  });

  test('linked-only history keeps repository identity without fabricating a primary path', () => {
    const linked = repoRecent('/external/repo-feat', '/external/repo-feat', 'feat');
    const [group] = groupRecentsByRepo([linked]);
    expect(group?.gitCommonDir).toBe('/repo/.git');
    expect(group?.repositoryName).toBe('repo');
    expect(group?.primaryProject).toBeNull();
    expect(group?.project.path).toBe(linked.path);
    expect(group?.inventoryAnchorPath).toBe(linked.path);
  });

  test('non-Git recents remain independent project groups', () => {
    const groups = groupRecentsByRepo([recent({ path: '/notes' }), recent({ path: '/scratch' })]);
    expect(groups.map((group) => group.project.path)).toEqual(['/notes', '/scratch']);
    expect(groups.every((group) => group.gitCommonDir === null)).toBe(true);
  });
});

describe('buildWorktreeFlyoutEntries', () => {
  test('a linked-only recent receives the full selected-scope inventory', () => {
    const [group] = groupRecentsByRepo([
      repoRecent('/repo/.ok/worktrees/dev', '/repo/.ok/worktrees/dev', 'dev'),
    ]);
    if (group === undefined) throw new Error('missing group');
    const entries = buildWorktreeFlyoutEntries(group, inventory(), null, '/elsewhere');
    expect(entries.map((entry) => entry.path)).toEqual([
      '/repo',
      '/repo/.ok/worktrees/dev',
      '/external/repo-feat',
    ]);
    expect(entries.map(rowLocation)).toEqual(['primary', 'internal', 'external']);
    expect(entries[1]).toMatchObject({ locked: true, availability: 'available' });
    expect(entries[2]).toMatchObject({ prunable: true, availability: 'missing' });
  });

  test('nested project inventory keeps the projected project path as open identity', () => {
    const [group] = groupRecentsByRepo([
      repoRecent('/repo/packages/docs', '/repo', 'main', { projectSubPath: 'packages/docs' }),
    ]);
    if (group === undefined) throw new Error('missing group');
    const entries = buildWorktreeFlyoutEntries(
      group,
      inventory('packages/docs'),
      null,
      '/repo/packages/docs',
    );
    expect(entries.find((entry) => entry.location === 'internal')).toMatchObject({
      path: '/repo/.ok/worktrees/dev/packages/docs',
      checkoutRoot: '/repo/.ok/worktrees/dev',
      isCurrent: false,
      inventoryOpenRequest: {
        projectSubPath: 'packages/docs',
        projectPath: '/repo/.ok/worktrees/dev/packages/docs',
      },
    });
  });

  test('branch creation entries appear only for the active project scope', () => {
    const [active] = groupRecentsByRepo([repoRecent('/repo', '/repo', 'main')]);
    const [inactive] = groupRecentsByRepo([
      repoRecent('/repo/packages/docs', '/repo', 'main', { projectSubPath: 'packages/docs' }),
    ]);
    if (active === undefined || inactive === undefined) throw new Error('missing group');
    const branchModel = selector([
      { branch: 'new-branch', worktreePath: null, isCurrent: false, isMain: false, locked: false },
    ]);
    expect(
      buildWorktreeFlyoutEntries(active, inventory(), branchModel, '/repo').map(
        (entry) => entry.branch,
      ),
    ).toContain('new-branch');
    expect(
      buildWorktreeFlyoutEntries(inactive, inventory('packages/docs'), branchModel, '/repo').map(
        (entry) => entry.branch,
      ),
    ).not.toContain('new-branch');
  });
});
