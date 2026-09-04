import { describe, expect, test } from 'vitest';
import {
  type GitConfigReader,
  type GitIdentityTokenStore,
  resolveGitIdentity,
} from './git-identity.ts';

function mockReader(values: Partial<Record<string, string | null>>): GitConfigReader {
  return (_dir, key) => values[key] ?? null;
}

function makeTokenStore(entry: { login: string; name?: string; email?: string } | null) {
  const store: GitIdentityTokenStore = {
    get: async (_host: string) => entry,
  };
  return store;
}

describe('resolveGitIdentity chain order', () => {
  test('Step 1: returns the effective git config identity when name + email are both set', async () => {
    const reader = mockReader({
      'user.name': 'Config Dev',
      'user.email': 'config@example.com',
    });
    const result = await resolveGitIdentity('/fake/repo', null, null, reader);
    expect(result).toEqual({ name: 'Config Dev', email: 'config@example.com' });
  });

  test('Step 1 partial: name only — falls through to token store', async () => {
    const reader = mockReader({ 'user.name': 'Config Dev' });
    const store = makeTokenStore({
      login: 'octocat',
      name: 'The Octocat',
      email: 'cat@github.com',
    });
    const result = await resolveGitIdentity('/fake/repo', store, 'github.com', reader);
    expect(result).toEqual({ name: 'The Octocat', email: 'cat@github.com' });
  });

  test('Step 1 partial: email only — falls through to null when no token store', async () => {
    const reader = mockReader({ 'user.email': 'config@example.com' });
    const result = await resolveGitIdentity('/fake/repo', null, null, reader);
    expect(result).toBeNull();
  });

  test('Step 1 partial: name only — falls through to null when no token store', async () => {
    const reader = mockReader({ 'user.name': 'Config Dev' });
    const result = await resolveGitIdentity('/fake/repo', null, null, reader);
    expect(result).toBeNull();
  });

  test('Step 2: uses tokenStore when git config is empty', async () => {
    const reader = mockReader({});
    const store = makeTokenStore({
      login: 'octocat',
      name: 'The Octocat',
      email: 'cat@github.com',
    });
    const result = await resolveGitIdentity('/fake/repo', store, 'github.com', reader);
    expect(result).toEqual({ name: 'The Octocat', email: 'cat@github.com' });
  });

  test('Step 2: uses login as name fallback when entry.name is absent', async () => {
    const reader = mockReader({});
    const store = makeTokenStore({ login: 'octocat', email: 'cat@github.com' });
    const result = await resolveGitIdentity('/fake/repo', store, 'github.com', reader);
    expect(result).toEqual({ name: 'octocat', email: 'cat@github.com' });
  });

  test('Step 2: synthesizes noreply email when entry.email is absent', async () => {
    const reader = mockReader({});
    const store = makeTokenStore({ login: 'octocat' });
    const result = await resolveGitIdentity('/fake/repo', store, 'github.com', reader);
    expect(result).toEqual({
      name: 'octocat',
      email: 'octocat@users.noreply.github.com',
    });
  });

  test('Step 3: returns null when all sources are empty', async () => {
    const reader = mockReader({});
    const result = await resolveGitIdentity('/fake/repo', null, null, reader);
    expect(result).toBeNull();
  });

  test('Step 3: returns null when tokenStore.get returns null', async () => {
    const reader = mockReader({});
    const store = makeTokenStore(null);
    const result = await resolveGitIdentity('/fake/repo', store, 'github.com', reader);
    expect(result).toBeNull();
  });

  test('Step 2 skipped: no host provided — falls through to null', async () => {
    const reader = mockReader({});
    const store = makeTokenStore({
      login: 'octocat',
      name: 'The Octocat',
      email: 'cat@github.com',
    });
    const result = await resolveGitIdentity('/fake/repo', store, null, reader);
    expect(result).toBeNull();
  });

  test('Step 2 skipped: no tokenStore — falls through to null', async () => {
    const reader = mockReader({});
    const result = await resolveGitIdentity('/fake/repo', null, 'github.com', reader);
    expect(result).toBeNull();
  });

  test('Git config (Step 1) wins over tokenStore when set', async () => {
    const reader = mockReader({
      'user.name': 'Repo Dev',
      'user.email': 'repo@example.com',
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
