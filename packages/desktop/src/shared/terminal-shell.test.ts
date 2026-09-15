import { type SpawnOptions, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  DETACHED_SPAWN_OPTIONS,
  INTERACTIVE_SHELL_SPAWN_OPTIONS,
  spawnDetachedInteractiveChild,
  spawnInteractiveShellSync,
} from '../../tests/support/detached-interactive-spawn.test-helper.ts';
import { commandWithManagedPath } from './terminal-shell.ts';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn), spawnSync: vi.fn(actual.spawnSync) };
});

const spawnMock = vi.mocked(spawn);
const spawnSyncMock = vi.mocked(spawnSync);

function asyncSpawnCallOptions(call = 0): SpawnOptions | undefined {
  return spawnMock.mock.calls[call]?.[2] as SpawnOptions | undefined;
}

function syncSpawnCallOptions(call = 0):
  | {
      detached?: boolean;
      timeout?: number;
      killSignal?: NodeJS.Signals | number;
      encoding?: BufferEncoding;
    }
  | undefined {
  return spawnSyncMock.mock.calls[call]?.[2] as
    | {
        detached?: boolean;
        timeout?: number;
        killSignal?: NodeJS.Signals | number;
        encoding?: BufferEncoding;
      }
    | undefined;
}

const zsh = ['/bin/zsh', '/usr/bin/zsh'].find(existsSync);
const bash = ['/bin/bash', '/usr/bin/bash'].find(existsSync);

describe('managed-path probe spawn isolation', () => {
  test('spawns the interactive probes detached from the session controlling terminal (undetached, an interactive shell under a tty acquires the ctty from a background process group and stops the whole vitest task group)', () => {
    expect(
      INTERACTIVE_SHELL_SPAWN_OPTIONS.detached,
      'the managed-path probes must spawn with detached: true; without it an interactive shell (zsh or bash -i) acquires the session controlling terminal from a background process group and stops the entire vitest task group',
    ).toBe(true);
  });

  test('bounds the synchronous probe spawn at 20s (vitest testTimeout cannot preempt a worker blocked inside spawnSync, so the bound must live on the spawn options)', () => {
    expect(
      INTERACTIVE_SHELL_SPAWN_OPTIONS.timeout,
      'the managed-path probes must carry a spawn-level timeout; a probe that wedges would otherwise block the worker inside spawnSync with no bound, because vitest testTimeout runs on the blocked worker and cannot preempt the synchronous call',
    ).toBe(20_000);
  });

  test('kills the wedged probe rather than signaling it (interactive bash ignores SIGTERM and spawnSync escalates nothing)', () => {
    expect(
      INTERACTIVE_SHELL_SPAWN_OPTIONS.killSignal,
      'the timeout bound must terminate the shell: spawnSync sends exactly one killSignal with no escalation and interactive bash ignores SIGTERM, so the default signal lets a wedged interactive shell outlive the bound and block the worker unbounded',
    ).toBe('SIGKILL');
  });
});

describe('detached async interactive-shell spawn isolation', () => {
  test('spawns the async interactive-shell children detached from the session controlling terminal (undetached, an interactive shell under a tty acquires the ctty from a background process group and stops the whole vitest task group)', () => {
    expect(
      DETACHED_SPAWN_OPTIONS.detached,
      'the async interactive-shell spawn helper must place its children in a new session: the bare-env probe adapter and the process-group containment spawns run real interactive shells, and an undetached one acquires the session controlling terminal from a background process group and stops the entire vitest task group',
    ).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('detached interactive-shell wrapper site pin', () => {
  test('spawnDetachedInteractiveChild passes the pinned detachment to spawn at the wrapper body (the tripwires above cover the const values; this pin covers the wrapper body itself)', () => {
    spawnMock.mockClear();
    const child = spawnDetachedInteractiveChild(process.execPath, ['-e', 'process.exit(0)']);
    try {
      expect(
        spawnMock.mock.calls.length,
        'the site pin must observe the wrapper real spawn call; zero calls means the passthrough record broke',
      ).toBe(1);
      const options = asyncSpawnCallOptions();
      expect(
        options?.detached,
        'the wrapper body must spread the pinned detachment through to spawn: only the options the wrapper actually passes reach the children, so deleting or falsifying the spread here ships the const tripwires green while the probes run undetached and reacquire the session controlling terminal',
      ).toBe(true);
      expect(
        options?.stdio,
        'the interactive-shell children read nothing, so their stdio stays off every pipe and terminal',
      ).toBe('ignore');
      expect(
        options?.shell,
        'the argv is composed by the callers, so the wrapper must not layer a shell over it',
      ).toBe(false);
      expect(
        options?.windowsHide,
        'a console-less parent must not flash a terminal window for the spawned children',
      ).toBe(true);
    } finally {
      child.kill();
    }
  });

  test('spawnInteractiveShellSync passes the pinned isolation options to spawnSync at the wrapper body (the tripwires above cover the const values; this pin covers the wrapper body itself)', () => {
    spawnSyncMock.mockClear();
    spawnInteractiveShellSync(process.execPath, ['-e', 'process.exit(0)']);
    expect(
      spawnSyncMock.mock.calls.length,
      'the site pin must observe the wrapper real spawnSync call; zero calls means the passthrough record broke',
    ).toBe(1);
    const options = syncSpawnCallOptions();
    expect(
      options?.detached,
      'the wrapper body must spread the pinned detachment through to spawnSync: only the options the wrapper actually passes reach the probes, so deleting or falsifying the spread here ships the const tripwires green while the probes run undetached and reacquire the session controlling terminal',
    ).toBe(true);
    expect(
      options?.timeout,
      'the wrapper must carry the spawn-level timeout through; vitest testTimeout cannot preempt a worker blocked inside spawnSync',
    ).toBe(20_000);
    expect(
      options?.killSignal,
      'the bound must terminate the shell: spawnSync escalates nothing and interactive bash ignores SIGTERM, so the pinned signal has to reach spawnSync',
    ).toBe('SIGKILL');
    expect(
      options?.encoding,
      'the callers assert on stderr as a string, so utf8 decoding has to be part of the pinned options',
    ).toBe('utf8');
  });

  test('spawnInteractiveShellSync forwards a per-call timeoutMs over the pinned default', () => {
    spawnSyncMock.mockClear();
    spawnInteractiveShellSync(process.execPath, ['-e', 'process.exit(0)'], undefined, 5_000);
    expect(
      syncSpawnCallOptions()?.timeout,
      'the ok-bin caller passes 5s to keep its pre-change bound, and nothing else observes that argument reaching spawnSync: dropping or reordering the parameter would otherwise leave every suite green while that caller silently ran on the 20s default',
    ).toBe(5_000);
  });
});

describe.skipIf(zsh === undefined)('commandWithManagedPath', () => {
  test('keeps startup-defined functions available in the initialized shell', () => {
    const zdotdir = mkdtempSync(join(tmpdir(), 'ok-managed-path-zsh-'));
    try {
      writeFileSync(join(zdotdir, '.zshrc'), 'slidev() { exit 42; }\n');
      const command = commandWithManagedPath(zsh ?? '/bin/zsh', 'slidev deck.md --port 4300', [
        '/managed/bin',
      ]);
      const child = spawnInteractiveShellSync(zsh ?? '/bin/zsh', ['-i', '-c', command], {
        ...process.env,
        ZDOTDIR: zdotdir,
      });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(42);
    } finally {
      rmSync(zdotdir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(bash === undefined)('commandWithManagedPath in Bash', () => {
  test('launches a function accepted by the presence probe', () => {
    const home = mkdtempSync(join(tmpdir(), 'ok-managed-path-bash-'));
    try {
      writeFileSync(join(home, '.bashrc'), 'slidev() { exit 43; }\n');
      const shell = bash ?? '/bin/bash';
      const command = commandWithManagedPath(shell, 'slidev deck.md --port 4300', ['/managed/bin']);
      const child = spawnInteractiveShellSync(shell, ['-i', '-c', command], {
        ...process.env,
        HOME: home,
      });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(43);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('commandWithManagedPath with no managed bin dir', () => {
  test.each([
    ['posix', '/bin/zsh'],
    ['fish', '/usr/bin/fish'],
    ['unrecognized', '/usr/bin/nu'],
  ])(
    'returns the command untouched for a %s shell, wrapping nothing around it',
    (_family, shell) => {
      const command = 'slidev deck.md --port 4300';
      expect(
        commandWithManagedPath(shell, command, []),
        'there is no reassert to carry when no dir resolves, and posixReassert([], cmd) is a syntax error, so the early return is the contract rather than an optimization',
      ).toBe(command);
    },
  );
});
