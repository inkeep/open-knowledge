/**
 * Unit tests for resolveGitIdentity() — chain order + fallback logic.
 * Uses injected GitConfigReader so no actual git or simple-git calls are made.
 *
 * Chain: per-worktree → repo-local → global → tokenStore → null
 */

import { describe, expect, test } from 'bun:test';
import {
  type GitConfigReader,
  type GitIdentityTokenStore,
  resolveGitIdentity,
} from './git-identity.ts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a mock GitConfigReader that returns pre-defined values per (key, scope). */
function mockReader(
  values: Partial<Record<string, Partial<Record<'worktree' | 'local' | 'global', string | null>>>>,
): GitConfigReader {
  return (_dir, key, scope) => values[key]?.[scope] ?? null;
}

/** A minimal TokenStore stub. */
function makeTokenStore(entry: { login: string; name?: string; email?: string } | null) {
  const store: GitIdentityTokenStore = {
    get: async (_host: string) => entry,
  };
  return store;
}

// ─── Chain order tests ────────────────────────────────────────────────────────

describe('resolveGitIdentity chain order', () => {
  test('Step 1 (worktree): per-worktree identity wins over local + global', async () => {
    const reader = mockReader({
      'user.name': { worktree: 'WT Dev', local: 'Local Dev', global: 'Global Dev' },
      'user.email': {
        worktree: 'wt@example.com',
        local: 'local@example.com',
        global: 'global@example.com',
      },
    });
    const result = await resolveGitIdentity('/fake/repo', null, null, reader);
    expect(result).toEqual({ name: 'WT Dev', email: 'wt@example.com' });
  });

  test('Step 1 partial: worktree name only — falls through to local pair', async () => {
    const reader = mockReader({
      'user.name': { worktree: 'WT Dev', local: 'Local Dev', global: 'Global Dev' },
      'user.email': { worktree: null, local: 'local@example.com', global: 'global@example.com' },
    });
    const result = await resolveGitIdentity('/fake/repo', null, null, reader);
    expect(result).toEqual({ name: 'Local Dev', email: 'local@example.com' });
  });

  test('Step 1 partial: worktree email only — falls through to local pair', async () => {
    const reader = mockReader({
      'user.name': { worktree: null, local: 'Local Dev', global: 'Global Dev' },
      'user.email': {
        worktree: 'wt@example.com',
        local: 'local@example.com',
        global: 'global@example.com',
      },
    });
    const result = await resolveGitIdentity('/fake/repo', null, null, reader);
    expect(result).toEqual({ name: 'Local Dev', email: 'local@example.com' });
  });

  test('Step 1 absent: empty worktree scope falls through to local (extension off / non-worktree)', async () => {
    const reader = mockReader({
      'user.name': { local: 'Local Dev' },
      'user.email': { local: 'local@example.com' },
    });
    const result = await resolveGitIdentity('/fake/repo', null, null, reader);
    expect(result).toEqual({ name: 'Local Dev', email: 'local@example.com' });
  });

  test('Step 2: returns repo-local identity when both name + email are set locally', async () => {
    const reader = mockReader({
      'user.name': { local: 'Local Dev', global: 'Global Dev' },
      'user.email': { local: 'local@example.com', global: 'global@example.com' },
    });
    const result = await resolveGitIdentity('/fake/repo', null, null, reader);
    expect(result).toEqual({ name: 'Local Dev', email: 'local@example.com' });
  });

  test('Step 2 partial: local name only — falls through to global', async () => {
    const reader = mockReader({
      'user.name': { local: 'Local Dev', global: 'Global Dev' },
      'user.email': { local: null, global: 'global@example.com' },
    });
    const result = await resolveGitIdentity('/fake/repo', null, null, reader);
    expect(result).toEqual({ name: 'Global Dev', email: 'global@example.com' });
  });

  test('Step 3: returns global identity when local is empty', async () => {
    const reader = mockReader({
      'user.name': { local: null, global: 'Global Dev' },
      'user.email': { local: null, global: 'global@example.com' },
    });
    const result = await resolveGitIdentity('/fake/repo', null, null, reader);
    expect(result).toEqual({ name: 'Global Dev', email: 'global@example.com' });
  });

  test('Step 4: uses tokenStore when both git configs are empty', async () => {
    const reader = mockReader({});
    const store = makeTokenStore({
      login: 'octocat',
      name: 'The Octocat',
      email: 'cat@github.com',
    });
    const result = await resolveGitIdentity('/fake/repo', store, 'github.com', reader);
    expect(result).toEqual({ name: 'The Octocat', email: 'cat@github.com' });
  });

  test('Step 4: uses login as name fallback when entry.name is absent', async () => {
    const reader = mockReader({});
    const store = makeTokenStore({ login: 'octocat', email: 'cat@github.com' });
    const result = await resolveGitIdentity('/fake/repo', store, 'github.com', reader);
    expect(result).toEqual({ name: 'octocat', email: 'cat@github.com' });
  });

  test('Step 4: synthesizes noreply email when entry.email is absent', async () => {
    const reader = mockReader({});
    const store = makeTokenStore({ login: 'octocat' }); // no email
    const result = await resolveGitIdentity('/fake/repo', store, 'github.com', reader);
    expect(result).toEqual({
      name: 'octocat',
      email: 'octocat@users.noreply.github.com',
    });
  });

  test('Step 5: returns null when all sources are empty', async () => {
    const reader = mockReader({});
    const result = await resolveGitIdentity('/fake/repo', null, null, reader);
    expect(result).toBeNull();
  });

  test('Step 5: returns null when tokenStore.get returns null', async () => {
    const reader = mockReader({});
    const store = makeTokenStore(null);
    const result = await resolveGitIdentity('/fake/repo', store, 'github.com', reader);
    expect(result).toBeNull();
  });

  test('Step 4 skipped: no host provided — falls through to null', async () => {
    const reader = mockReader({});
    const store = makeTokenStore({
      login: 'octocat',
      name: 'The Octocat',
      email: 'cat@github.com',
    });
    // host not provided — step 3 skipped even with a valid store
    const result = await resolveGitIdentity('/fake/repo', store, null, reader);
    expect(result).toBeNull();
  });

  test('Step 4 skipped: no tokenStore — falls through to null', async () => {
    const reader = mockReader({});
    const result = await resolveGitIdentity('/fake/repo', null, 'github.com', reader);
    expect(result).toBeNull();
  });

  test('Local (Step 2) wins over global + tokenStore when set', async () => {
    const reader = mockReader({
      'user.name': { local: 'Repo Dev', global: 'Global Dev' },
      'user.email': { local: 'repo@example.com', global: 'global@example.com' },
    });
    const store = makeTokenStore({
      login: 'octocat',
      name: 'The Octocat',
      email: 'cat@github.com',
    });
    const result = await resolveGitIdentity('/fake/repo', store, 'github.com', reader);
    expect(result).toEqual({ name: 'Repo Dev', email: 'repo@example.com' });
  });
});
