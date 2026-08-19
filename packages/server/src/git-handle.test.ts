import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import shellQuote from 'shell-quote';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  applyGitEnv,
  buildGitEnv,
  buildSyncCredentialConfig,
  createGitInstance,
  type GitHandle,
} from './git-handle.ts';
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
    // "could not read Username … Device not configured". Retained as the second
    // line of defence: `createGitInstance` pins `credential.interactive=false`,
    // which short-circuits earlier on git versions that honor it, so this var
    // is what keeps the misleading ENXIO errno out of logs on the paths and git
    // versions the pin doesn't cover.
    expect(buildGitEnv().GIT_TERMINAL_PROMPT).toBe('0');
  });

  test('disables merge auto-edit so a sync merge commit never launches an editor', () => {
    // sync-engine's `git merge origin/<branch>` can produce a merge commit; a
    // launched editor with no TTY would hang the background sync. Pinning this
    // off makes git use the default merge message unconditionally.
    expect(buildGitEnv().GIT_MERGE_AUTOEDIT).toBe('no');
  });

  test('preserves PATH (as a prefix) so a bare-command credential helper resolves', () => {
    withEnvEntries({ PATH: '/custom/bin:/usr/bin' }, () => {
      // Augmentation may APPEND well-known tool dirs (git-lfs & co. under a
      // packaged app's minimal launchd PATH) but must never reorder or drop
      // the inherited entries — existing resolution stays authoritative.
      expect(buildGitEnv().PATH?.startsWith('/custom/bin:/usr/bin')).toBe(true);
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
      credentialConfig: buildSyncCredentialConfig(['open-knowledge'], { resetAmbient: true }),
    });
    // Any command triggers simple-git's block-unsafe-operations plugin, which
    // scans argv synchronously before spawning git. `--version` is the lightest
    // probe that exercises that plugin path.
    const version = await handle.git.raw(['--version']);
    expect(version).toContain('git version');
  });

  test('merges author overrides without dropping git auth env', () => {
    withEnvEntries({ USERPROFILE: 'C:\\Users\\alice' }, () => {
      const handle = createGitInstance(tmpDir, {
        gitIndexFile: '.git/custom-index',
        credentialConfig: [],
      });
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

    const handle = createGitInstance(tmpDir, { credentialConfig: [] });
    expect((await handle.git.raw(['config', '--get', 'commit.gpgsign'])).trim()).toBe('false');
    expect((await handle.git.raw(['config', '--get', 'core.autocrlf'])).trim()).toBe('false');
  });

  // Regression: a server-spawned git must never be able to open a credential
  // helper's GUI. `GIT_TERMINAL_PROMPT=0` only silences git's own TTY prompt;
  // Git Credential Manager (the default helper on Git for Windows, and
  // interactive by default) would still pop a GitHub sign-in window on every
  // background fetch that missed the credential store.
  test('pins credential.interactive off, overriding repo config', async () => {
    execSync('git config credential.interactive true', { cwd: tmpDir });

    const handle = createGitInstance(tmpDir, { credentialConfig: [] });
    expect((await handle.git.raw(['config', '--get', 'credential.interactive'])).trim()).toBe(
      'false',
    );
  });

  test('keeps pinning credential.interactive off alongside credential.helper config', async () => {
    // The helper config is spread into the same `-c` list; the spread must not
    // displace the interactivity pin.
    const handle = createGitInstance(tmpDir, {
      credentialConfig: buildSyncCredentialConfig(['open-knowledge'], { resetAmbient: true }),
    });
    expect((await handle.git.raw(['config', '--get', 'credential.interactive'])).trim()).toBe(
      'false',
    );
  });
});

// Composes the real producer (buildSyncCredentialConfig) with the real consumer
// (createGitInstance → simple-git → a real git subprocess), so these tests fail
// if EITHER side breaks the contract: a producer that never emits the
// `credential.helper=` reset, or a consumer that forwards only part of the
// produced entries into git's `-c` list. The assertions read what git itself
// resolves and invokes — not the strings OK builds — because an ambient-helper
// shadowing bug is invisible to every string-level assertion.
//
// POSIX-only: the stub helpers are `sh` scripts and the ambient entry is
// planted via a quoted shell command. CI for this package runs on POSIX.
describe.skipIf(process.platform === 'win32')(
  'createGitInstance × buildSyncCredentialConfig — ambient helper neutralization',
  () => {
    let repoDir: string;
    let isolatedHome: string;

    beforeEach(() => {
      repoDir = mkdtempSync(join(tmpdir(), 'ok-sync-cred-repo-'));
      isolatedHome = mkdtempSync(join(tmpdir(), 'ok-sync-cred-home-'));
      execSync('git init -q', { cwd: repoDir });
    });

    afterEach(() => {
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(isolatedHome, { recursive: true, force: true });
    });

    // Cut off the system and global config scopes, for two distinct reasons:
    // determinism — `git config --get-all` enumerates raw values across every
    // scope with no reset applied, so a machine's system/global entries (e.g.
    // macOS's system-wide osxkeychain) would prefix the enumeration test's
    // exact-equality list; and fail-safety — should the reset regress (the
    // exact bug these tests exist to catch), a real system helper re-enters
    // the EFFECTIVE list and the 401 rejection's erase fan-out would reach
    // the user's real keychain. Isolation keeps a failing run harmless; only
    // when the code under test is correct does the reset alone exclude it.
    function isolateAmbientGitConfig(handle: GitHandle): void {
      applyGitEnv(handle, {
        GIT_CONFIG_NOSYSTEM: '1',
        HOME: isolatedHome,
        XDG_CONFIG_HOME: isolatedHome,
      });
    }

    test('git resolves ambient helper, then reset, then OK helper last', async () => {
      // Repo-local config stands in for an ambient helper: it sits earlier
      // than command-line `-c` in git's multi-valued accumulation, exactly
      // like a system/global entry would.
      execSync("git config credential.helper '!/ambient/stub'", { cwd: repoDir });

      const handle = createGitInstance(repoDir, {
        credentialConfig: buildSyncCredentialConfig(['open-knowledge'], { resetAmbient: true }),
      });
      isolateAmbientGitConfig(handle);

      const raw = await handle.git.raw(['config', '-z', '--get-all', 'credential.helper']);
      const entries = raw.split('\0').slice(0, -1);
      // The empty entry is the reset; it must come after every inherited
      // entry and before OK's helper, and OK's helper must be LAST — a
      // consumer that forwards only one of the produced entries fails here
      // whichever one it drops.
      expect(entries).toEqual(['!/ambient/stub', '', '!open-knowledge auth git-credential']);
    });

    // No per-test timeout override: the handle's 15s block (inactivity)
    // timeout needs the workspace default 30s wall so a hung git is killed,
    // surfaces its rejection, and the log assertions still get to run — a
    // tighter wall fires first and reports a bare timeout with no evidence.
    // Mirror of the enumeration test above for a forge OK cannot authenticate:
    // the ambient helper must SURVIVE, because it is the user's only working
    // credential and no OK sign-in can replace it.
    test('non-GitHub origin keeps its ambient helper and gets no reset', async () => {
      execSync("git config credential.helper '!/ambient/stub'", { cwd: repoDir });

      const handle = createGitInstance(repoDir, {
        credentialConfig: buildSyncCredentialConfig(['open-knowledge'], { resetAmbient: false }),
      });
      isolateAmbientGitConfig(handle);

      const raw = await handle.git.raw(['config', '-z', '--get-all', 'credential.helper']);
      // Same parse as the enumeration test above: drop only the trailing NUL
      // terminator, never empties — the empty entry IS the reset, so filtering
      // empties out would make this assertion unable to fail.
      const values = raw.split('\0').slice(0, -1);

      // The ambient entry is still first and still reachable, and no empty
      // reset was injected ahead of OK's helper to neutralise it.
      expect(values).toEqual(['!/ambient/stub', '!open-knowledge auth git-credential']);
    });

    test('with an ambient helper configured, git sends `get` to OK helper only', async () => {
      const ambientLog = join(isolatedHome, 'ambient.log');
      const okLog = join(isolatedHome, 'ok.log');
      const ambientHelper = join(isolatedHome, 'ambient-helper.sh');
      const okCli = join(isolatedHome, 'ok-cli.sh');

      // Both stubs log every invocation and answer `get` with a complete
      // credential — the ambient one deliberately so: git stops querying at
      // the first helper that returns a full credential, so if the ambient
      // helper is still in the resolved list it wins and OK's helper never
      // sees `get`. That is the field failure this test reproduces.
      const stubScript = (log: string, user: string): string =>
        [
          '#!/bin/sh',
          `printf '%s\\n' "$*" >> '${log}'`,
          'cat > /dev/null',
          'case "$*" in',
          `  *get) printf 'username=${user}\\npassword=${user}-secret\\n' ;;`,
          'esac',
          '',
        ].join('\n');
      writeFileSync(ambientHelper, stubScript(ambientLog, 'ambient'), { mode: 0o755 });
      writeFileSync(okCli, stubScript(okLog, 'ok'), { mode: 0o755 });

      execSync(`git config credential.helper '!${ambientHelper}'`, { cwd: repoDir });

      // Loopback server that 401s everything: forces git through a real
      // `credential fill` (and the rejection fan-out) without any network.
      const server: HttpServer = createHttpServer((req, res) => {
        req.resume();
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="ok-test"' });
        res.end('auth required');
      });
      await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));

      try {
        const { port } = server.address() as AddressInfo;
        execSync(`git remote add origin http://127.0.0.1:${port}/repo.git`, { cwd: repoDir });

        const handle = createGitInstance(repoDir, {
          credentialConfig: buildSyncCredentialConfig([okCli], { resetAmbient: true }),
          timeoutMs: 15_000,
        });
        isolateAmbientGitConfig(handle);

        // Both credentials are wrong for the always-401 server, so the fetch
        // fails either way — WHICH helper git consulted is the discriminator.
        await expect(handle.git.raw(['fetch', 'origin'])).rejects.toThrow();

        const callsIn = (log: string): string[] =>
          existsSync(log)
            ? readFileSync(log, 'utf-8')
                .split('\n')
                .filter((line) => line !== '')
            : [];
        // OK's helper is invoked as `<cli> auth git-credential <op>`, the
        // ambient one as `<helper> <op>`, so the logged argv lines differ.
        expect(callsIn(okLog)).toContain('auth git-credential get');
        // Nothing at all, not merely no `get`: the reset drops the ambient
        // helper from the EFFECTIVE list, so git cannot invoke it for any
        // operation. Asserting only on `get` would stay green if a regression
        // re-admitted the helper for the 401 rejection's `erase` fan-out —
        // which would wipe the user's real keychain entry on every retry.
        expect(callsIn(ambientLog)).toEqual([]);
      } finally {
        await new Promise<void>((resolvePromise) => {
          server.close(() => resolvePromise());
        });
      }
    });
  },
);

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

describe('buildSyncCredentialConfig()', () => {
  // Git runs a `!`-prefixed credential helper through the shell, so the helper
  // string after `!` is whatever the shell tokenizes back out. Parsing it with
  // shell-quote reproduces the argv git would exec — the load-bearing property.
  // OK's helper is the LAST credential.helper value in the returned config
  // (the empty reset precedes it), so select by position-from-the-end rather
  // than a hard-coded index.
  const argvFromHelper = (config: string[]): unknown[] => {
    const helperValues = config
      .filter((entry) => entry.startsWith('credential.helper='))
      .map((entry) => entry.slice('credential.helper='.length));
    const helper = helperValues.at(-1) ?? '';
    expect(helper.startsWith('!')).toBe(true);
    const suffix = ' auth git-credential';
    expect(helper.endsWith(suffix)).toBe(true);
    return shellQuote.parse(helper.slice(1));
  };

  test('packaged macOS bundle path survives the shell as one intact token', () => {
    // Regression: the bundled CLI lives under "/Applications/OpenKnowledge.app/…".
    // Unquoted, the shell split at the space, tried to exec "/Applications/Open",
    // returned no credentials, and git failed with "could not read Username …
    // Device not configured". The path must round-trip as a single argv element.
    const bundlePath = '/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh';
    const config = buildSyncCredentialConfig([bundlePath], { resetAmbient: true });
    expect(argvFromHelper(config)).toEqual([bundlePath, 'auth', 'git-credential']);
  });

  test('bare command (dev default) stays unquoted', () => {
    const config = buildSyncCredentialConfig(['open-knowledge'], { resetAmbient: true });
    expect(config).toEqual([
      'credential.helper=',
      'credential.helper=!open-knowledge auth git-credential',
    ]);
    expect(argvFromHelper(config)).toEqual(['open-knowledge', 'auth', 'git-credential']);
  });

  test('undefined / empty argv falls back to the bare CLI name', () => {
    const expected = [
      'credential.helper=',
      'credential.helper=!open-knowledge auth git-credential',
    ];
    expect(buildSyncCredentialConfig(undefined, { resetAmbient: true })).toEqual(expected);
    expect(buildSyncCredentialConfig([], { resetAmbient: true })).toEqual(expected);
  });

  test('multi-element argv escapes each element independently', () => {
    const argv = ['/Users/me/Library/Application Support/bun', '/opt/ok cli/cli.mjs'];
    const config = buildSyncCredentialConfig(argv, { resetAmbient: true });
    expect(argvFromHelper(config)).toEqual([...argv, 'auth', 'git-credential']);
  });

  test('embedded single quote in the path round-trips safely', () => {
    const argv = ["/Users/o'brien/OpenKnowledge.app/cli.sh"];
    const config = buildSyncCredentialConfig(argv, { resetAmbient: true });
    expect(argvFromHelper(config)).toEqual([...argv, 'auth', 'git-credential']);
  });
});

describe('buildSyncCredentialConfig() — ambient helper neutralization', () => {
  // `credential.helper` is a multi-valued git config key: git accumulates every
  // configured value (system → global → repo-local → command-line `-c`) and
  // asks helpers in that order, stopping at the first that returns a complete
  // credential. An EMPTY value resets the accumulated list. Without a reset
  // entry ahead of OK's helper, any ambient helper (macOS Command Line Tools
  // install a system-wide osxkeychain; Git for Windows ships `manager`) answers
  // `get` first and can hand git a stale credential — sync then 401s while OK
  // holds a valid token. The clone path already pins reset-then-helper
  // (resolve-auth.ts); the sync producer must emit the same shape.
  //
  // Extracts the credential.helper values from the returned config in order,
  // so the assertion survives changes to how the entries are laid out while
  // still pinning the resolved-list order.
  const credentialHelperValues = (config: string[]): string[] =>
    config
      .filter((entry) => entry.startsWith('credential.helper='))
      .map((entry) => entry.slice('credential.helper='.length));

  test("emits an empty credential.helper reset before OK's own helper", () => {
    const values = credentialHelperValues(
      buildSyncCredentialConfig(['open-knowledge'], { resetAmbient: true }),
    );
    expect(values).toEqual(['', '!open-knowledge auth git-credential']);
  });

  test('packaged bundle path keeps the reset ahead of the escaped helper', () => {
    const bundlePath = '/Applications/OpenKnowledge.app/Contents/Resources/cli/bin/ok.sh';
    const values = credentialHelperValues(
      buildSyncCredentialConfig([bundlePath], { resetAmbient: true }),
    );
    expect(values[0]).toBe('');
    expect(values.at(-1)).toBe(`!${bundlePath} auth git-credential`);
  });

  // The `false` arm guards origins OK cannot authenticate (gitlab, bitbucket,
  // ...): their ambient helper is the ONLY credential they have, so emitting
  // the reset would wipe it on every sync tick with no in-app way back. The
  // git-level proof of that lives in git-handle.test.ts, but that suite is
  // POSIX-only (`describe.skipIf(win32)`); without this case the always-running
  // tier would stay green if the ternary were changed to always reset.
  test('resetAmbient:false omits the reset, preserving the ambient chain', () => {
    const values = credentialHelperValues(
      buildSyncCredentialConfig(['open-knowledge'], { resetAmbient: false }),
    );
    expect(values).toEqual(['!open-knowledge auth git-credential']);
  });
});

/**
 * The generated index's WIRING, at real fidelity — a real server, a real
 * watcher, real disk, a real shadow repo.
 *
 * This layer is where the feature's two shipped bugs lived, and neither was
 * visible to a unit test: the config key was dropped in the persisted→runtime
 * lift, and the delete branch for an unloaded document never scheduled a
 * rebuild. Both left every pure test green. So each trigger gets exercised
 * end-to-end against the index file it is supposed to move, rather than against
 * the scheduler being called.
 */
