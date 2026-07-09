import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { applyGitEnv, buildGitEnv, createGitInstance, type GitHandle } from './git-handle.ts';
import { withParentLock } from './git-mutex.ts';

// simple-git's .env(obj) REPLACES the child env, so these tests set/restore
// process.env around a buildGitEnv() call to prove which vars survive that
// replacement. Module-scoped so both describe blocks below can use it.
function withEnvEntries(entries: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(entries)) {
    saved.set(key, process.env[key]);
    const value = entries[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('buildGitEnv', () => {
  test('forces LANG/LC_ALL=C for locale-stable stderr', () => {
    const env = buildGitEnv();
    expect(env.LANG).toBe('C');
    expect(env.LC_ALL).toBe('C');
  });

  test('disables terminal prompts (no-TTY server-spawned git)', () => {
    // Without this, a credential-less fetch/push opens /dev/tty and dies with
    // "could not read Username … Device not configured". Disabled, git
    // fail-fasts with "terminal prompts disabled".
    expect(buildGitEnv().GIT_TERMINAL_PROMPT).toBe('0');
  });

  test('disables merge auto-edit so a sync merge commit never launches an editor', () => {
    // sync-engine's `git merge origin/<branch>` can produce a merge commit; a
    // launched editor with no TTY would hang the background sync. Pinning this
    // off makes git use the default merge message unconditionally.
    expect(buildGitEnv().GIT_MERGE_AUTOEDIT).toBe('no');
  });

  test('preserves PATH so a bare-command credential helper resolves', () => {
    withEnvEntries({ PATH: '/custom/bin:/usr/bin' }, () => {
      expect(buildGitEnv().PATH).toBe('/custom/bin:/usr/bin');
    });
  });

  test('preserves user and SSH auth environment for Git transports', () => {
    withEnvEntries(
      {
        HOME: '/Users/alice',
        USERPROFILE: 'C:\\Users\\alice',
        HOMEDRIVE: 'C:',
        HOMEPATH: '\\Users\\alice',
        ProgramData: 'C:\\ProgramData',
        ALLUSERSPROFILE: 'C:\\ProgramData',
        SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
      },
      () => {
        const env = buildGitEnv();
        expect(env.HOME).toBe('/Users/alice');
        expect(env.USERPROFILE).toBe('C:\\Users\\alice');
        expect(env.HOMEDRIVE).toBe('C:');
        expect(env.HOMEPATH).toBe('\\Users\\alice');
        expect(env.ProgramData).toBe('C:\\ProgramData');
        expect(env.ALLUSERSPROFILE).toBe('C:\\ProgramData');
        expect(env.SSH_AUTH_SOCK).toBe('/tmp/ssh-agent.sock');
      },
    );
  });

  test('does not pass through GIT_SSH_COMMAND without explicit simple-git opt-in', () => {
    withEnvEntries({ GIT_SSH_COMMAND: 'ssh -vv' }, () => {
      expect('GIT_SSH_COMMAND' in buildGitEnv()).toBe(false);
    });
  });

  test('preserves ELECTRON_RUN_AS_NODE so the packaged credential helper runs as Node', () => {
    // Regression: the desktop server runs as Electron-as-Node and re-invokes
    // the Electron binary as the credential helper. Dropping this var made the
    // binary boot a GUI app and FATAL ("Unable to find helper app") before
    // returning credentials.
    withEnvEntries({ ELECTRON_RUN_AS_NODE: '1' }, () => {
      expect(buildGitEnv().ELECTRON_RUN_AS_NODE).toBe('1');
    });
  });

  test('omits ELECTRON_RUN_AS_NODE on a non-Electron host (var unset)', () => {
    withEnvEntries({ ELECTRON_RUN_AS_NODE: undefined }, () => {
      expect('ELECTRON_RUN_AS_NODE' in buildGitEnv()).toBe(false);
    });
  });

  test('emits OK_GH_TOKEN/OK_GH_TOKEN_HOST only when a relay token is supplied', () => {
    const without = buildGitEnv();
    expect('OK_GH_TOKEN' in without).toBe(false);
    expect('OK_GH_TOKEN_HOST' in without).toBe(false);

    const withToken = buildGitEnv({ token: 'gho_relayed', host: 'github.com' });
    expect(withToken.OK_GH_TOKEN).toBe('gho_relayed');
    expect(withToken.OK_GH_TOKEN_HOST).toBe('github.com');
  });
});

describe('createGitInstance (credential.helper config)', () => {
  // Tier A (gh) and Tier B/C (stored token) both pass a
  // `credential.helper=!…` config string. Keep a regression test that the
  // SimpleGit constructor accepts it with our current package version.
  let tmpDir: string;

  function readEnv(handle: GitHandle): Record<string, string> {
    // biome-ignore lint/suspicious/noExplicitAny: probing internal simple-git executor for spawn-env assertion
    return ((handle.git as any)._executor?.env ?? {}) as Record<string, string>;
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ok-git-handle-test-'));
    execSync('git init -q', { cwd: tmpDir });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('accepts credential.helper config without throwing', async () => {
    const handle = createGitInstance(tmpDir, {
      credentialArgs: ['-c', 'credential.helper=!open-knowledge auth git-credential'],
    });
    // Any command triggers simple-git's block-unsafe-operations plugin, which
    // scans argv synchronously before spawning git. `--version` is the lightest
    // probe that exercises that plugin path.
    const version = await handle.git.raw(['--version']);
    expect(version).toContain('git version');
  });

  test('merges author overrides without dropping git auth env', () => {
    withEnvEntries({ USERPROFILE: 'C:\\Users\\alice' }, () => {
      const handle = createGitInstance(tmpDir, { gitIndexFile: '.git/custom-index' });
      applyGitEnv(handle, {
        GIT_AUTHOR_NAME: 'Alice',
        GIT_AUTHOR_EMAIL: 'alice@example.com',
      });

      const env = readEnv(handle);
      expect(env.USERPROFILE).toBe('C:\\Users\\alice');
      expect(env.GIT_INDEX_FILE).toBe(join(tmpDir, '.git/custom-index'));
      expect(env.GIT_AUTHOR_NAME).toBe('Alice');
      expect(env.GIT_AUTHOR_EMAIL).toBe('alice@example.com');
    });
  });

  test('pins commit.gpgsign and core.autocrlf off, overriding repo config', async () => {
    // Set the unsafe directives in the repo's own config; the `-c` flags the
    // handle passes outrank even repo-local config, so every server-spawned
    // command resolves them to false.
    execSync('git config commit.gpgsign true', { cwd: tmpDir });
    execSync('git config core.autocrlf true', { cwd: tmpDir });

    const handle = createGitInstance(tmpDir);
    expect((await handle.git.raw(['config', '--get', 'commit.gpgsign'])).trim()).toBe('false');
    expect((await handle.git.raw(['config', '--get', 'core.autocrlf'])).trim()).toBe('false');
  });
});

describe('withParentLock', () => {
  test('serializes concurrent operations in enqueue order', async () => {
    const order: number[] = [];

    await Promise.all([
      withParentLock(async () => {
        await wait(10);
        order.push(1);
      }),
      withParentLock(async () => {
        order.push(2);
      }),
      withParentLock(async () => {
        order.push(3);
      }),
    ]);

    expect(order).toEqual([1, 2, 3]);
  });

  test('continues after a failed task', async () => {
    const results: string[] = [];

    await Promise.allSettled([
      withParentLock(async () => {
        throw new Error('task 1 failed');
      }),
      withParentLock(async () => {
        results.push('task 2');
      }),
    ]);

    expect(results).toContain('task 2');
  });

  test('returns the resolved value', async () => {
    const result = await withParentLock(async () => 42);
    expect(result).toBe(42);
  });

  test('propagates errors to caller', async () => {
    await expect(
      withParentLock(async () => {
        throw new Error('deliberate failure');
      }),
    ).rejects.toThrow('deliberate failure');
  });
});

// Suppress unused import warnings for lifecycle hooks
void beforeEach;
void afterEach;
