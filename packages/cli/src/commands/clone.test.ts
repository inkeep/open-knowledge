import { afterEach, beforeEach, describe, expect, it, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Config } from '@inkeep/open-knowledge-server';
import type { TokenStore } from '../auth/token-store.ts';
import { OK_DIR } from '../constants.ts';
import {
  buildCloneArgs,
  buildCloneEnv,
  buildCloneGitOptions,
  cloneWithBranchFallback,
  emitCloneFailure,
  ensureOkExcludedFromGit,
  formatCloneAuthFailure,
  handleCloneFailure,
  isBranchNotFoundError,
  resolveClonePrincipal,
  resolveCloneUrl,
  runClone,
  shouldSkipAuthForPublicRepo,
} from './clone.ts';

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
});

describe('buildCloneEnv', () => {
  // Regression guard: clone must INHERIT the caller's env (so the Tier-A `gh`
  // credential helper can find `gh` on PATH + its config via HOME), not replace
  // it — simple-git's `.env()` replaces wholesale. A revert to a bare object
  // would silently re-break Tier A on stock (e.g. Homebrew) installs.
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
});

describe('buildCloneGitOptions', () => {
  // `ok clone` runs git as the user with the user's env; simple-git refuses to
  // run with PAGER / GIT_SSH_COMMAND / GIT_ASKPASS present unless these flags
  // opt in. Reverting any of them silently re-breaks clone for users who set
  // those env vars (the reported `PAGER is not permitted` failure).
  test('opts into the env-based unsafe flags so the user PAGER/SSH/askpass env is honored', () => {
    const o = buildCloneGitOptions('/work/dir', ['credential.helper=!gh auth git-credential']);
    expect(o.baseDir).toBe('/work/dir');
    expect(o.config).toEqual(['credential.helper=!gh auth git-credential']);
    expect(o.unsafe).toEqual({
      allowUnsafeCredentialHelper: true,
      allowUnsafePager: true,
      allowUnsafeSshCommand: true,
      allowUnsafeAskPass: true,
    });
  });

  test('passes an empty config through unchanged (no credential helper injected)', () => {
    const o = buildCloneGitOptions('/work/dir', []);
    expect(o.config).toEqual([]);
    expect(o.unsafe?.allowUnsafePager).toBe(true);
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
    // Original template preserved
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
    // Reproduces the worktree-blind regression: when
    // `<projectDir>/.git` is a regular file (pointer to a per-worktree admin
    // dir), the legacy helper hard-coded `<projectDir>/.git/info/exclude`
    // and returned `no-exclude` silently. Post-migration, the new module
    // resolves through `commondir` and writes to the main repo's exclude.
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
      // Sanity-pin: the linked worktree's `.git` is a pointer file, not a dir.
      const dotGit = readFileSync(join(linkedDir, '.git'), 'utf-8');
      expect(dotGit.startsWith('gitdir:')).toBe(true);

      const result = ensureOkExcludedFromGit(linkedDir);
      expect(result).toBe('appended');

      // The write landed in the COMMON dir's info/exclude — i.e., the main
      // repo's `.git/info/exclude`, NOT a non-existent
      // `<linkedDir>/.git/info/exclude`.
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
    // Some git versions emit this form on `git clone -b <missing>` instead of
    // the older "Remote branch X not found in upstream origin". Without this
    // pattern the classifier falls through, the clone error propagates as a
    // generic failure, and the share-receive flow surfaces the wrong toast.
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

  test('scope-mismatch → actionable PAT recovery (ok auth pat + re-run), not ok auth login', () => {
    const out = formatCloneAuthFailure({
      error: new Error('insufficient scopes'),
      url: 'inkeep/private-repo',
      branch: 'main',
    });
    expect(out).toContain('missing required OAuth scopes');
    expect(out).toContain('repo');
    // ok auth login mints a fixed device-flow scope set that can't gain repo —
    // so it must NOT be the recovery; the PAT flow is.
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
      // `ok auth login` mints an HTTPS credential — it cannot fix an SSH key,
      // so it must never appear as the recovery for an SSH transport failure.
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
    // Behavioral statement: the helper takes a json flag, not a TTY flag, so
    // the same login-fixable input always produces the same message string in
    // interactive mode.
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

describe('runClone git preflight', () => {
  it('git unusable everywhere → runClone surfaces the recoverable GitNotAvailableError', async () => {
    // Same technique as init.test.ts's git-unavailable case: narrow PATH so the
    // bare `git` probe fails, AND override the platform so detectGit's absolute
    // fallback paths are host-absent — together git is unresolvable, so the
    // preflight throws the recoverable typed error instead of letting a raw
    // simple-git clone error surface. (resolveOnPath's positive cache is only
    // touched on the success path, so no cache reset is needed here.)
    const originalPath = process.env.PATH;
    const originalPlatform = process.platform;
    process.env.PATH = '/nonexistent';
    Object.defineProperty(process, 'platform', {
      value: originalPlatform === 'win32' ? 'linux' : 'win32',
      configurable: true,
    });
    try {
      const { GitNotAvailableError } = await import('@inkeep/open-knowledge-server');
      // Nonexistent cwd + default dir → targetDir is absent, so the non-empty-dir
      // check is skipped and runClone reaches the preflight, which throws before
      // any network probe or keyring init. `_config` is unused by runClone.
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
