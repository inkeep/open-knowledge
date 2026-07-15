import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GhDetectResult } from './gh-detect.ts';
import { resolveAuth } from './resolve-auth.ts';
import { FileBackend } from './token-store.ts';

function makeStore(tmpDir: string) {
  return new FileBackend(join(tmpDir, 'auth.yml'));
}

function ghAvailable(token = 'ghs_test_token'): () => GhDetectResult {
  return () => ({ available: true, token });
}

function ghUnavailable(): () => GhDetectResult {
  return () => ({ available: false });
}

describe('resolveAuth', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-resolve-auth-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Tier A — gh CLI available
  // ---------------------------------------------------------------------------

  test('Tier A: gh available → returns credential.helper=!gh auth git-credential', async () => {
    const store = makeStore(tmpDir);
    const result = await resolveAuth('github.com', store, {}, ghAvailable());
    expect(result.tier).toBe('A');
    expect(result.credentialArgs).toEqual(['-c', 'credential.helper=!gh auth git-credential']);
  });

  test('Tier A takes priority over stored token', async () => {
    const store = makeStore(tmpDir);
    await store.set('github.com', 'alice', 'gho_abc');
    const result = await resolveAuth('github.com', store, {}, ghAvailable());
    expect(result.tier).toBe('A');
  });

  // ---------------------------------------------------------------------------
  // Tier B — stored token (https)
  // ---------------------------------------------------------------------------

  test('Tier B: stored token (https protocol) → credential.helper relay', async () => {
    const store = makeStore(tmpDir);
    await store.set('github.com', 'alice', 'gho_abc', { gitProtocol: 'https' });
    const result = await resolveAuth('github.com', store, {}, ghUnavailable());
    expect(result.tier).toBe('B');
    expect(result.credentialArgs).toEqual([
      '-c',
      'credential.helper=!open-knowledge auth git-credential',
    ]);
  });

  test('Tier B: stored token without gitProtocol defaults to B', async () => {
    const store = makeStore(tmpDir);
    await store.set('github.com', 'alice', 'gho_abc');
    const result = await resolveAuth('github.com', store, {}, ghUnavailable());
    expect(result.tier).toBe('B');
  });

  // ---------------------------------------------------------------------------
  // Tier C — stored token (ssh)
  // ---------------------------------------------------------------------------

  test('Tier C: stored token with ssh protocol', async () => {
    const store = makeStore(tmpDir);
    await store.set('github.com', 'alice', 'gho_abc', { gitProtocol: 'ssh' });
    const result = await resolveAuth('github.com', store, {}, ghUnavailable());
    expect(result.tier).toBe('C');
    expect(result.credentialArgs).toEqual([
      '-c',
      'credential.helper=!open-knowledge auth git-credential',
    ]);
  });

  // ---------------------------------------------------------------------------
  // none — no auth available
  // ---------------------------------------------------------------------------

  test('none: no gh, no stored token', async () => {
    const store = makeStore(tmpDir);
    const result = await resolveAuth('github.com', store, {}, ghUnavailable());
    expect(result.tier).toBe('none');
    expect(result.credentialArgs).toEqual([]);
  });

  test('none: skipGhDetect=true bypasses gh even if available', async () => {
    const store = makeStore(tmpDir);
    const result = await resolveAuth('github.com', store, { skipGhDetect: true }, ghAvailable());
    expect(result.tier).toBe('none');
    expect(result.credentialArgs).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Host isolation
  // ---------------------------------------------------------------------------

  test('Tier A detection is scoped to the requested host', async () => {
    const store = makeStore(tmpDir);
    const seenHosts: (string | undefined)[] = [];
    // gh is authenticated for github.com but not the GHES host.
    const ghGithubComOnly = (host?: string): GhDetectResult => {
      seenHosts.push(host);
      return host === 'ghes.acme.test' ? { available: false } : { available: true, token: 'x' };
    };
    const result = await resolveAuth('ghes.acme.test', store, {}, ghGithubComOnly);
    expect(seenHosts).toEqual(['ghes.acme.test']);
    expect(result.tier).toBe('none');
    const githubResult = await resolveAuth('github.com', store, {}, ghGithubComOnly);
    expect(githubResult.tier).toBe('A');
  });

  test('token for different host returns none', async () => {
    const store = makeStore(tmpDir);
    await store.set('gitlab.com', 'bob', 'glpat_xyz');
    const result = await resolveAuth('github.com', store, {}, ghUnavailable());
    expect(result.tier).toBe('none');
  });

  test('token for correct host returns Tier B', async () => {
    const store = makeStore(tmpDir);
    await store.set('gitlab.com', 'bob', 'glpat_xyz');
    const result = await resolveAuth('gitlab.com', store, {}, ghUnavailable());
    expect(result.tier).toBe('B');
  });
});
