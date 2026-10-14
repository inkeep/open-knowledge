import type { WorktreeSelectorModel } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { checkoutIdentity } from './checkout-identity';

function model(currentWorktreePath: string | null): WorktreeSelectorModel {
  return {
    mainRoot: '/work/acme-notes',
    currentBranch: null,
    remoteBranches: [],
    entries: [
      {
        branch: 'main',
        worktreePath: '/work/acme-notes',
        isCurrent: currentWorktreePath === '/work/acme-notes',
        isMain: true,
        locked: false,
      },
      {
        branch: 'feat/new-layout',
        worktreePath: '/work/acme-notes-feature',
        isCurrent: currentWorktreePath === '/work/acme-notes-feature',
        isMain: false,
        locked: false,
      },
      {
        branch: null,
        worktreePath: '/work/acme-notes-review',
        isCurrent: currentWorktreePath === '/work/acme-notes-review',
        isMain: false,
        locked: false,
      },
    ],
  };
}

describe('checkoutIdentity', () => {
  test('a nested project in a worktree on a branch names the repository, then the project folder and branch', () => {
    expect(
      checkoutIdentity({
        projectName: 'docs',
        branch: 'feat/new-layout',
        worktreeModel: model('/work/acme-notes-feature'),
      }),
    ).toEqual({ repositoryName: 'acme-notes', checkoutDetail: 'docs · feat/new-layout' });
  });

  test('a nested project in a worktree with no branch falls back to the worktree folder name', () => {
    expect(
      checkoutIdentity({
        projectName: 'docs',
        branch: null,
        worktreeModel: model('/work/acme-notes-review'),
      }),
    ).toEqual({ repositoryName: 'acme-notes', checkoutDetail: 'docs · acme-notes-review' });
  });

  test('a project at the root of the original clone leaves the matching project folder name out', () => {
    expect(
      checkoutIdentity({
        projectName: 'acme-notes',
        branch: 'main',
        worktreeModel: model('/work/acme-notes'),
      }),
    ).toEqual({ repositoryName: 'acme-notes', checkoutDetail: 'main' });
  });

  test('a project at the root of a worktree names the worktree folder as the project folder', () => {
    expect(
      checkoutIdentity({
        projectName: 'acme-notes-feature',
        branch: 'feat/new-layout',
        worktreeModel: model('/work/acme-notes-feature'),
      }),
    ).toEqual({
      repositoryName: 'acme-notes',
      checkoutDetail: 'acme-notes-feature · feat/new-layout',
    });
  });

  test('before the worktree inventory loads, the project name stands in for the repository name', () => {
    expect(checkoutIdentity({ projectName: 'docs', branch: 'main', worktreeModel: null })).toEqual({
      repositoryName: 'docs',
      checkoutDetail: 'main',
    });
  });

  test('with no desktop project and no worktree inventory, only the branch remains', () => {
    expect(checkoutIdentity({ projectName: null, branch: 'main', worktreeModel: null })).toEqual({
      repositoryName: null,
      checkoutDetail: 'main',
    });
  });

  test('with nothing to report, the detail is null rather than an empty string', () => {
    expect(checkoutIdentity({ projectName: null, branch: null, worktreeModel: null })).toEqual({
      repositoryName: null,
      checkoutDetail: null,
    });
  });
});
