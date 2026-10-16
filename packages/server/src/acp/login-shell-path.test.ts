import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
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
let spawners: Array<{ child: ChildProcess; closed: Promise<void> }> = [];
afterEach(async () => {
  for (const { child, closed } of spawners) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
  spawners = [];
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function fakeShell(body: string): string {
  const dir = tmp();
  const path = join(dir, 'fake-shell');
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

const wrap = (path: string): string => `__OK_PATH_BEGIN__${path}__OK_PATH_END__`;

const spawnerScript = `
const { createLoginShellPathProvider } = await import(process.env.PROBE_MODULE);
createLoginShellPathProvider({
  log: { debug() {} },
  platform: 'darwin',
  shell: process.env.PROBE_SHELL,
  timeoutMs: 60_000,
})();
process.stdout.write('spawned');
if (process.env.EXIT_AFTER_MS) setTimeout(() => process.exit(0), Number(process.env.EXIT_AFTER_MS));
`;

async function startProbeSpawner(
  shell: string,
  exitAfterMs?: number,
): Promise<{ child: ChildProcess; closed: Promise<void> }> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', spawnerScript],
    {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PROBE_MODULE: new URL('./login-shell-path.ts', import.meta.url).href,
        PROBE_SHELL: shell,
        EXIT_AFTER_MS: exitAfterMs === undefined ? '' : String(exitAfterMs),
      },
    },
  );
  const closed = new Promise<void>((resolveClosed) => {
    child.once('close', () => resolveClosed());
  });
  spawners.push({ child, closed });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  await new Promise<void>((resolveSpawned, rejectSpawned) => {
    child.stdout?.on('data', () => resolveSpawned());
    void closed.then(() => rejectSpawned(new Error(`probe spawner exited early: ${stderr}`)));
  });
  return { child, closed };
}

function forkingStallingShell(heartbeat: string): string {
  return fakeShell(
    `( i=0; while [ $i -lt 300 ]; do touch '${heartbeat}'; sleep 0.1; i=$((i + 1)); done ) &\nsleep 30`,
  );
}

async function expectHeartbeatStopped(heartbeat: string): Promise<void> {
  expect(existsSync(heartbeat)).toBe(true);
  rmSync(heartbeat);
  await delay(1_000);
  expect(existsSync(heartbeat)).toBe(false);
}

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
        return calls === 1 ? null : wrap('/recovered');
      },
    });
    expect(await provider()).toBeNull();
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

    test('a timed-out probe kills the subshells its shell forked', async () => {
      const heartbeat = join(tmp(), 'heartbeat');
      const provider = createLoginShellPathProvider({
        log,
        platform: 'darwin',
        shell: forkingStallingShell(heartbeat),
        timeoutMs: 2_000,
      });
      await expect(provider()).resolves.toBeNull();
      await expectHeartbeatStopped(heartbeat);
    }, 15_000);

    test('a spawner that exits mid-probe takes the whole probe tree with it', async () => {
      const heartbeat = join(tmp(), 'heartbeat');
      const { closed } = await startProbeSpawner(forkingStallingShell(heartbeat), 2_000);
      await closed;
      await expectHeartbeatStopped(heartbeat);
    }, 15_000);

    test('a probe outliving a killed spawner never writes into a dead pipe', async () => {
      const dir = tmp();
      const shell = fakeShell(
        [
          `trap "touch '${join(dir, 'sigpipe')}'" PIPE`,
          'sleep 1',
          'echo "Last login: today"',
          `touch '${join(dir, 'finished')}'`,
        ].join('\n'),
      );
      const { child, closed } = await startProbeSpawner(shell);
      child.kill('SIGKILL');
      await closed;
      await vi.waitFor(() => expect(existsSync(join(dir, 'finished'))).toBe(true), {
        timeout: 10_000,
        interval: 50,
      });
      expect(existsSync(join(dir, 'sigpipe'))).toBe(false);
    }, 15_000);

    test('a shell that cannot be executed yields no verdict', async () => {
      const provider = createLoginShellPathProvider({
        log,
        platform: 'darwin',
        shell: join(tmp(), 'does-not-exist'),
      });
      await expect(provider()).resolves.toBeNull();
    });

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
