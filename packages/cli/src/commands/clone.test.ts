import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Config } from '@inkeep/open-knowledge-server';
import simpleGit, { type SimpleGitOptions } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, test } from 'vitest';
import type { ExecFileSyncFn, GhDetectResult } from '../auth/gh-detect.ts';
import { detectGh } from '../auth/gh-detect.ts';
import { FileBackend, type TokenStore } from '../auth/token-store.ts';
import { OK_DIR } from '../constants.ts';
import {
  buildCloneArgs,
  buildCloneAuthEnv,
  buildCloneEnv,
  buildCloneGitOptions,
  cloneWithBranchFallback,
  emitCloneFailure,
  ensureOkExcludedFromGit,
  formatCloneAuthFailure,
  formatDeclaredMissWarning,
  handleCloneFailure,
  isBranchNotFoundError,
  resolveCloneAuth,
  resolveClonePrincipal,
  resolveCloneUrl,
  resolveSelfCliArgs,
  runClone,
  shouldSkipAuthForPublicRepo,
} from './clone.ts';

describe('resolveSelfCliArgs', () => {
  it('returns [execPath, cliEntry] from argv', () => {
    expect(resolveSelfCliArgs(['/usr/bin/node', '/app/cli.mjs', 'clone'], '/usr/bin/node')).toEqual(
      ['/usr/bin/node', '/app/cli.mjs'],
    );
  });

  it('falls back to [execPath] when argv has no entry script', () => {
    expect(resolveSelfCliArgs(['/usr/bin/node'], '/usr/bin/node')).toEqual(['/usr/bin/node']);
  });

  it('treats an empty-string argv[1] as absent and falls back to [execPath]', () => {
    expect(resolveSelfCliArgs(['/usr/bin/node', ''], '/usr/bin/node')).toEqual(['/usr/bin/node']);
  });
});

describe('resolveClonePrincipal', () => {
  const storeReturning = (entry: { login: string; token: string } | null): TokenStore =>
    ({ get: async () => entry }) as unknown as TokenStore;

  test('returns the stored login when present', async () => {
    const store = storeReturning({ login: 'alice', token: 't' });
    expect(await resolveClonePrincipal(store, 'github.com')).toBe('alice');
  });

  test('returns null when no entry is stored (hint omitted, no placeholder)', async () => {
    expect(await resolveClonePrincipal(storeReturning(null), 'github.com')).toBeNull();
  });

  test('treats the "unknown" sentinel login as not-known', async () => {
    const store = storeReturning({ login: 'unknown', token: 't' });
    expect(await resolveClonePrincipal(store, 'github.com')).toBeNull();
  });
});

describe('resolveCloneUrl', () => {
  const parsed = (owner: string, name: string, hostname = 'github.com') => ({
    hostname,
    owner,
    name,
  });

  test('reconstructs a canonical https URL for owner/repo shorthand', () => {
    expect(resolveCloneUrl('inkeep/playbooks', parsed('inkeep', 'playbooks'))).toBe(
      'https://github.com/inkeep/playbooks',
    );
  });

  test('passes a full https URL through unchanged', () => {
    const url = 'https://github.com/inkeep/playbooks.git';
    expect(resolveCloneUrl(url, parsed('inkeep', 'playbooks'))).toBe(url);
  });

  test('passes an SSH/SCP URL through unchanged', () => {
    const url = 'git@github.com:inkeep/playbooks.git';
    expect(resolveCloneUrl(url, parsed('inkeep', 'playbooks'))).toBe(url);
  });

  test('passes an @-less SCP/GHES SSH URL through unchanged (not rewritten to https)', () => {
    const url = 'host.ghe.com:inkeep/playbooks.git';
    expect(resolveCloneUrl(url, parsed('inkeep', 'playbooks', 'host.ghe.com'))).toBe(url);
  });

  test('reconstructs shorthand with a trailing .git suffix', () => {
    expect(resolveCloneUrl('inkeep/playbooks.git', parsed('inkeep', 'playbooks'))).toBe(
      'https://github.com/inkeep/playbooks',
    );
  });

  test('passes a userinfo https URL through unchanged (the stored remote keeps the declared account)', () => {
    const url = 'https://alice@github.com/inkeep/playbooks';
    expect(resolveCloneUrl(url, parsed('inkeep', 'playbooks'))).toBe(url);
  });
});

describe('resolveCloneAuth', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-clone-auth-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const SELF: readonly string[] = ['/node', '/cli.mjs'];
  const makeStore = () => new FileBackend(join(tmpDir, 'auth.yml'));

  function scriptedGh(script: Record<string, string>): {
    detect: (host?: string, options?: { login?: string }) => GhDetectResult;
    calls: string[];
  } {
    const calls: string[] = [];
    const exec = ((cmd: string, args: readonly string[]) => {
      const argv = `${cmd} ${args.join(' ')}`;
      calls.push(argv);
      const out = script[argv];
      if (out === undefined) throw new Error(`gh exited 1: ${argv}`);
      return out;
    }) as unknown as ExecFileSyncFn;
    return {
      detect: (host?: string, options?: { login?: string }) =>
        detectGh(host, { login: options?.login, _exec: exec, _fileExists: () => false }),
      calls,
    };
  }

  test('a userinfo clone URL authenticates as that account', async () => {
    const gh = scriptedGh({
      'gh auth token --hostname github.com --user alice': 'ghs_alice',
      'gh auth token --hostname github.com': 'ghs_bob_active',
    });
    const { auth: resolved, declaredMiss } = await resolveCloneAuth(
      'https://alice@github.com/o/r',
      makeStore(),
      {
        selfCliArgs: SELF,
        _detectGhFn: gh.detect,
      },
    );
    expect(resolved.tier).toBe('A');
    expect(resolved.relayToken).toEqual({ token: 'ghs_alice', host: 'github.com', login: 'alice' });
    expect(gh.calls).toEqual(['gh auth token --hostname github.com --user alice']);
    expect(declaredMiss).toBeUndefined();
  });

  test('a credential.<url>.username declaration rides into gh the same way', async () => {
    const gh = scriptedGh({
      'gh auth token --hostname github.com --user workbot': 'ghs_workbot',
    });
    const { auth: resolved, declaredMiss } = await resolveCloneAuth(
      'https://github.com/bigcorp/secret',
      makeStore(),
      {
        selfCliArgs: SELF,
        _detectGhFn: gh.detect,
        _readCredentialUrlMatch: () =>
          'credential.helper osxkeychain\ncredential.username workbot\n',
      },
    );
    expect(declaredMiss).toBeUndefined();
    expect(resolved.relayToken).toEqual({
      token: 'ghs_workbot',
      host: 'github.com',
      login: 'workbot',
    });
    expect(gh.calls).toEqual(['gh auth token --hostname github.com --user workbot']);
  });

  test('no declared account: gh is asked without --user — the repo owner never becomes an account selector', async () => {
    const gh = scriptedGh({ 'gh auth token --hostname github.com': 'ghs_active' });
    const { auth: resolved, declaredMiss } = await resolveCloneAuth(
      'https://github.com/inkeep/some-repo',
      makeStore(),
      {
        selfCliArgs: SELF,
        _detectGhFn: gh.detect,
        _readCredentialUrlMatch: () => null,
      },
    );
    expect(resolved.tier).toBe('A');
    expect(resolved.relayToken).toEqual({ token: 'ghs_active', host: 'github.com' });
    expect(gh.calls).toEqual(['gh auth token --hostname github.com']);
    expect(declaredMiss).toBeUndefined();
  });

  test('an unparseable clone URL is rejected the way runClone rejects it', async () => {
    await expect(resolveCloneAuth('not-a-url', makeStore(), { selfCliArgs: SELF })).rejects.toThrow(
      'Invalid git URL: not-a-url',
    );
  });

  test('a declared account gh cannot serve falls back to the active token, never to tier none', async () => {
    const gh = scriptedGh({ 'gh auth token --hostname github.com': 'ghs_bob_active' });
    const { auth: resolved, declaredMiss } = await resolveCloneAuth(
      'https://alice@github.com/o/r',
      makeStore(),
      {
        selfCliArgs: SELF,
        _detectGhFn: gh.detect,
      },
    );
    expect(resolved.tier).toBe('A');
    expect(resolved.relayToken).toEqual({ token: 'ghs_bob_active', host: 'github.com' });
    expect(resolved.relayToken).not.toHaveProperty('login');
    expect(gh.calls).toEqual([
      'gh auth token --hostname github.com --user alice',
      'gh auth token --hostname github.com',
    ]);
    expect(declaredMiss).toEqual({ declaredLogin: 'alice', declaredSource: 'remote-url' });
  });

  test('a resolved login differing only in case is not a declared miss', async () => {
    const { auth: resolved, declaredMiss } = await resolveCloneAuth(
      'https://Alice@github.com/o/r',
      makeStore(),
      {
        selfCliArgs: SELF,
        _detectGhFn: () => ({
          available: true,
          token: 'ghs_alice',
          resolvedLogin: 'alice',
          fallback: false,
        }),
      },
    );
    expect(resolved.tier).toBe('A');
    expect(resolved.relayToken?.login).toBe('alice');
    expect(declaredMiss).toBeUndefined();
  });

  test('a credential-config declaration gh cannot serve reports the miss with its mechanism', async () => {
    const gh = scriptedGh({ 'gh auth token --hostname github.com': 'ghs_bob_active' });
    const { declaredMiss } = await resolveCloneAuth(
      'https://github.com/bigcorp/secret',
      makeStore(),
      {
        selfCliArgs: SELF,
        _detectGhFn: gh.detect,
        _readCredentialUrlMatch: () =>
          'credential.helper osxkeychain\ncredential.username workbot\n',
      },
    );
    expect(declaredMiss).toEqual({ declaredLogin: 'workbot', declaredSource: 'credential-config' });
  });

  test('a non-canonical host spelling resolves gh and the relay against the normalized host', async () => {
    const gh = scriptedGh({
      'gh auth token --hostname github.com --user alice': 'ghs_alice',
    });
    const { auth: resolved } = await resolveCloneAuth(
      'https://alice@WWW.GitHub.com/o/r',
      makeStore(),
      {
        selfCliArgs: SELF,
        _detectGhFn: gh.detect,
      },
    );
    expect(resolved.relayToken).toEqual({ token: 'ghs_alice', host: 'github.com', login: 'alice' });
    expect(gh.calls).toEqual(['gh auth token --hostname github.com --user alice']);
  });

  test('an unparseable URL with an embedded credential is not echoed into the error', async () => {
    await expect(
      resolveCloneAuth('https://user:s3cretpw@%%%bogus', makeStore(), { selfCliArgs: SELF }),
    ).rejects.toThrow(/^(?!.*s3cretpw).*Invalid git URL/);
  });
});

describe('formatDeclaredMissWarning', () => {
  test('names the remote-URL mechanism', () => {
    expect(
      formatDeclaredMissWarning({
        declaredLogin: 'alice',
        declaredSource: 'remote-url',
      }),
    ).toContain(
      "\u26a0 The clone URL names alice, but the GitHub CLI couldn't confirm that account — the clone used its active account.\n",
    );
  });

  test('names the credential-config mechanism', () => {
    const line = formatDeclaredMissWarning({
      declaredLogin: 'workbot',
      declaredSource: 'credential-config',
    });
    expect(line).toContain('Your Git credential configuration names workbot');
    expect(line?.endsWith('\n')).toBe(true);
  });

  test('an unrecognized mechanism degrades to the generic wording', () => {
    const line = formatDeclaredMissWarning({
      declaredLogin: 'alice',
      declaredSource: 'far-future-mechanism' as 'remote-url',
    });
    expect(line).toContain('Your Git configuration names alice');
    expect(line).not.toContain('clone URL');
    expect(line).not.toContain('credential configuration');
  });

  test('an honored declaration produces no warning', () => {
    expect(formatDeclaredMissWarning(undefined)).toBeNull();
  });

  test("the copy asserts only that the account wasn't confirmed", () => {
    const line = formatDeclaredMissWarning({
      declaredLogin: 'alice',
      declaredSource: 'remote-url',
    });
    expect(line).toContain("couldn't confirm that account");
    expect(line).not.toContain('credentials couldn');
  });

  test('the warning names a command that settles the false-alarm cases', () => {
    const line = formatDeclaredMissWarning({
      declaredLogin: 'alice',
      declaredSource: 'remote-url',
    });
    expect(line).toContain('gh auth status');
    expect(line).toContain('2.40');
    expect(line).toContain('If alice is listed as active');
  });
});

describe('handleCloneFailure', () => {
  const collectors = () => {
    const emitted: Record<string, unknown>[] = [];
    const stderr: string[] = [];
    return {
      emitted,
      stderr,
      emit: (e: Record<string, unknown>) => emitted.push(e),
      printStderr: (t: string) => stderr.push(t),
    };
  };

  test('403 resolves the principal and threads it into the access-denied hint', async () => {
    const c = collectors();
    let resolvedHost: string | null = null;
    await handleCloneFailure({
      error: new Error('remote: HTTP 403 Forbidden'),
      url: 'https://github.com/owner/repo',
      branch: 'main',
      json: false,
      emit: c.emit,
      printStderr: c.printStderr,
      resolvePrincipal: async (host) => {
        resolvedHost = host;
        return 'alice';
      },
    });
    expect(resolvedHost).toBe('github.com');
    expect(c.stderr.join('')).toContain('@alice');
    expect(c.stderr.join('')).not.toContain('ok auth login');
  });

  test('non-403 auth failure does not resolve the principal (skips keyring init)', async () => {
    const c = collectors();
    let called = false;
    await handleCloneFailure({
      error: new Error('fatal: could not read Username for https://github.com'),
      url: 'https://github.com/owner/repo',
      branch: 'main',
      json: false,
      emit: c.emit,
      printStderr: c.printStderr,
      resolvePrincipal: async () => {
        called = true;
        return 'alice';
      },
    });
    expect(called).toBe(false);
    expect(c.stderr.join('')).toContain('ok auth login');
  });

  test('--json keeps the raw {type:error,message} wire shape and skips principal resolution', async () => {
    const c = collectors();
    let called = false;
    await handleCloneFailure({
      error: new Error('remote: HTTP 403 Forbidden'),
      url: 'https://github.com/owner/repo',
      branch: null,
      json: true,
      emit: c.emit,
      printStderr: c.printStderr,
      resolvePrincipal: async () => {
        called = true;
        return 'alice';
      },
    });
    expect(called).toBe(false);
    expect(c.emitted).toEqual([{ type: 'error', message: 'remote: HTTP 403 Forbidden' }]);
    expect(c.stderr).toEqual([]);
  });

  test('403 with gh-resolved auth names the resolved login and skips the stored principal', async () => {
    const c = collectors();
    let called = false;
    await handleCloneFailure({
      error: new Error('remote: HTTP 403 Forbidden'),
      url: 'https://github.com/owner/repo',
      branch: null,
      json: false,
      emit: c.emit,
      printStderr: c.printStderr,
      auth: { tier: 'A', login: 'bob' },
      resolvePrincipal: async () => {
        called = true;
        return 'stored-alice';
      },
    });
    expect(called).toBe(false);
    expect(c.stderr.join('')).toContain('@bob');
    expect(c.stderr.join('')).not.toContain('stored-alice');
  });

  test('403 with an unnamed gh credential omits the hint rather than guessing', async () => {
    const c = collectors();
    let called = false;
    await handleCloneFailure({
      error: new Error('remote: HTTP 403 Forbidden'),
      url: 'https://github.com/owner/repo',
      branch: null,
      json: false,
      emit: c.emit,
      printStderr: c.printStderr,
      auth: { tier: 'A' },
      resolvePrincipal: async () => {
        called = true;
        return 'stored-alice';
      },
    });
    expect(called).toBe(false);
    expect(c.stderr.join('')).not.toContain('signed in as');
  });

  test('the 404 masquerade names the account the clone used when known', async () => {
    const c = collectors();
    await handleCloneFailure({
      error: new Error("fatal: repository 'https://github.com/o/private.git/' not found"),
      url: 'https://github.com/o/private',
      branch: null,
      json: false,
      emit: c.emit,
      printStderr: c.printStderr,
      auth: { tier: 'A', login: 'bob' },
    });
    expect(c.stderr.join('')).toContain('Authenticated as bob.');
  });

  test('403 on a credential-less clone names nobody and skips the stored principal', async () => {
    const c = collectors();
    let called = false;
    await handleCloneFailure({
      error: new Error('remote: HTTP 403 Forbidden'),
      url: 'https://github.com/owner/repo',
      branch: null,
      json: false,
      emit: c.emit,
      printStderr: c.printStderr,
      auth: { tier: 'none' },
      resolvePrincipal: async () => {
        called = true;
        return 'stored-alice';
      },
    });
    expect(called).toBe(false);
    expect(c.stderr.join('')).not.toContain('signed in as');
    expect(c.stderr.join('')).not.toContain('stored-alice');
  });
});

describe('buildCloneEnv', () => {
  test('inherits PATH and HOME from the source env', () => {
    const env = buildCloneEnv({ PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/Users/me' });
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin');
    expect(env.HOME).toBe('/Users/me');
  });

  test('pins GIT_TERMINAL_PROMPT=0 and LANG/LC_ALL=C, overriding inherited locale', () => {
    const env = buildCloneEnv({ PATH: '/usr/bin', LANG: 'fr_FR.UTF-8', LC_ALL: 'fr_FR.UTF-8' });
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.LANG).toBe('C');
    expect(env.LC_ALL).toBe('C');
  });

  test('drops undefined entries (no `undefined` strings reach the child env)', () => {
    const env = buildCloneEnv({ PATH: '/usr/bin', SOME_UNSET: undefined });
    expect('SOME_UNSET' in env).toBe(false);
  });

  test('inherits ELECTRON_RUN_AS_NODE so the packaged helper re-execs as Node', () => {
    const env = buildCloneEnv({ PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: '1' });
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1');
  });
});

describe('buildCloneAuthEnv', () => {
  test('sets OK_GH_TOKEN and OK_GH_TOKEN_HOST when a relay token is present', () => {
    const env = buildCloneAuthEnv(
      { relayToken: { token: 'ghs_relay', host: 'github.com' } },
      { PATH: '/usr/bin' },
    );
    expect(env.OK_GH_TOKEN).toBe('ghs_relay');
    expect(env.OK_GH_TOKEN_HOST).toBe('github.com');
  });

  test('sets no relay vars when relayToken is absent (Tier B/C/none)', () => {
    const env = buildCloneAuthEnv({}, { PATH: '/usr/bin' });
    expect('OK_GH_TOKEN' in env).toBe(false);
    expect('OK_GH_TOKEN_HOST' in env).toBe(false);
  });

  test('strips an inherited OK_GH_TOKEN when no relay token was resolved', () => {
    const env = buildCloneAuthEnv(
      {},
      { PATH: '/usr/bin', OK_GH_TOKEN: 'ghs_stale', OK_GH_TOKEN_HOST: 'github.com' },
    );
    expect('OK_GH_TOKEN' in env).toBe(false);
    expect('OK_GH_TOKEN_HOST' in env).toBe(false);
  });

  test('a resolved relay token overrides an inherited stale one', () => {
    const env = buildCloneAuthEnv(
      { relayToken: { token: 'ghs_fresh', host: 'ghes.acme.test' } },
      { PATH: '/usr/bin', OK_GH_TOKEN: 'ghs_stale', OK_GH_TOKEN_HOST: 'github.com' },
    );
    expect(env.OK_GH_TOKEN).toBe('ghs_fresh');
    expect(env.OK_GH_TOKEN_HOST).toBe('ghes.acme.test');
  });

  test('relays OK_GH_TOKEN_LOGIN when the relay token names its account', () => {
    const env = buildCloneAuthEnv(
      { relayToken: { token: 'ghs_relay', host: 'github.com', login: 'alice' } },
      { PATH: '/usr/bin' },
    );
    expect(env.OK_GH_TOKEN_LOGIN).toBe('alice');
  });

  test('an anonymous relay token sets no login var and strips an inherited one', () => {
    const env = buildCloneAuthEnv(
      { relayToken: { token: 'ghs_relay', host: 'github.com' } },
      { PATH: '/usr/bin', OK_GH_TOKEN_LOGIN: 'stale-name' },
    );
    expect(env.OK_GH_TOKEN).toBe('ghs_relay');
    expect('OK_GH_TOKEN_LOGIN' in env).toBe(false);
  });

  test('strips an inherited OK_GH_TOKEN_LOGIN when no relay token was resolved', () => {
    const env = buildCloneAuthEnv({}, { PATH: '/usr/bin', OK_GH_TOKEN_LOGIN: 'stale-name' });
    expect('OK_GH_TOKEN_LOGIN' in env).toBe(false);
  });
});

describe('buildCloneGitOptions', () => {
  test('opts into the env-based unsafe flags so the user PAGER/SSH/askpass/editor env is honored', () => {
    const o = buildCloneGitOptions('/work/dir', ['credential.helper=!gh auth git-credential']);
    expect(o.baseDir).toBe('/work/dir');
    expect(o.config).toEqual(['credential.helper=!gh auth git-credential']);
    expect(o.unsafe).toEqual({
      allowUnsafeCredentialHelper: true,
      allowUnsafePager: true,
      allowUnsafeSshCommand: true,
      allowUnsafeAskPass: true,
      allowUnsafeEditor: true,
    });
  });

  test('passes an empty config through unchanged (no credential helper injected)', () => {
    const o = buildCloneGitOptions('/work/dir', []);
    expect(o.config).toEqual([]);
    expect(o.unsafe?.allowUnsafePager).toBe(true);
  });
});

describe('buildCloneGitOptions — simple-git EDITOR env guard', () => {
  const editorEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    EDITOR: 'vim',
  };

  it('negative control: without allowUnsafeEditor the guard rejects when EDITOR is set', async () => {
    const git = simpleGit({ baseDir: tmpdir() } as Partial<SimpleGitOptions>).env(editorEnv);
    let err: unknown;
    try {
      await git.raw(['--version']);
    } catch (e) {
      err = e;
    }
    expect(String(err instanceof Error ? err.message : err)).toContain('allowUnsafeEditor');
  });

  it('buildCloneGitOptions honors EDITOR — git runs instead of tripping the guard', async () => {
    const git = simpleGit(buildCloneGitOptions(tmpdir(), []) as Partial<SimpleGitOptions>).env(
      editorEnv,
    );
    const out = await git.raw(['--version']);
    expect(out).toContain('git version');
  });
});

describe('shouldSkipAuthForPublicRepo', () => {
  test('https + github.com + isPublic=true → true (anonymous clone path)', () => {
    expect(shouldSkipAuthForPublicRepo('https', 'github.com', true)).toBe(true);
  });

  test('https + github.com + isPublic=false → false (private, needs auth)', () => {
    expect(shouldSkipAuthForPublicRepo('https', 'github.com', false)).toBe(false);
  });

  test('https + GHES hostname + isPublic=true → false (GHES uses different auth posture)', () => {
    expect(shouldSkipAuthForPublicRepo('https', 'github.acme.com', true)).toBe(false);
  });

  test('hostname matches by exact equality, not endsWith — `evilgithub.com` does not bypass auth', () => {
    expect(shouldSkipAuthForPublicRepo('https', 'evilgithub.com', true)).toBe(false);
  });

  test('hostname matches by exact equality, not subdomain — `gist.github.com` does not bypass auth', () => {
    expect(shouldSkipAuthForPublicRepo('https', 'gist.github.com', true)).toBe(false);
  });

  test('ssh + github.com + isPublic=true → false (SSH keeps key material in play)', () => {
    expect(shouldSkipAuthForPublicRepo('ssh', 'github.com', true)).toBe(false);
  });

  test('git protocol + github.com + isPublic=true → false (only https opts in)', () => {
    expect(shouldSkipAuthForPublicRepo('git', 'github.com', true)).toBe(false);
  });
});

describe('ensureOkExcludedFromGit', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = resolve(
      tmpdir(),
      `clone-exclude-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, '.git', 'info'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns "no-exclude" when .git/info/exclude does not exist', () => {
    rmSync(join(testDir, '.git'), { recursive: true, force: true });
    expect(ensureOkExcludedFromGit(testDir)).toBe('no-exclude');
  });

  it('appends OK_DIR/ to a fresh exclude file with default git template', () => {
    const excludePath = join(testDir, '.git', 'info', 'exclude');
    const defaultTemplate = `# git ls-files --others --exclude-from=.git/info/exclude
# Lines that start with '#' are comments.
# For a project mostly in C, the following would be a good set of
# exclude patterns (uncomment them if you want to use them):
# *.[oa]
# *~
`;
    writeFileSync(excludePath, defaultTemplate, 'utf-8');

    expect(ensureOkExcludedFromGit(testDir)).toBe('appended');
    const after = readFileSync(excludePath, 'utf-8');
    expect(after).toContain(`${OK_DIR}/`);
    expect(after.startsWith(defaultTemplate)).toBe(true);
  });

  it('appends OK_DIR/ to an empty exclude file', () => {
    const excludePath = join(testDir, '.git', 'info', 'exclude');
    writeFileSync(excludePath, '', 'utf-8');

    expect(ensureOkExcludedFromGit(testDir)).toBe('appended');
    expect(readFileSync(excludePath, 'utf-8')).toBe(`${OK_DIR}/\n`);
  });

  it('inserts a newline before appending when existing file has no trailing newline', () => {
    const excludePath = join(testDir, '.git', 'info', 'exclude');
    writeFileSync(excludePath, '*.tmp', 'utf-8');

    expect(ensureOkExcludedFromGit(testDir)).toBe('appended');
    expect(readFileSync(excludePath, 'utf-8')).toBe(`*.tmp\n${OK_DIR}/\n`);
  });

  it('is idempotent — re-running returns "already-present"', () => {
    const excludePath = join(testDir, '.git', 'info', 'exclude');
    writeFileSync(excludePath, `${OK_DIR}/\n`, 'utf-8');

    expect(ensureOkExcludedFromGit(testDir)).toBe('already-present');
    expect(readFileSync(excludePath, 'utf-8')).toBe(`${OK_DIR}/\n`);
  });

  it('recognizes leading-slash and no-trailing-slash variants', () => {
    const excludePath = join(testDir, '.git', 'info', 'exclude');
    for (const variant of [OK_DIR, `/${OK_DIR}`, `/${OK_DIR}/`]) {
      writeFileSync(excludePath, `${variant}\n`, 'utf-8');
      expect(ensureOkExcludedFromGit(testDir)).toBe('already-present');
    }
  });

  it('writes to the COMMON-dir info/exclude when run inside a linked worktree (bug-fix case)', () => {
    const mainRepoDir = resolve(
      tmpdir(),
      `clone-exclude-main-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const linkedDir = resolve(
      tmpdir(),
      `clone-exclude-linked-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(mainRepoDir, { recursive: true });
    execFileSync('git', ['init', '--initial-branch=main'], {
      cwd: mainRepoDir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: mainRepoDir });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: mainRepoDir });
    writeFileSync(join(mainRepoDir, 'README.md'), '# r\n', 'utf-8');
    execFileSync('git', ['add', '.'], { cwd: mainRepoDir });
    execFileSync('git', ['commit', '-m', 'init'], {
      cwd: mainRepoDir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    execFileSync('git', ['worktree', 'add', '-b', 'feature', linkedDir], {
      cwd: mainRepoDir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    try {
      const dotGit = readFileSync(join(linkedDir, '.git'), 'utf-8');
      expect(dotGit.startsWith('gitdir:')).toBe(true);

      const result = ensureOkExcludedFromGit(linkedDir);
      expect(result).toBe('appended');

      const mainExclude = readFileSync(join(mainRepoDir, '.git', 'info', 'exclude'), 'utf-8');
      expect(mainExclude).toContain(`${OK_DIR}/`);
    } finally {
      rmSync(linkedDir, { recursive: true, force: true });
      rmSync(mainRepoDir, { recursive: true, force: true });
    }
  });
});

describe('buildCloneArgs', () => {
  test('returns just --progress when no branch is given', () => {
    expect(buildCloneArgs(null)).toEqual(['--progress']);
    expect(buildCloneArgs(undefined)).toEqual(['--progress']);
  });

  test('appends -b <branch> when branch is given', () => {
    expect(buildCloneArgs('main')).toEqual(['--progress', '-b', 'main']);
  });

  test('passes slashed branches through verbatim (git accepts the slash form)', () => {
    expect(buildCloneArgs('feat/foo')).toEqual(['--progress', '-b', 'feat/foo']);
  });

  test('treats an empty-string branch as absent (defensive)', () => {
    expect(buildCloneArgs('')).toEqual(['--progress']);
  });
});

describe('cloneWithBranchFallback', () => {
  test('branch present + clone succeeds: no fallback, args include -b <branch>', async () => {
    const calls: string[][] = [];
    const fallbacks: string[] = [];
    const result = await cloneWithBranchFallback({
      branch: 'main',
      clone: async (args) => {
        calls.push(args);
      },
      onFallback: (b) => {
        fallbacks.push(b);
      },
    });
    expect(result).toEqual({ fellBack: false });
    expect(calls).toEqual([['--progress', '-b', 'main']]);
    expect(fallbacks).toEqual([]);
  });

  test('branch null: legacy path — no -b, single attempt', async () => {
    const calls: string[][] = [];
    const fallbacks: string[] = [];
    const result = await cloneWithBranchFallback({
      branch: null,
      clone: async (args) => {
        calls.push(args);
      },
      onFallback: (b) => {
        fallbacks.push(b);
      },
    });
    expect(result).toEqual({ fellBack: false });
    expect(calls).toEqual([['--progress']]);
    expect(fallbacks).toEqual([]);
  });

  test('branch present + Remote branch not found: emits fallback, retries without -b', async () => {
    const calls: string[][] = [];
    const fallbacks: string[] = [];
    let attempt = 0;
    const result = await cloneWithBranchFallback({
      branch: 'missing-branch',
      clone: async (args) => {
        calls.push(args);
        attempt += 1;
        if (attempt === 1) {
          throw new Error('fatal: Remote branch missing-branch not found in upstream origin');
        }
      },
      onFallback: (b) => {
        fallbacks.push(b);
      },
    });
    expect(result).toEqual({ fellBack: true });
    expect(calls).toEqual([['--progress', '-b', 'missing-branch'], ['--progress']]);
    expect(fallbacks).toEqual(['missing-branch']);
  });

  test('slashed branch (e.g. feat/foo) fallback works end-to-end', async () => {
    const calls: string[][] = [];
    const fallbacks: string[] = [];
    let attempt = 0;
    await cloneWithBranchFallback({
      branch: 'feat/foo',
      clone: async (args) => {
        calls.push(args);
        attempt += 1;
        if (attempt === 1) {
          throw new Error('fatal: Remote branch feat/foo not found in upstream origin');
        }
      },
      onFallback: (b) => {
        fallbacks.push(b);
      },
    });
    expect(calls[0]).toEqual(['--progress', '-b', 'feat/foo']);
    expect(calls[1]).toEqual(['--progress']);
    expect(fallbacks).toEqual(['feat/foo']);
  });

  test('onFallback fires BEFORE the retry so JSONL consumers see what was attempted', async () => {
    const ordering: string[] = [];
    await cloneWithBranchFallback({
      branch: 'missing',
      clone: async (args) => {
        if (args.includes('-b')) {
          ordering.push('first-attempt');
          throw new Error('Remote branch missing not found');
        }
        ordering.push('retry');
      },
      onFallback: () => {
        ordering.push('fallback-emitted');
      },
    });
    expect(ordering).toEqual(['first-attempt', 'fallback-emitted', 'retry']);
  });

  test('auth failure: re-thrown, no fallback retry', async () => {
    const calls: string[][] = [];
    const fallbacks: string[] = [];
    await expect(
      cloneWithBranchFallback({
        branch: 'main',
        clone: async (args) => {
          calls.push(args);
          throw new Error('fatal: Authentication failed for https://github.com/...');
        },
        onFallback: (b) => {
          fallbacks.push(b);
        },
      }),
    ).rejects.toThrow(/Authentication failed/);
    expect(calls).toEqual([['--progress', '-b', 'main']]);
    expect(fallbacks).toEqual([]);
  });

  test('network failure: re-thrown, no fallback retry', async () => {
    const calls: string[][] = [];
    await expect(
      cloneWithBranchFallback({
        branch: 'main',
        clone: async (args) => {
          calls.push(args);
          throw new Error('fatal: unable to access ...: Could not resolve host');
        },
        onFallback: () => {},
      }),
    ).rejects.toThrow(/Could not resolve host/);
    expect(calls).toEqual([['--progress', '-b', 'main']]);
  });

  test('branch null + non-branch error: re-thrown, no fallback (legacy path stays legacy)', async () => {
    await expect(
      cloneWithBranchFallback({
        branch: null,
        clone: async () => {
          throw new Error('Remote branch foo not found');
        },
        onFallback: () => {},
      }),
    ).rejects.toThrow(/Remote branch/);
  });
});

describe('isBranchNotFoundError', () => {
  test('matches simple-git remote-branch-not-found shape', () => {
    const err = new Error(
      'fatal: Remote branch missing-branch not found in upstream origin\nfatal: Could not find remote branch missing-branch to clone',
    );
    expect(isBranchNotFoundError(err)).toBe(true);
  });

  test('matches the message regardless of branch name', () => {
    expect(isBranchNotFoundError(new Error('Remote branch feat/foo not found'))).toBe(true);
  });

  test('matches the lowercase "couldn\'t find remote ref" message (git CLI variant)', () => {
    expect(
      isBranchNotFoundError(new Error("fatal: couldn't find remote ref refs/heads/feat/missing")),
    ).toBe(true);
  });

  test('matches the capitalized "Couldn\'t find remote ref" message', () => {
    expect(
      isBranchNotFoundError(new Error("fatal: Couldn't find remote ref refs/heads/feat/missing")),
    ).toBe(true);
  });

  test('does not match auth failures', () => {
    expect(
      isBranchNotFoundError(new Error('fatal: Authentication failed for https://github.com/...')),
    ).toBe(false);
  });

  test('does not match network errors', () => {
    expect(
      isBranchNotFoundError(new Error('fatal: unable to access ...: Could not resolve host')),
    ).toBe(false);
  });

  test('handles non-Error values without throwing', () => {
    expect(isBranchNotFoundError('Remote branch foo not found')).toBe(true);
    expect(isBranchNotFoundError(null)).toBe(false);
    expect(isBranchNotFoundError(undefined)).toBe(false);
  });
});

describe('formatCloneAuthFailure', () => {
  test('an embedded password never reaches the message or the re-run command', () => {
    const out = formatCloneAuthFailure({
      error: new Error('fatal: could not read Username for https://github.com'),
      url: 'https://alice:s3cretpw@github.com/inkeep/playbooks',
      branch: 'feat-x',
    });
    expect(out).not.toBeNull();
    expect(out).not.toContain('s3cretpw');
    expect(out).toContain(
      '2. Then re-run: ok clone https://alice@github.com/inkeep/playbooks -b feat-x',
    );
  });

  test('the 404 masquerade echo also drops an embedded password', () => {
    const out = formatCloneAuthFailure({
      error: new Error("fatal: repository 'https://github.com/o/private.git/' not found"),
      url: 'https://alice:s3cretpw@github.com/o/private',
    });
    expect(out).not.toBeNull();
    expect(out).not.toContain('s3cretpw');
    expect(out).toContain('Repository not found when cloning https://alice@github.com/o/private');
  });

  test('a bare token-as-username never reaches the message or the re-run command', () => {
    const tok = `ghp_${'A'.repeat(36)}`;
    const out = formatCloneAuthFailure({
      error: new Error('fatal: could not read Username for https://github.com'),
      url: `https://${tok}@github.com/o/r`,
      branch: null,
    });
    expect(out).not.toBeNull();
    expect(out).not.toContain(tok);
    expect(out).toContain('ok clone https://github.com/o/r');
  });

  test('a token paired with a placeholder password is dropped, not promoted to the username', () => {
    const tok = `ghp_${'B'.repeat(36)}`;
    const out = formatCloneAuthFailure({
      error: new Error("fatal: repository 'https://github.com/o/r.git/' not found"),
      url: `https://${tok}:x-oauth-basic@github.com/o/r`,
    });
    expect(out).not.toBeNull();
    expect(out).not.toContain(tok);
  });

  test('a fine-grained PAT username is dropped', () => {
    const tok = `github_pat_${'C'.repeat(70)}`;
    const out = formatCloneAuthFailure({
      error: new Error('remote: HTTP 401 Unauthorized'),
      url: `https://${tok}@github.com/o/r`,
    });
    expect(out).not.toBeNull();
    expect(out).not.toContain(tok);
  });

  test('a real login survives so the re-run keeps the identity declaration', () => {
    const out = formatCloneAuthFailure({
      error: new Error('fatal: could not read Username for https://github.com'),
      url: 'https://Alice-B_c@github.com/o/r',
      branch: null,
    });
    expect(out).toContain('ok clone https://Alice-B_c@github.com/o/r');
  });

  test('returns null for non-auth errors so the caller falls through to the raw git error', () => {
    expect(
      formatCloneAuthFailure({
        error: new Error("fatal: couldn't find remote ref refs/heads/foo"),
        url: 'https://github.com/o/r',
        branch: 'foo',
      }),
    ).toBeNull();
    expect(
      formatCloneAuthFailure({
        error: new Error('connection timed out'),
        url: 'https://github.com/o/r',
      }),
    ).toBeNull();
  });

  test('login-fixable (no-credential) → 2-step instruction with reconstructed -b command', () => {
    const out = formatCloneAuthFailure({
      error: new Error('fatal: could not read Username for https://github.com'),
      url: 'https://github.com/inkeep/playbooks',
      branch: 'feat-x',
    });
    expect(out).not.toBeNull();
    expect(out).toContain("Couldn't clone https://github.com/inkeep/playbooks");
    expect(out).toContain('authentication is required');
    expect(out).toContain('1. Run: ok auth login');
    expect(out).toContain('2. Then re-run: ok clone https://github.com/inkeep/playbooks -b feat-x');
  });

  test('login-fixable reconstruction omits -b when no branch was supplied', () => {
    const out = formatCloneAuthFailure({
      error: new Error('fatal: terminal prompts disabled'),
      url: 'inkeep/playbooks',
      branch: null,
    });
    expect(out).toMatch(/ok clone inkeep\/playbooks$/);
    expect(out).not.toContain('-b');
  });

  test('login-fixable (401 expired token) → same 2-step recovery shape', () => {
    const out = formatCloneAuthFailure({
      error: new Error('remote: HTTP 401 Unauthorized'),
      url: 'inkeep/playbooks',
      branch: 'main',
    });
    expect(out).toContain('1. Run: ok auth login');
    expect(out).toContain('2. Then re-run: ok clone inkeep/playbooks -b main');
  });

  test('login-fixable (unknown-auth) → 2-step recovery', () => {
    const out = formatCloneAuthFailure({
      error: new Error('remote: Authentication failed'),
      url: 'inkeep/playbooks',
      branch: 'main',
    });
    expect(out).toContain('1. Run: ok auth login');
  });

  test('403 → access-denied hint without the login instruction', () => {
    const out = formatCloneAuthFailure({
      error: new Error('remote: HTTP 403 Forbidden'),
      url: 'https://github.com/o/private',
      branch: 'main',
    });
    expect(out).toContain('Access denied when cloning https://github.com/o/private');
    expect(out).toContain('Check that your account has access');
    expect(out).not.toContain('ok auth login');
  });

  test('403 + known principal → "signed in as @user" hint', () => {
    const out = formatCloneAuthFailure({
      error: new Error('remote: HTTP 403 Forbidden'),
      url: 'https://github.com/o/private',
      principal: 'miles',
    });
    expect(out).toContain('signed in as @miles');
    expect(out).toContain('may lack access');
  });

  test('repository-not-found (404 masquerade) → not-found-or-no-access copy, no recovery command', () => {
    const out = formatCloneAuthFailure({
      error: new Error("fatal: repository 'https://github.com/o/private.git/' not found"),
      url: 'https://github.com/o/private',
      branch: 'main',
    });
    expect(out).not.toBeNull();
    expect(out).toContain('Repository not found when cloning https://github.com/o/private');
    expect(out).toContain('may not exist');
    expect(out).toContain('may not have access');
    expect(out).not.toContain('ok auth login');
    expect(out).not.toContain('ok auth pat');
    expect(out).not.toContain('scope');
  });

  test('scope-mismatch → actionable PAT recovery (ok auth pat + re-run), not ok auth login', () => {
    const out = formatCloneAuthFailure({
      error: new Error('insufficient scopes'),
      url: 'inkeep/private-repo',
      branch: 'main',
    });
    expect(out).toContain('missing required OAuth scopes');
    expect(out).toContain('repo');
    expect(out).not.toContain('ok auth login');
    expect(out).toContain('ok auth pat');
    expect(out).toContain('https://github.com/settings/tokens');
    expect(out).toContain('re-run: ok clone inkeep/private-repo -b main');
  });

  test('ssh-auth → SSH transport hint, never the ok auth login recovery', () => {
    for (const message of ['Permission denied (publickey).', 'Host key verification failed.']) {
      const out = formatCloneAuthFailure({
        error: new Error(message),
        url: 'git@github.com:inkeep/playbooks.git',
        branch: 'main',
      });
      expect(out).not.toBeNull();
      expect(out).toContain('SSH');
      expect(out).not.toContain('ok auth login');
    }
  });

  test('shell-quotes a branch with spaces in the reconstructed re-run command', () => {
    const out = formatCloneAuthFailure({
      error: new Error('fatal: could not read Username'),
      url: 'inkeep/playbooks',
      branch: 'feat my idea',
    });
    expect(out).toContain("-b 'feat my idea'");
  });
});

describe('runClone declared-miss warning', () => {
  let tmp: string;
  let stderrChunks: string[];
  let stdoutChunks: string[];
  let restore: (() => void) | null = null;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ok-clone-warn-'));
    stderrChunks = [];
    stdoutChunks = [];
    const realErr = process.stderr.write.bind(process.stderr);
    const realOut = process.stdout.write.bind(process.stdout);
    process.stderr.write = ((c: string) => {
      stderrChunks.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((c: string) => {
      stdoutChunks.push(String(c));
      return true;
    }) as typeof process.stdout.write;
    restore = () => {
      process.stderr.write = realErr;
      process.stdout.write = realOut;
    };
  });

  afterEach(() => {
    restore?.();
    restore = null;
    rmSync(tmp, { recursive: true, force: true });
  });

  const fallbackGh = () => ({ available: true as const, token: 'ghs_active', fallback: true });

  async function cloneAndIgnoreFailure(json: boolean): Promise<void> {
    await runClone(
      'https://alice@127.0.0.1:1/o/r.git',
      { json, dir: join(tmp, 'out'), _detectGhFn: fallbackGh },
      {} as never,
      tmp,
    ).catch(() => {});
  }

  test('the human path writes the warning to stderr and never to stdout', async () => {
    await cloneAndIgnoreFailure(false);
    expect(stderrChunks.join('')).toContain('The clone URL names alice');
    expect(stdoutChunks.join('')).not.toContain('\u26a0');
  });

  test('--json suppresses the warning on both channels', async () => {
    await cloneAndIgnoreFailure(true);
    expect(stderrChunks.join('')).not.toContain('The clone URL names alice');
    expect(stdoutChunks.join('')).not.toContain('\u26a0');
  });

  test('the URL-declared login reaches detectGh from runClone itself', async () => {
    const seen: Array<{ host?: string; login?: string }> = [];
    const recordingGh = (host?: string, options?: { login?: string }) => {
      seen.push({ host, login: options?.login });
      return { available: true as const, token: 'ghs_active', fallback: true };
    };
    await runClone(
      'https://alice@127.0.0.1:1/o/r.git',
      { json: false, dir: join(tmp, 'out'), _detectGhFn: recordingGh },
      {} as never,
      tmp,
    ).catch(() => {});

    expect(seen).toContainEqual({ host: '127.0.0.1', login: 'alice' });
    expect(seen.every((c) => c.login === 'alice')).toBe(true);
  });
});

describe('formatCloneAuthFailure credential redaction', () => {
  const TOKEN = `ghp_${'a'.repeat(36)}`;

  test('a whitespace-bearing userinfo is still stripped, not echoed', () => {
    const out = formatCloneAuthFailure({
      error: new Error("fatal: repository 'https://x/y' not found"),
      url: `https://foo bar:${TOKEN}@github.com/o/r.git`,
      branch: null,
    });
    expect(out).not.toBeNull();
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('ghp_');
    expect(out).not.toContain('foo bar');
  });

  test('the suggested re-run command carries no credential either', () => {
    const out = formatCloneAuthFailure({
      error: new Error('fatal: could not read Username for https://github.com'),
      url: `https://alice:my ${TOKEN}@github.com/o/r.git`,
      branch: 'main',
    });
    expect(out).toContain('ok clone');
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('ghp_');
  });
});

describe('emitCloneFailure', () => {
  function makeCollectors() {
    const emitted: Record<string, unknown>[] = [];
    const stderr: string[] = [];
    return {
      emit: (event: Record<string, unknown>) => emitted.push(event),
      printStderr: (text: string) => stderr.push(text),
      emitted,
      stderr,
    };
  }

  test('--json: emits {type:"error", message} with the raw error message — wire shape unchanged', () => {
    const c = makeCollectors();
    emitCloneFailure({
      error: new Error('fatal: could not read Username'),
      url: 'inkeep/playbooks',
      branch: 'main',
      json: true,
      emit: c.emit,
      printStderr: c.printStderr,
    });
    expect(c.emitted).toHaveLength(1);
    expect(c.emitted[0]).toEqual({
      type: 'error',
      message: 'fatal: could not read Username',
    });
    expect(c.stderr).toHaveLength(0);
  });

  test('--json: shape unchanged for non-auth failures too', () => {
    const c = makeCollectors();
    emitCloneFailure({
      error: new Error('connection timed out'),
      url: 'inkeep/playbooks',
      json: true,
      emit: c.emit,
      printStderr: c.printStderr,
    });
    expect(c.emitted[0]).toEqual({ type: 'error', message: 'connection timed out' });
  });

  test('--json: a token-as-username in the git error is redacted from the event', () => {
    const c = makeCollectors();
    emitCloneFailure({
      error: new Error(
        "fatal: could not read Password for 'https://ghp_c8Fyj2wXaB1LmQ9zK4tUvNs6RdPeYhG3o5A7@github.com': terminal prompts disabled",
      ),
      url: 'https://github.com/o/private',
      json: true,
      emit: c.emit,
      printStderr: c.printStderr,
    });
    expect(c.emitted).toHaveLength(1);
    const message = c.emitted[0]?.message as string;
    expect(message).not.toContain('ghp_c8Fyj2wXaB1LmQ9zK4tUvNs6RdPeYhG3o5A7');
    expect(message).toContain('could not read Password');
    expect(message).toContain('github.com');
  });

  test('interactive fallback line redacts an embedded credential the same way', () => {
    const c = makeCollectors();
    emitCloneFailure({
      error: new Error(
        'fatal: unable to update https://x-access-token:ghp_c8Fyj2wXaB1LmQ9zK4tUvNs6RdPeYhG3o5A7@github.com/o/r',
      ),
      url: 'https://github.com/o/r',
      json: false,
      emit: c.emit,
      printStderr: c.printStderr,
    });
    const out = c.stderr.join('');
    expect(out).not.toContain('ghp_c8Fyj2wXaB1LmQ9zK4tUvNs6RdPeYhG3o5A7');
    expect(out).toContain('x-access-token');
  });

  test('interactive + login-fixable: prints the 2-step instruction; does not emit JSON', () => {
    const c = makeCollectors();
    emitCloneFailure({
      error: new Error('fatal: could not read Username'),
      url: 'inkeep/playbooks',
      branch: 'main',
      json: false,
      emit: c.emit,
      printStderr: c.printStderr,
    });
    expect(c.emitted).toHaveLength(0);
    expect(c.stderr.join('')).toContain('1. Run: ok auth login');
    expect(c.stderr.join('')).toContain('2. Then re-run: ok clone inkeep/playbooks -b main');
  });

  test('interactive + 403: prints the hint, no login instruction', () => {
    const c = makeCollectors();
    emitCloneFailure({
      error: new Error('HTTP 403 Forbidden'),
      url: 'inkeep/private',
      json: false,
      emit: c.emit,
      printStderr: c.printStderr,
    });
    const out = c.stderr.join('');
    expect(out).toContain('Access denied when cloning inkeep/private');
    expect(out).not.toContain('ok auth login');
  });

  test("interactive + non-auth: falls through to today's ✗ <message> line", () => {
    const c = makeCollectors();
    emitCloneFailure({
      error: new Error("fatal: couldn't find remote ref refs/heads/foo"),
      url: 'inkeep/playbooks',
      branch: 'foo',
      json: false,
      emit: c.emit,
      printStderr: c.printStderr,
    });
    expect(c.stderr.join('')).toBe("✗ fatal: couldn't find remote ref refs/heads/foo\n");
  });

  test('same actionable message regardless of TTY — no isTTY branch in the helper', () => {
    const c1 = makeCollectors();
    const c2 = makeCollectors();
    const args = {
      error: new Error('fatal: terminal prompts disabled'),
      url: 'inkeep/playbooks',
      branch: 'main',
      json: false,
    };
    emitCloneFailure({ ...args, emit: c1.emit, printStderr: c1.printStderr });
    emitCloneFailure({ ...args, emit: c2.emit, printStderr: c2.printStderr });
    expect(c1.stderr.join('')).toBe(c2.stderr.join(''));
  });
});

describe('clone stores the remote URL verbatim, userinfo included', () => {
  test('git clone of a userinfo URL writes that URL into .git/config unchanged', async () => {
    const base = mkdtempSync(join(tmpdir(), 'ok-clone-userinfo-'));
    try {
      const srcDir = join(base, 'seed');
      mkdirSync(srcDir);
      execFileSync('git', ['init', '--initial-branch=main'], { cwd: srcDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: srcDir });
      execFileSync('git', ['config', 'user.name', 'T'], { cwd: srcDir });
      writeFileSync(join(srcDir, 'README.md'), '# seed\n', 'utf-8');
      execFileSync('git', ['add', '.'], { cwd: srcDir });
      execFileSync('git', ['commit', '-m', 'seed'], { cwd: srcDir, stdio: 'ignore' });

      const declaredUrl = 'https://alice@github.com/seed-owner/seed-repo';
      const redirect = `url.${pathToFileURL(srcDir).href}.insteadOf=${declaredUrl}`;

      const targetDir = join(base, 'cloned');
      const env = buildCloneAuthEnv({}, { PATH: process.env.PATH ?? '' });
      const git = simpleGit(
        buildCloneGitOptions(base, [redirect]) as Partial<SimpleGitOptions>,
      ).env(env);
      await git.clone(declaredUrl, targetDir, buildCloneArgs(null));

      const config = readFileSync(join(targetDir, '.git', 'config'), 'utf-8');
      expect(config).toContain(`url = ${declaredUrl}`);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('runClone git preflight', () => {
  it('git unusable everywhere → runClone surfaces the recoverable GitNotAvailableError', async () => {
    const originalPath = process.env.PATH;
    const originalPlatform = process.platform;
    process.env.PATH = '/nonexistent';
    Object.defineProperty(process, 'platform', {
      value: originalPlatform === 'win32' ? 'linux' : 'win32',
      configurable: true,
    });
    try {
      const { GitNotAvailableError } = await import('@inkeep/open-knowledge-server');
      const cwd = join(
        tmpdir(),
        `ok-clone-preflight-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      await expect(
        runClone('inkeep/playbooks', { json: true }, {} as unknown as Config, cwd),
      ).rejects.toBeInstanceOf(GitNotAvailableError);
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
      process.env.PATH = originalPath;
    }
  });
});
