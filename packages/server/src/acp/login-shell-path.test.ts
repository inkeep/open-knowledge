/**
 * The login-shell PATH probe: sentinel parsing, append-only merge semantics,
 * the skip conditions that must never spawn a shell, and the real-subprocess
 * rung — a fake `$SHELL` that proves stdout capture, the timeout kill, and
 * that the probe script itself is valid POSIX shell.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { getLogger } from '../logger.ts';
import {
  createLoginShellPathProvider,
  loginShellProbeArgs,
  mergeLoginShellPath,
  parseLoginShellPath,
  preferLoginShellPath,
} from './login-shell-path.ts';

const log = getLogger('login-shell-path-test');

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'login-shell-path-test-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/** A stand-in `$SHELL` that ignores its args and prints `body`. */
function fakeShell(body: string): string {
  const dir = tmp();
  const path = join(dir, 'fake-shell');
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

const wrap = (path: string): string => `__OK_PATH_BEGIN__${path}__OK_PATH_END__`;

describe('parseLoginShellPath', () => {
  test('extracts the fenced PATH', () => {
    expect(parseLoginShellPath(wrap('/a:/b'))).toBe('/a:/b');
  });

  test('survives a profile that printed a banner first', () => {
    expect(parseLoginShellPath(`Welcome!\nnvm: using v22\n${wrap('/a:/b')}`)).toBe('/a:/b');
  });

  test('trims the newline printenv leaves behind', () => {
    expect(parseLoginShellPath('__OK_PATH_BEGIN__/a:/b\n__OK_PATH_END__')).toBe('/a:/b');
  });

  test('prefers the last begin sentinel — an echoed command line must not win', () => {
    expect(parseLoginShellPath(`+ printf %s __OK_PATH_BEGIN__\n${wrap('/real')}`)).toBe('/real');
  });

  test('null when a sentinel is missing or the value is empty', () => {
    expect(parseLoginShellPath('')).toBeNull();
    expect(parseLoginShellPath('__OK_PATH_BEGIN__/a:/b')).toBeNull();
    expect(parseLoginShellPath('shell: bad flag')).toBeNull();
    expect(parseLoginShellPath(wrap('  '))).toBeNull();
  });
});

describe('mergeLoginShellPath', () => {
  test('appends only what is new, keeping existing entries first', () => {
    expect(
      mergeLoginShellPath('/usr/bin:/bin', '/bin:/home/u/.nvm/versions/node/v24/bin', ':'),
    ).toBe('/usr/bin:/bin:/home/u/.nvm/versions/node/v24/bin');
  });

  test('an existing entry keeps winning — order is never rewritten', () => {
    // /usr/bin holds a `node` too; appending must not let the shell's copy take over.
    expect(mergeLoginShellPath('/usr/bin', '/opt/other/bin:/usr/bin', ':')).toBe(
      '/usr/bin:/opt/other/bin',
    );
  });

  test('handles an absent or empty current PATH', () => {
    expect(mergeLoginShellPath(undefined, '/a:/b', ':')).toBe('/a:/b');
    expect(mergeLoginShellPath('', '/a', ':')).toBe('/a');
  });

  test('drops empty segments rather than emitting a cwd-searching entry', () => {
    expect(mergeLoginShellPath('/a:', '/b::/c', ':')).toBe('/a:/b:/c');
  });
});

describe('preferLoginShellPath', () => {
  test('moves shell entries first and retains inherited-only entries', () => {
    expect(preferLoginShellPath('/old/bin:/usr/bin', '/new/bin:/usr/bin', ':')).toBe(
      '/new/bin:/usr/bin:/old/bin',
    );
  });

  test('drops empty and duplicate entries', () => {
    expect(preferLoginShellPath('/old/bin::/new/bin', '/new/bin:', ':')).toBe('/new/bin:/old/bin');
  });
});

describe('createLoginShellPathProvider (skip conditions)', () => {
  const neverRuns = () => {
    throw new Error('probe must not spawn');
  };

  test('windows never probes — its PATH comes from the registry, not a shell', async () => {
    const provider = createLoginShellPathProvider({
      log,
      platform: 'win32',
      shell: 'C:\\Windows\\system32\\cmd.exe',
      runProbe: neverRuns,
    });
    await expect(provider()).resolves.toBeNull();
  });

  test('no $SHELL → no probe', async () => {
    const provider = createLoginShellPathProvider({
      log,
      platform: 'darwin',
      shell: undefined,
      runProbe: neverRuns,
    });
    await expect(provider()).resolves.toBeNull();
  });

  test('a login-refusing shell is not worth the latency', async () => {
    const provider = createLoginShellPathProvider({
      log,
      platform: 'linux',
      shell: '/usr/sbin/nologin',
      runProbe: neverRuns,
    });
    await expect(provider()).resolves.toBeNull();
  });

  test('probes once and reuses the answer', async () => {
    let calls = 0;
    const provider = createLoginShellPathProvider({
      log,
      platform: 'darwin',
      shell: '/bin/zsh',
      runProbe: async () => {
        calls += 1;
        return wrap('/a:/b');
      },
    });
    expect(await provider()).toBe('/a:/b');
    expect(await provider()).toBe('/a:/b');
    expect(calls).toBe(1);
  });

  test('a probe that throws degrades to null instead of failing the launch', async () => {
    const provider = createLoginShellPathProvider({
      log,
      platform: 'darwin',
      shell: '/bin/zsh',
      runProbe: async () => {
        throw new Error('spawn EMFILE');
      },
    });
    await expect(provider()).resolves.toBeNull();
  });

  test('passes the login + interactive flags — zsh sources both startup sets from one run', () => {
    expect(loginShellProbeArgs().slice(0, 3)).toEqual(['-l', '-i', '-c']);
  });
});

describe('createLoginShellPathProvider (bash needs both startup branches)', () => {
  /** Records the argv of each capture and answers per-invocation. */
  const recordingProbe = (answers: Array<string | null>) => {
    const seen: string[][] = [];
    const runProbe = async (_shell: string, args: readonly string[]) => {
      seen.push([...args]);
      return answers[seen.length - 1] ?? null;
    };
    return { seen, runProbe };
  };

  test('zsh is captured once — its login and interactive gates are additive', async () => {
    const { seen, runProbe } = recordingProbe([wrap('/zsh/bin')]);
    const provider = createLoginShellPathProvider({
      log,
      platform: 'darwin',
      shell: '/bin/zsh',
      runProbe,
    });
    expect(await provider()).toBe('/zsh/bin');
    expect(seen).toEqual([['-l', '-i', '-c', expect.any(String)]]);
  });

  test('bash gets a second, non-login capture — `-l` locks it out of .bashrc', async () => {
    // The nvm shape under bash: `.bash_profile` holds one dir, `.bashrc` holds
    // the nvm one, and only the second capture can see the latter.
    const { seen, runProbe } = recordingProbe([wrap('/usr/bin'), wrap('/home/u/.nvm/v24/bin')]);
    const provider = createLoginShellPathProvider({
      log,
      platform: 'linux',
      shell: '/bin/bash',
      runProbe,
    });
    expect(await provider()).toBe(`/usr/bin${delimiter}/home/u/.nvm/v24/bin`);
    expect(seen[0]?.slice(0, 3)).toEqual(['-l', '-i', '-c']);
    expect(seen[1]?.slice(0, 2)).toEqual(['-i', '-c']);
  });

  test('bash still answers when only one of the two captures works', async () => {
    const loginOnly = createLoginShellPathProvider({
      log,
      platform: 'linux',
      shell: '/bin/bash',
      runProbe: recordingProbe([wrap('/only/login'), null]).runProbe,
    });
    expect(await loginOnly()).toBe('/only/login');

    const interactiveOnly = createLoginShellPathProvider({
      log,
      platform: 'linux',
      shell: '/bin/bash',
      runProbe: recordingProbe([null, wrap('/only/rc')]).runProbe,
    });
    expect(await interactiveOnly()).toBe('/only/rc');
  });

  test('sh takes the bash path — it is bash in POSIX mode on macOS', async () => {
    const { seen, runProbe } = recordingProbe([wrap('/a'), wrap('/b')]);
    const provider = createLoginShellPathProvider({
      log,
      platform: 'darwin',
      shell: '/bin/sh',
      runProbe,
    });
    await provider();
    expect(seen).toHaveLength(2);
  });
});

describe('createLoginShellPathProvider (failed probes stay retryable)', () => {
  test('a real answer is memoized for good', async () => {
    let calls = 0;
    const provider = createLoginShellPathProvider({
      log,
      platform: 'darwin',
      shell: '/bin/zsh',
      runProbe: async () => {
        calls += 1;
        return wrap('/a');
      },
    });
    expect(await provider()).toBe('/a');
    expect(await provider()).toBe('/a');
    expect(calls).toBe(1);
  });

  test('a failure does not disable the fallback for the life of the server', async () => {
    let calls = 0;
    let clock = 1_000_000;
    const provider = createLoginShellPathProvider({
      log,
      platform: 'darwin',
      shell: '/bin/zsh',
      now: () => clock,
      runProbe: async () => {
        calls += 1;
        // A transient failure (a shell that hung once), then a real answer.
        return calls === 1 ? null : wrap('/recovered');
      },
    });
    expect(await provider()).toBeNull();
    // Inside the backoff the failure is reused, so a burst of launches doesn't
    // re-pay the timeout.
    expect(await provider()).toBeNull();
    expect(calls).toBe(1);

    clock += 60_001;
    expect(await provider()).toBe('/recovered');
    expect(calls).toBe(2);
  });

  test('a structural skip never spawns, backoff or not', async () => {
    let clock = 0;
    const provider = createLoginShellPathProvider({
      log,
      platform: 'darwin',
      shell: undefined,
      now: () => clock,
      runProbe: () => {
        throw new Error('probe must not spawn');
      },
    });
    expect(await provider()).toBeNull();
    clock += 60_001;
    expect(await provider()).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')(
  'createLoginShellPathProvider (real subprocess)',
  () => {
    test('captures the PATH a real shell prints, banner and all', async () => {
      const shell = fakeShell(
        `echo "Last login: today"\nprintf %s '${wrap('/opt/fake/bin:/usr/bin')}'`,
      );
      const provider = createLoginShellPathProvider({ log, platform: 'darwin', shell });
      await expect(provider()).resolves.toBe('/opt/fake/bin:/usr/bin');
    });

    test('the probe script is valid shell — /bin/sh answers with a real PATH', async () => {
      const provider = createLoginShellPathProvider({ log, platform: 'darwin', shell: '/bin/sh' });
      const value = await provider();
      // The exact PATH depends on the machine's profiles; that it parsed at all
      // is the contract under test (printf + printenv + the sentinels).
      expect(value).not.toBeNull();
      expect(value).toContain('/');
    });

    test('a shell that hangs is killed and yields no verdict', async () => {
      const provider = createLoginShellPathProvider({
        log,
        platform: 'darwin',
        shell: fakeShell('sleep 30'),
        timeoutMs: 250,
      });
      const started = Date.now();
      await expect(provider()).resolves.toBeNull();
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    test('a shell that cannot be executed yields no verdict', async () => {
      const provider = createLoginShellPathProvider({
        log,
        platform: 'darwin',
        shell: join(tmp(), 'does-not-exist'),
      });
      await expect(provider()).resolves.toBeNull();
    });

    // The reason the bash branch exists, against real bash rather than a fake:
    // a PATH entry that only `.bashrc` adds is invisible to `-l -i` (bash takes
    // the login branch and never reads it), so collapsing back to a single
    // capture would silently stop rescuing bash's default nvm setup.
    //
    // Only the `.bashrc` half is asserted. Which login profile a given bash
    // reads — and whether it reads one at all under `-l -i -c` — varies with
    // the distro's build and its /etc/profile, so pinning that would make this
    // a test of the runner rather than of the union.
    test('real bash: a .bashrc-only directory is reached', async () => {
      const home = tmp();
      writeFileSync(join(home, '.bash_profile'), 'export PATH="/from/profile:$PATH"\n');
      writeFileSync(join(home, '.bashrc'), 'export PATH="/from/bashrc:$PATH"\n');
      const realHome = process.env.HOME;
      process.env.HOME = home;
      try {
        const captured = await createLoginShellPathProvider({
          log,
          platform: 'darwin',
          shell: '/bin/bash',
        })();
        expect(captured).not.toBeNull();
        expect((captured ?? '').split(delimiter)).toContain('/from/bashrc');
      } finally {
        if (realHome === undefined) delete process.env.HOME;
        else process.env.HOME = realHome;
      }
    });
  },
);
