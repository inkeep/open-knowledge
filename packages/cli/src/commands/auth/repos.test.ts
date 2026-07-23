import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { GhDetectResult } from '../../auth/gh-detect.ts';
import { FileBackend } from '../../auth/token-store.ts';
import { resolveReposToken } from './repos.ts';

function makeStore(tmpDir: string) {
  return new FileBackend(join(tmpDir, 'auth.yml'));
}

function ghAvailable(token = 'ghs_test_token'): (host?: string) => GhDetectResult {
  return () => ({ available: true, token });
}

function ghUnavailable(): (host?: string) => GhDetectResult {
  return () => ({ available: false });
}

describe('resolveReposToken', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-resolve-repos-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('gh available → returns the gh token', async () => {
    const store = makeStore(tmpDir);
    const token = await resolveReposToken('github.com', store, ghAvailable('gho_from_gh'));
    expect(token).toBe('gho_from_gh');
  });

  test('gh available takes priority over stored token (regression guard)', async () => {
    const store = makeStore(tmpDir);
    await store.set('github.com', 'alice', 'gho_stored');
    const token = await resolveReposToken('github.com', store, ghAvailable('gho_from_gh'));
    expect(token).toBe('gho_from_gh');
  });

  test('gh unavailable + stored token → returns the stored token', async () => {
    const store = makeStore(tmpDir);
    await store.set('github.com', 'alice', 'gho_stored');
    const token = await resolveReposToken('github.com', store, ghUnavailable());
    expect(token).toBe('gho_stored');
  });

  test('gh unavailable + no stored token → returns null', async () => {
    const store = makeStore(tmpDir);
    const token = await resolveReposToken('github.com', store, ghUnavailable());
    expect(token).toBeNull();
  });

  test('gh returns available:true but empty token → falls through to TokenStore', async () => {
    const store = makeStore(tmpDir);
    await store.set('github.com', 'alice', 'gho_stored');
    const token = await resolveReposToken(
      'github.com',
      store,
      () => ({ available: true, token: '' }) as GhDetectResult,
    );
    expect(token).toBe('gho_stored');
  });

  test('host is forwarded to the gh detector', async () => {
    const seen: (string | undefined)[] = [];
    const store = makeStore(tmpDir);
    await resolveReposToken('ghe.example.com', store, (host) => {
      seen.push(host);
      return { available: false };
    });
    expect(seen).toEqual(['ghe.example.com']);
  });
});
