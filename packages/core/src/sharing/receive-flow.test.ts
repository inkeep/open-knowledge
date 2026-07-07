import { describe, expect, test } from 'bun:test';

import {
  canonicalGitHubRemoteUrl,
  classifyBranchMatch,
  findRecentProjectsForRepo,
  type HeadBranchInfo,
  type RecentProjectEntry,
} from './receive-flow.ts';

describe('canonicalGitHubRemoteUrl', () => {
  test('emits https github.git form for plain owner/repo', () => {
    expect(canonicalGitHubRemoteUrl({ owner: 'inkeep', repo: 'open-knowledge' })).toBe(
      'https://github.com/inkeep/open-knowledge.git',
    );
  });

  test('preserves casing in the canonical form', () => {
    expect(canonicalGitHubRemoteUrl({ owner: 'Inkeep', repo: 'Open-Knowledge' })).toBe(
      'https://github.com/Inkeep/Open-Knowledge.git',
    );
  });
});

describe('findRecentProjectsForRepo', () => {
  const expected = { owner: 'inkeep', repo: 'open-knowledge' };

  function recent(overrides: Partial<RecentProjectEntry> = {}): RecentProjectEntry {
    return {
      path: '/Users/me/projects/something',
      name: 'something',
      lastOpenedAt: '2026-05-15T00:00:00.000Z',
      ...overrides,
    };
  }

  test('returns [] on an empty list', () => {
    expect(findRecentProjectsForRepo([], expected)).toEqual([]);
  });

  test('returns every matching entry in Recents order (multi-worktree support)', () => {
    const a = recent({ path: '/a', gitRemoteUrl: 'https://github.com/other/repo.git' });
    const b = recent({
      path: '/b',
      gitRemoteUrl: 'https://github.com/inkeep/open-knowledge.git',
    });
    const c = recent({
      path: '/c',
      gitRemoteUrl: 'https://github.com/inkeep/open-knowledge.git',
    });
    const result = findRecentProjectsForRepo([a, b, c], expected);
    expect(result.map((r) => r.path)).toEqual(['/b', '/c']);
  });

  test('matches case-insensitively on owner and repo segments', () => {
    const r = recent({
      path: '/x',
      gitRemoteUrl: 'https://github.com/Inkeep/Open-Knowledge.git',
    });
    expect(findRecentProjectsForRepo([r], expected).map((m) => m.path)).toEqual(['/x']);
  });

  test('matches when the stored URL omits the .git suffix', () => {
    const r = recent({ path: '/x', gitRemoteUrl: 'https://github.com/inkeep/open-knowledge' });
    expect(findRecentProjectsForRepo([r], expected).map((m) => m.path)).toEqual(['/x']);
  });

  test('matches when the stored URL has a trailing slash', () => {
    const r = recent({ path: '/x', gitRemoteUrl: 'https://github.com/inkeep/open-knowledge/' });
    expect(findRecentProjectsForRepo([r], expected).map((m) => m.path)).toEqual(['/x']);
  });

  test('skips entries without gitRemoteUrl', () => {
    const r = recent({ path: '/x' });
    expect(findRecentProjectsForRepo([r], expected)).toEqual([]);
  });

  test('skips entries marked missing even when the URL matches', () => {
    const r = recent({
      path: '/x',
      gitRemoteUrl: 'https://github.com/inkeep/open-knowledge.git',
      missing: true,
    });
    expect(findRecentProjectsForRepo([r], expected)).toEqual([]);
  });

  test('returns [] when no entry matches', () => {
    const r = recent({ path: '/x', gitRemoteUrl: 'https://github.com/other/thing.git' });
    expect(findRecentProjectsForRepo([r], expected)).toEqual([]);
  });

  test('all matching entries marked missing yields [] (graceful degradation anchor)', () => {
    const a = recent({
      path: '/a',
      gitRemoteUrl: 'https://github.com/inkeep/open-knowledge.git',
      missing: true,
    });
    const b = recent({
      path: '/b',
      gitRemoteUrl: 'https://github.com/inkeep/open-knowledge.git',
      missing: true,
    });
    expect(findRecentProjectsForRepo([a, b], expected)).toEqual([]);
  });

  test('mixed missing + present matches returns only the present matches', () => {
    const missing = recent({
      path: '/missing',
      gitRemoteUrl: 'https://github.com/inkeep/open-knowledge.git',
      missing: true,
    });
    const present = recent({
      path: '/present',
      gitRemoteUrl: 'https://github.com/inkeep/open-knowledge.git',
    });
    expect(findRecentProjectsForRepo([missing, present], expected).map((m) => m.path)).toEqual([
      '/present',
    ]);
  });

  test('SSH-form stored URL misses match — falls through to clone / locate', () => {
    // Pre-condition: the open-time backfill (readCanonicalGitHubRemoteUrl)
    // canonicalizes to the https form, so a properly-backfilled
    // RecentProject never reaches this state. But the gap exists if a
    // RecentProject was persisted BEFORE backfill — the URL is the raw
    // SSH form (`git@github.com:owner/repo.git`) and the canonical https
    // compare misses. Pin the silent fall-through behavior.
    const r = recent({
      path: '/x',
      gitRemoteUrl: 'git@github.com:inkeep/open-knowledge.git',
    });
    expect(findRecentProjectsForRepo([r], expected)).toEqual([]);
  });
});

describe('classifyBranchMatch', () => {
  const head = (overrides: Partial<HeadBranchInfo> = {}): HeadBranchInfo => ({
    currentBranch: null,
    headSha: null,
    detached: false,
    ...overrides,
  });

  test('returns true when the share carries no branch (legacy URL)', () => {
    expect(classifyBranchMatch(undefined, head({ currentBranch: 'main' }))).toBe('true');
    expect(classifyBranchMatch(null, head({ currentBranch: 'main' }))).toBe('true');
    expect(classifyBranchMatch('', head({ currentBranch: 'main' }))).toBe('true');
  });

  test('returns true when HEAD read is the graceful-fail sentinel', () => {
    expect(classifyBranchMatch('main', head())).toBe('true');
  });

  test('returns detached on a detached HEAD even when branches would match', () => {
    expect(classifyBranchMatch('main', head({ detached: true, headSha: '1234567' }))).toBe(
      'detached',
    );
  });

  test('returns true on an exact branch-name match', () => {
    expect(classifyBranchMatch('main', head({ currentBranch: 'main' }))).toBe('true');
  });

  test('returns true on an exact slashed-branch match', () => {
    expect(classifyBranchMatch('feat/foo', head({ currentBranch: 'feat/foo' }))).toBe('true');
  });

  test('returns false when share and current branch differ', () => {
    expect(classifyBranchMatch('main', head({ currentBranch: 'develop' }))).toBe('false');
  });

  test('returns false on case-only mismatch (branch names are case-sensitive)', () => {
    expect(classifyBranchMatch('Main', head({ currentBranch: 'main' }))).toBe('false');
  });
});
