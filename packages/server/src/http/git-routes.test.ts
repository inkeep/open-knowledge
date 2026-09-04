import { describe, expect, test } from 'vitest';
import type { FileIndexEntry } from '../file-watcher.ts';
import { createGitRoutes } from './git-routes.ts';

function buildGroup() {
  return createGitRoutes({
    projectDir: undefined,
    contentDir: '/nonexistent-content',
    contentFilter: undefined,
    getFileIndex: () => new Map<string, FileIndexEntry>(),
    checkLocalOpSecurity: () => true,
    getSyncEngine: undefined,
    getPrincipal: undefined,
    localOpCliArgs: ['open-knowledge'],
  });
}

describe('createGitRoutes table', () => {
  test('registers exactly the three git paths', () => {
    expect([...buildGroup().paths].sort()).toEqual(
      ['/api/git/branch-info', '/api/git/worktree-status', '/api/git/checkout'].sort(),
    );
  });

  test('checkout is mutating; the two reads are not', () => {
    const { table } = buildGroup();
    expect(table.isMutating('/api/git/checkout')).toBe(true);
    for (const path of ['/api/git/branch-info', '/api/git/worktree-status']) {
      expect(table.isMutating(path), path).toBe(false);
    }
  });
});
