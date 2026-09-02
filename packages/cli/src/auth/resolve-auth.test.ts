import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ExecFileSyncFn, GhDetectResult } from './gh-detect.ts';
import { detectGh } from './gh-detect.ts';
import { buildCliCredentialHelper, resolveAuth } from './resolve-auth.ts';
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

const SELF: readonly string[] = ['/node', '/cli.mjs'];
const SELF_HELPER = "credential.helper=!'/node' '/cli.mjs' auth git-credential";
const RESET = 'credential.helper=';

describe('buildCliCredentialHelper', () => {
  test('shell-quotes each argv element so a spaced bundle path survives', () => {
    const helper = buildCliCredentialHelper([
      '/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge',
      '/Applications/OpenKnowledge.app/Contents/Resources/cli/dist/cli.mjs',
    ]);
    expect(helper).toBe(
      "credential.helper=!'/Applications/OpenKnowledge.app/Contents/MacOS/OpenKnowledge' '/Applications/OpenKnowledge.app/Contents/Resources/cli/dist/cli.mjs' auth git-credential",
    );
  });
});

describe('resolveAuth', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-resolve-auth-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('Tier A: gh available → reset + self-helper + relayToken (no `!gh` helper)', async () => {
    const store = makeStore(tmpDir);
    const result = await resolveAuth(
      'github.com',
      store,
      { selfCliArgs: SELF },
      ghAvailable('ghs_A'),
    );
    expect(result.tier).toBe('A');
    expect(result.gitConfig).toEqual([RESET, SELF_HELPER]);
    expect(result.relayToken).toEqual({ token: 'ghs_A', host: 'github.com' });
    expect(result.gitConfig.join(' ')).not.toContain('!gh ');
  });

  test('Tier A takes priority over stored token', async () => {
    const store = makeStore(tmpDir);
    await store.set('github.com', 'alice', 'gho_abc');
    const result = await resolveAuth('github.com', store, { selfCliArgs: SELF }, ghAvailable());
    expect(result.tier).toBe('A');
  });

  test('forwards the declared login to detectGh alongside the host', async () => {
    const store = makeStore(tmpDir);
    const seen: [string | undefined, string | undefined][] = [];
    const recorder = (host?: string, opts?: { login?: string }): GhDetectResult => {
      const login = opts?.login;
      seen.push([host, login]);
      return { available: true, token: 't' };
    };
    await resolveAuth('github.com', store, { selfCliArgs: SELF, login: 'alice' }, recorder);
    expect(seen).toEqual([['github.com', 'alice']]);
  });

  test('relayToken names the account that produced the token', async () => {
    const store = makeStore(tmpDir);
    const result = await resolveAuth(
      'github.com',
      store,
      { selfCliArgs: SELF, login: 'alice' },
      () => ({
        available: true,
        token: 'ghs_alice',
        resolvedLogin: 'alice',
        fallback: false,
      }),
    );
    expect(result.relayToken).toEqual({ token: 'ghs_alice', host: 'github.com', login: 'alice' });
  });

  test('a declared login gh cannot serve falls back to the active token, never to tier none', async () => {
    const store = makeStore(tmpDir);
    const calls: string[] = [];
    const exec = ((cmd: string, args: readonly string[]) => {
      const argv = `${cmd} ${args.join(' ')}`;
      calls.push(argv);
      if (argv === 'gh auth token --hostname github.com') return 'ghs_bob_active';
      throw new Error(`gh exited 1: ${argv}`);
    }) as unknown as ExecFileSyncFn;
    const result = await resolveAuth(
      'github.com',
      store,
      { selfCliArgs: SELF, login: 'alice' },
      (host, opts) => detectGh(host, { login: opts?.login, _exec: exec, _fileExists: () => false }),
    );
    expect(result.tier).toBe('A');
    expect(result.relayToken).toEqual({ token: 'ghs_bob_active', host: 'github.com' });
    expect(result.relayToken).not.toHaveProperty('login');
    expect(calls).toEqual([
      'gh auth token --hostname github.com --user alice',
      'gh auth token --hostname github.com',
    ]);
  });

  test('Tier B: stored token (https protocol) → reset + self-helper, no relayToken', async () => {
    const store = makeStore(tmpDir);
    await store.set('github.com', 'alice', 'gho_abc', { gitProtocol: 'https' });
    const result = await resolveAuth('github.com', store, { selfCliArgs: SELF }, ghUnavailable());
    expect(result.tier).toBe('B');
    expect(result.gitConfig).toEqual([RESET, SELF_HELPER]);
    expect(result.relayToken).toBeUndefined();
  });

  test('Tier B: stored token without gitProtocol defaults to B', async () => {
    const store = makeStore(tmpDir);
    await store.set('github.com', 'alice', 'gho_abc');
    const result = await resolveAuth('github.com', store, { selfCliArgs: SELF }, ghUnavailable());
    expect(result.tier).toBe('B');
  });

  test('Tier C: stored token with ssh protocol', async () => {
    const store = makeStore(tmpDir);
    await store.set('github.com', 'alice', 'gho_abc', { gitProtocol: 'ssh' });
    const result = await resolveAuth('github.com', store, { selfCliArgs: SELF }, ghUnavailable());
    expect(result.tier).toBe('C');
    expect(result.gitConfig).toEqual([RESET, SELF_HELPER]);
    expect(result.relayToken).toBeUndefined();
  });

  test('authenticated tiers prepend an empty credential.helper reset', async () => {
    const store = makeStore(tmpDir);
    await store.set('github.com', 'alice', 'gho_abc');
    const result = await resolveAuth('github.com', store, { selfCliArgs: SELF }, ghUnavailable());
    expect(result.gitConfig[0]).toBe(RESET);
  });

  test('default selfCliArgs falls back to the bare open-knowledge helper', async () => {
    const store = makeStore(tmpDir);
    await store.set('github.com', 'alice', 'gho_abc');
    const result = await resolveAuth('github.com', store, {}, ghUnavailable());
    expect(result.gitConfig).toEqual([
      RESET,
      "credential.helper=!'open-knowledge' auth git-credential",
    ]);
  });

  test('none: no gh, no stored token → empty gitConfig, no relayToken', async () => {
    const store = makeStore(tmpDir);
    const result = await resolveAuth('github.com', store, { selfCliArgs: SELF }, ghUnavailable());
    expect(result.tier).toBe('none');
    expect(result.gitConfig).toEqual([]);
    expect(result.relayToken).toBeUndefined();
  });

  test('none: skipGhDetect=true bypasses gh even if available', async () => {
    const store = makeStore(tmpDir);
    const result = await resolveAuth(
      'github.com',
      store,
      { skipGhDetect: true, selfCliArgs: SELF },
      ghAvailable(),
    );
    expect(result.tier).toBe('none');
    expect(result.gitConfig).toEqual([]);
  });

  test('Tier A detection is scoped to the requested host', async () => {
    const store = makeStore(tmpDir);
    const seenHosts: (string | undefined)[] = [];
    const ghGithubComOnly = (host?: string): GhDetectResult => {
      seenHosts.push(host);
      return host === 'ghes.acme.test' ? { available: false } : { available: true, token: 'x' };
    };
    const result = await resolveAuth(
      'ghes.acme.test',
      store,
      { selfCliArgs: SELF },
      ghGithubComOnly,
    );
    expect(seenHosts).toEqual(['ghes.acme.test']);
    expect(result.tier).toBe('none');
    const githubResult = await resolveAuth(
      'github.com',
      store,
      { selfCliArgs: SELF },
      ghGithubComOnly,
    );
    expect(githubResult.tier).toBe('A');
    expect(githubResult.relayToken).toEqual({ token: 'x', host: 'github.com' });
  });

  test('token for different host returns none', async () => {
    const store = makeStore(tmpDir);
    await store.set('gitlab.com', 'bob', 'glpat_xyz');
    const result = await resolveAuth('github.com', store, { selfCliArgs: SELF }, ghUnavailable());
    expect(result.tier).toBe('none');
  });

  test('token for correct host returns Tier B', async () => {
    const store = makeStore(tmpDir);
    await store.set('gitlab.com', 'bob', 'glpat_xyz');
    const result = await resolveAuth('gitlab.com', store, { selfCliArgs: SELF }, ghUnavailable());
    expect(result.tier).toBe('B');
  });
});
