import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  type CredentialUrlMatchReader,
  createCachedGitHubAccountResolver,
  resolveGitHubAccountFromUrl,
} from './github-account.ts';

/**
 * The credential lookup delegates to a real `git config --get-urlmatch`, so
 * these tests pin git's own longest-prefix resolution rather than a
 * reimplementation of it. `GIT_CONFIG_NOSYSTEM` plus a temp `GIT_CONFIG_GLOBAL`
 * keeps them off the developer's own config, which on a macOS box carries a
 * system-scope `[credential]` section.
 */
let dir: string;
let globalConfig: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gh-account-'));
  globalConfig = join(dir, 'gitconfig');
  writeFileSync(globalConfig, '', 'utf-8');
  savedEnv.GIT_CONFIG_GLOBAL = process.env.GIT_CONFIG_GLOBAL;
  savedEnv.GIT_CONFIG_NOSYSTEM = process.env.GIT_CONFIG_NOSYSTEM;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

function writeGlobalConfig(contents: string): void {
  writeFileSync(globalConfig, contents, 'utf-8');
}

/** A worktree git recognizes, so repo-local config scope actually applies. */
function initRepo(name: string, config?: string): string {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf-8' });
  if (config) writeFileSync(join(root, '.git', 'config'), config, 'utf-8');
  return root;
}

/** A `.git/config` on disk without a real repo — enough for the origin read. */
function seedOrigin(name: string, config: string): string {
  const root = join(dir, name);
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, '.git', 'config'), config, 'utf-8');
  return root;
}

function originConfig(url: string): string {
  return `[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
}

describe('resolveGitHubAccountFromUrl', () => {
  test('an account declared in the remote URL is the resolved account', () => {
    expect(
      resolveGitHubAccountFromUrl('https://alice@github.com/mona/test.git', { cwd: dir }),
    ).toEqual({ host: 'github.com', login: 'alice', source: 'remote-url' });
  });

  test('ssh and scp URLs declare their account the same way', () => {
    expect(resolveGitHubAccountFromUrl('ssh://alice@github.com/mona/test', { cwd: dir })).toEqual({
      host: 'github.com',
      login: 'alice',
      source: 'remote-url',
    });
    expect(resolveGitHubAccountFromUrl('alice@github.com:mona/test.git', { cwd: dir })).toEqual({
      host: 'github.com',
      login: 'alice',
      source: 'remote-url',
    });
  });

  test('the scp transport placeholder is not an account', () => {
    expect(resolveGitHubAccountFromUrl('git@github.com:mona/test.git', { cwd: dir })).toEqual({
      host: 'github.com',
      source: 'active',
    });
  });

  // Git consults credential helpers only for http(s) transports, and the scp
  // form makes `git config --get-urlmatch` exit 128 (no scheme) — so a
  // non-https origin must land on the floor without spawning the lookup at
  // all.
  test('ssh and scp origins never consult the credential-config lookup', () => {
    let reads = 0;
    const counting: CredentialUrlMatchReader = () => {
      reads += 1;
      return 'credential.username someone\n';
    };
    expect(
      resolveGitHubAccountFromUrl('git@github.com:mona/test.git', {
        cwd: dir,
        _readCredentialUrlMatch: counting,
      }),
    ).toEqual({ host: 'github.com', source: 'active' });
    expect(
      resolveGitHubAccountFromUrl('ssh://git@github.com/mona/test.git', {
        cwd: dir,
        _readCredentialUrlMatch: counting,
      }),
    ).toEqual({ host: 'github.com', source: 'active' });
    expect(reads).toBe(0);
  });

  // `https://:token@host/o/r` and placeholder-user forms reach the lookup
  // (the userinfo declared no account), but the credential half must never
  // ride into the subprocess argument.
  test('the credential-config lookup never receives a URL userinfo', () => {
    const seen: string[] = [];
    const recording: CredentialUrlMatchReader = (url) => {
      seen.push(url);
      return null;
    };
    resolveGitHubAccountFromUrl('https://:s3cret-token@github.com/mona/test.git', {
      cwd: dir,
      _readCredentialUrlMatch: recording,
    });
    resolveGitHubAccountFromUrl('https://x-access-token:ghs_tok@github.com/mona/test.git', {
      cwd: dir,
      _readCredentialUrlMatch: recording,
    });
    expect(seen).toEqual(['https://github.com/mona/test.git', 'https://github.com/mona/test.git']);
  });

  test('a URL declaring no account falls through to the active account', () => {
    expect(resolveGitHubAccountFromUrl('https://github.com/inkeep/repo.git', { cwd: dir })).toEqual(
      {
        host: 'github.com',
        source: 'active',
      },
    );
  });

  test('a known non-GitHub forge resolves to the active account with no host', () => {
    expect(resolveGitHubAccountFromUrl('https://gitlab.com/o/r.git', { cwd: dir })).toEqual({
      source: 'active',
    });
  });

  test('an unparseable URL resolves to the active account with no host', () => {
    expect(resolveGitHubAccountFromUrl('not a url', { cwd: dir })).toEqual({ source: 'active' });
  });

  test('a GHES host carries through as the resolved host', () => {
    expect(
      resolveGitHubAccountFromUrl('https://alice@ghes.corp.example/org/repo.git', { cwd: dir }),
    ).toEqual({ host: 'ghes.corp.example', login: 'alice', source: 'remote-url' });
  });
});

describe('credential.<url>.username', () => {
  test('a bare-host entry names the account', () => {
    writeGlobalConfig('[credential "https://github.com"]\n\tusername = personal\n');
    expect(resolveGitHubAccountFromUrl('https://github.com/mona/test.git', { cwd: dir })).toEqual({
      host: 'github.com',
      login: 'personal',
      source: 'credential-config',
    });
  });

  test('git longest-prefix matching picks the owner-scoped entry over the bare-host one', () => {
    writeGlobalConfig(
      '[credential "https://github.com"]\n\tusername = personal\n' +
        '[credential "https://github.com/bigcorp"]\n\tusername = workbot\n',
    );
    expect(resolveGitHubAccountFromUrl('https://github.com/bigcorp/secret', { cwd: dir })).toEqual({
      host: 'github.com',
      login: 'workbot',
      source: 'credential-config',
    });
    expect(resolveGitHubAccountFromUrl('https://github.com/mona/other', { cwd: dir })).toEqual({
      host: 'github.com',
      login: 'personal',
      source: 'credential-config',
    });
  });

  test('other credential keys matched alongside the username are ignored', () => {
    writeGlobalConfig(
      '[credential "https://github.com"]\n\thelper = osxkeychain\n\tusername = personal\n',
    );
    expect(resolveGitHubAccountFromUrl('https://github.com/mona/test', { cwd: dir })).toEqual({
      host: 'github.com',
      login: 'personal',
      source: 'credential-config',
    });
  });

  test('a matching entry that declares only a helper is not an account', () => {
    writeGlobalConfig('[credential "https://github.com"]\n\thelper = osxkeychain\n');
    expect(resolveGitHubAccountFromUrl('https://github.com/mona/test', { cwd: dir })).toEqual({
      host: 'github.com',
      source: 'active',
    });
  });

  // rc=128 (as opposed to the benign rc=1 no-match): a syntactically broken
  // gitconfig fails the whole `git config` invocation. The lookup failure
  // must read as "no declaration" and fall to the active-account floor —
  // never throw out of the resolver or kill the credential.
  test('a broken gitconfig fails the lookup to the active-account floor', () => {
    writeGlobalConfig('[credential "https://github.com\n\tusername = personal\n');
    expect(resolveGitHubAccountFromUrl('https://github.com/mona/test', { cwd: dir })).toEqual({
      host: 'github.com',
      source: 'active',
    });
  });

  test('a credential username outside the GitHub login grammar is not an account', () => {
    writeGlobalConfig('[credential "https://github.com"]\n\tusername = user@corp.com\n');
    expect(resolveGitHubAccountFromUrl('https://github.com/mona/test.git', { cwd: dir })).toEqual({
      host: 'github.com',
      source: 'active',
    });
  });

  test('a credential username carrying a token prefix is not an account', () => {
    writeGlobalConfig(`[credential "https://github.com"]\n\tusername = ghp_${'a'.repeat(36)}\n`);
    expect(resolveGitHubAccountFromUrl('https://github.com/mona/test.git', { cwd: dir })).toEqual({
      host: 'github.com',
      source: 'active',
    });
  });

  test('a transport placeholder in credential config is not an account', () => {
    writeGlobalConfig('[credential "https://github.com"]\n\tusername = x-access-token\n');
    expect(resolveGitHubAccountFromUrl('https://github.com/mona/test.git', { cwd: dir })).toEqual({
      host: 'github.com',
      source: 'active',
    });
  });

  // An unscoped `[credential] username` matches every URL git asks about, so a
  // value set for some corporate non-GitHub host would otherwise be read as a
  // GitHub account for every github.com remote on the machine.
  test('an unscoped credential username that is not a login stays out of the chain', () => {
    writeGlobalConfig('[credential]\n\tusername = alice@contoso.com\n');
    expect(resolveGitHubAccountFromUrl('https://github.com/mona/test.git', { cwd: dir })).toEqual({
      host: 'github.com',
      source: 'active',
    });
  });

  test('a repo-local entry names the account', () => {
    const repo = initRepo(
      'local',
      '[credential "https://github.com/acme"]\n\tusername = repobot\n',
    );
    expect(resolveGitHubAccountFromUrl('https://github.com/acme/thing.git', { cwd: repo })).toEqual(
      {
        host: 'github.com',
        login: 'repobot',
        source: 'credential-config',
      },
    );
  });

  test('a global-scope entry resolves before the repository exists', () => {
    writeGlobalConfig('[credential "https://github.com"]\n\tusername = personal\n');
    const nowhere = join(dir, 'not-a-repo');
    mkdirSync(nowhere, { recursive: true });
    expect(
      resolveGitHubAccountFromUrl('https://github.com/mona/fresh-clone.git', { cwd: nowhere }),
    ).toEqual({ host: 'github.com', login: 'personal', source: 'credential-config' });
  });

  test('the URL account wins over a more specific credential entry', () => {
    writeGlobalConfig(
      '[credential "https://github.com/bigcorp"]\n\tusername = workbot\n\tuseHttpPath = true\n',
    );
    expect(
      resolveGitHubAccountFromUrl('https://alice@github.com/bigcorp/secret', { cwd: dir }),
    ).toEqual({ host: 'github.com', login: 'alice', source: 'remote-url' });
  });

  test('a declared URL account needs no git lookup', () => {
    let reads = 0;
    const counting: CredentialUrlMatchReader = () => {
      reads += 1;
      return null;
    };
    resolveGitHubAccountFromUrl('https://alice@github.com/o/r.git', {
      cwd: dir,
      _readCredentialUrlMatch: counting,
    });
    expect(reads).toBe(0);
  });

  test('a lookup that cannot run falls through to the active account', () => {
    const unavailable: CredentialUrlMatchReader = () => null;
    expect(
      resolveGitHubAccountFromUrl('https://github.com/o/r.git', {
        cwd: dir,
        _readCredentialUrlMatch: unavailable,
      }),
    ).toEqual({ host: 'github.com', source: 'active' });
  });
});

describe('createCachedGitHubAccountResolver', () => {
  /** A credential lookup whose calls the test can count and whose answer it can swap. */
  function countingReader(initial: string | null): {
    fn: CredentialUrlMatchReader;
    calls: () => number;
    respond: (next: string | null) => void;
  } {
    let calls = 0;
    let response = initial;
    return {
      fn: () => {
        calls += 1;
        return response;
      },
      calls: () => calls,
      respond: (next) => {
        response = next;
      },
    };
  }

  test('repeated resolutions within the TTL share one credential lookup', () => {
    const project = seedOrigin('hot-path', originConfig('https://github.com/acme/kb.git'));
    const reader = countingReader('credential.username workbot\n');
    const resolver = createCachedGitHubAccountResolver({ _readCredentialUrlMatch: reader.fn });

    for (let i = 0; i < 3; i += 1) {
      expect(resolver.resolve(project)).toEqual({
        host: 'github.com',
        login: 'workbot',
        source: 'credential-config',
      });
    }
    expect(reader.calls()).toBe(1);
  });

  test('invalidate() drops the cached resolution so the next resolve re-runs the lookup', () => {
    const project = seedOrigin('invalidate', originConfig('https://github.com/acme/kb.git'));
    const reader = countingReader('credential.username workbot\n');
    const resolver = createCachedGitHubAccountResolver({ _readCredentialUrlMatch: reader.fn });

    resolver.resolve(project);
    reader.respond('credential.username otherbot\n');
    resolver.invalidate();
    expect(resolver.resolve(project)).toEqual({
      host: 'github.com',
      login: 'otherbot',
      source: 'credential-config',
    });
    expect(reader.calls()).toBe(2);
  });

  test('a credential-config change is picked up once the TTL elapses', () => {
    const project = seedOrigin('ttl', originConfig('https://github.com/acme/kb.git'));
    const reader = countingReader(null);
    let clock = 0;
    const resolver = createCachedGitHubAccountResolver({
      ttlMs: 1_000,
      now: () => clock,
      _readCredentialUrlMatch: reader.fn,
    });

    expect(resolver.resolve(project)).toEqual({ host: 'github.com', source: 'active' });
    reader.respond('credential.username workbot\n');
    clock = 999;
    expect(resolver.resolve(project)).toEqual({ host: 'github.com', source: 'active' });
    clock = 1_000;
    expect(resolver.resolve(project)).toEqual({
      host: 'github.com',
      login: 'workbot',
      source: 'credential-config',
    });
    expect(reader.calls()).toBe(2);
  });

  test('an origin URL change re-resolves immediately, with no TTL to wait out', () => {
    const project = seedOrigin('swap', originConfig('https://github.com/mona/kb.git'));
    const reader = countingReader(null);
    const resolver = createCachedGitHubAccountResolver({ _readCredentialUrlMatch: reader.fn });

    expect(resolver.resolve(project)).toEqual({ host: 'github.com', source: 'active' });
    writeFileSync(
      join(project, '.git', 'config'),
      originConfig('https://alice@github.com/mona/kb.git'),
      'utf-8',
    );
    expect(resolver.resolve(project)).toEqual({
      host: 'github.com',
      login: 'alice',
      source: 'remote-url',
    });
    // The declared-account URL needs no lookup, so the swap costs no spawn.
    expect(reader.calls()).toBe(1);
  });

  test('a project with no origin resolves to the active account without a lookup', () => {
    const project = seedOrigin('bare', '[core]\n\tbare = false\n');
    const reader = countingReader('credential.username workbot\n');
    const resolver = createCachedGitHubAccountResolver({ _readCredentialUrlMatch: reader.fn });

    expect(resolver.resolve(project)).toEqual({ source: 'active' });
    expect(reader.calls()).toBe(0);
  });

  test('projects do not share a cached resolution even for the same URL', () => {
    // Repo-local `credential.<url>.username` entries make the answer
    // project-specific, so a shared entry would leak one project's identity
    // into another.
    const url = 'https://github.com/acme/kb.git';
    const one = seedOrigin('proj-one', originConfig(url));
    const two = seedOrigin('proj-two', originConfig(url));
    const reader = countingReader(null);
    const resolver = createCachedGitHubAccountResolver({ _readCredentialUrlMatch: reader.fn });

    resolver.resolve(one);
    resolver.resolve(two);
    expect(reader.calls()).toBe(2);
  });
});
