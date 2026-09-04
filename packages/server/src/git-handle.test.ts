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
    expect(buildGitEnv().GIT_TERMINAL_PROMPT).toBe('0');
  });

  test('disables merge auto-edit so a sync merge commit never launches an editor', () => {
    expect(buildGitEnv().GIT_MERGE_AUTOEDIT).toBe('no');
  });

  test('preserves PATH (as a prefix) so a bare-command credential helper resolves', () => {
    withEnvEntries({ PATH: '/custom/bin:/usr/bin' }, () => {
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

  test('emits OK_GH_TOKEN_LOGIN only when the relay names its account', () => {
    const named = buildGitEnv({ token: 'gho_relayed', host: 'github.com', login: 'alice' });
    expect(named.OK_GH_TOKEN_LOGIN).toBe('alice');

    const anonymous = buildGitEnv({ token: 'gho_relayed', host: 'github.com' });
    expect('OK_GH_TOKEN_LOGIN' in anonymous).toBe(false);
  });
});

describe('createGitInstance (credential.helper config)', () => {
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
    execSync('git config commit.gpgsign true', { cwd: tmpDir });
    execSync('git config core.autocrlf true', { cwd: tmpDir });

    const handle = createGitInstance(tmpDir, { credentialConfig: [] });
    expect((await handle.git.raw(['config', '--get', 'commit.gpgsign'])).trim()).toBe('false');
    expect((await handle.git.raw(['config', '--get', 'core.autocrlf'])).trim()).toBe('false');
  });

  test('pins credential.interactive off, overriding repo config', async () => {
    execSync('git config credential.interactive true', { cwd: tmpDir });

    const handle = createGitInstance(tmpDir, { credentialConfig: [] });
    expect((await handle.git.raw(['config', '--get', 'credential.interactive'])).trim()).toBe(
      'false',
    );
  });

  test('keeps pinning credential.interactive off alongside credential.helper config', async () => {
    const handle = createGitInstance(tmpDir, {
      credentialConfig: buildSyncCredentialConfig(['open-knowledge'], { resetAmbient: true }),
    });
    expect((await handle.git.raw(['config', '--get', 'credential.interactive'])).trim()).toBe(
      'false',
    );
  });
});

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

    function isolateAmbientGitConfig(handle: GitHandle): void {
      applyGitEnv(handle, {
        GIT_CONFIG_NOSYSTEM: '1',
        HOME: isolatedHome,
        XDG_CONFIG_HOME: isolatedHome,
      });
    }

    test('git resolves ambient helper, then reset, then OK helper last', async () => {
      execSync("git config credential.helper '!/ambient/stub'", { cwd: repoDir });

      const handle = createGitInstance(repoDir, {
        credentialConfig: buildSyncCredentialConfig(['open-knowledge'], { resetAmbient: true }),
      });
      isolateAmbientGitConfig(handle);

      const raw = await handle.git.raw(['config', '-z', '--get-all', 'credential.helper']);
      const entries = raw.split('\0').slice(0, -1);
      expect(entries).toEqual(['!/ambient/stub', '', '!open-knowledge auth git-credential']);
    });

    test('non-GitHub origin keeps its ambient helper and gets no reset', async () => {
      execSync("git config credential.helper '!/ambient/stub'", { cwd: repoDir });

      const handle = createGitInstance(repoDir, {
        credentialConfig: buildSyncCredentialConfig(['open-knowledge'], { resetAmbient: false }),
      });
      isolateAmbientGitConfig(handle);

      const raw = await handle.git.raw(['config', '-z', '--get-all', 'credential.helper']);
      const values = raw.split('\0').slice(0, -1);

      expect(values).toEqual(['!/ambient/stub', '!open-knowledge auth git-credential']);
    });

    test('with an ambient helper configured, git sends `get` to OK helper only', async () => {
      const ambientLog = join(isolatedHome, 'ambient.log');
      const okLog = join(isolatedHome, 'ok.log');
      const ambientHelper = join(isolatedHome, 'ambient-helper.sh');
      const okCli = join(isolatedHome, 'ok-cli.sh');

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

        await expect(handle.git.raw(['fetch', 'origin'])).rejects.toThrow();

        const callsIn = (log: string): string[] =>
          existsSync(log)
            ? readFileSync(log, 'utf-8')
                .split('\n')
                .filter((line) => line !== '')
            : [];
        expect(callsIn(okLog)).toContain('auth git-credential get');
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

void beforeEach;
void afterEach;

describe('buildSyncCredentialConfig()', () => {
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

  test('resetAmbient:false omits the reset, preserving the ambient chain', () => {
    const values = credentialHelperValues(
      buildSyncCredentialConfig(['open-knowledge'], { resetAmbient: false }),
    );
    expect(values).toEqual(['!open-knowledge auth git-credential']);
  });
});
