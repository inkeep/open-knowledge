import type { SpawnSyncReturns } from 'node:child_process';
import { afterEach, describe, expect, test, vi } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn(() => false));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: spawnSyncMock };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: existsSyncMock };
});

const { detectGit, fallbackPaths, GitNotAvailableError, GitProbeTimeoutError } = await import(
  './git-preflight.ts'
);

function spawnError(code: string): SpawnSyncReturns<string> {
  const error = Object.assign(new Error(`spawnSync git ${code}`), { code });
  return { pid: 0, output: [], stdout: '', stderr: '', status: null, signal: null, error };
}

function exited(status: number, stdout: string): SpawnSyncReturns<string> {
  return { pid: 1, output: [], stdout, stderr: '', status, signal: null };
}

function timedOut(): SpawnSyncReturns<string> {
  const error = Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' });
  return { pid: 1, output: [], stdout: '', stderr: '', status: null, signal: 'SIGTERM', error };
}

function probeOf(fn: () => unknown) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(GitNotAvailableError);
    return (err as InstanceType<typeof GitNotAvailableError>).probe;
  }
  throw new Error('detectGit did not throw');
}

describe('detectGit probe reasons with a stubbed spawn', () => {
  afterEach(() => {
    spawnSyncMock.mockReset();
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(false);
  });

  test('a git on PATH that cannot be launched is spawn-failed, not enoent', () => {
    spawnSyncMock.mockReturnValue(spawnError('EACCES'));
    expect(probeOf(detectGit)).toEqual({ path: 'spawn-failed', fallback: null });
  });

  test('a timed-out git probe is not reported as GitNotAvailableError', () => {
    spawnSyncMock.mockReturnValue(timedOut());
    let thrown: unknown;
    try {
      detectGit();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeInstanceOf(GitNotAvailableError);
    expect(thrown).toBeInstanceOf(GitProbeTimeoutError);
  });

  test('a timed-out fallback probe is not reported as GitNotAvailableError', (ctx) => {
    const [candidate] = fallbackPaths(process.platform);
    ctx.skip(candidate === undefined, 'this platform has no fallback git candidates');
    existsSyncMock.mockImplementation((path: unknown) => path === candidate);
    spawnSyncMock.mockImplementation((command: string) =>
      command === 'git' ? spawnError('ENOENT') : timedOut(),
    );
    let thrown: unknown;
    try {
      detectGit();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GitProbeTimeoutError);
    expect(thrown).not.toBeInstanceOf(GitNotAvailableError);
  });

  test('timeout evidence survives a later fallback failure', (ctx) => {
    const candidates = fallbackPaths(process.platform);
    const first = candidates[0];
    const second = candidates[1];
    ctx.skip(
      first === undefined || second === undefined,
      'this platform has too few fallback candidates',
    );
    existsSyncMock.mockImplementation((path: unknown) => path === first || path === second);
    spawnSyncMock.mockImplementation((command: string) => {
      if (command === 'git') return spawnError('ENOENT');
      return command === first ? timedOut() : exited(1, '');
    });
    let thrown: unknown;
    try {
      detectGit();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(GitProbeTimeoutError);
    expect((thrown as InstanceType<typeof GitProbeTimeoutError>).probe).toEqual({
      path: 'enoent',
      fallback: 'timeout',
    });
  });

  test('a failing fallback candidate records its own reason', (ctx) => {
    const [candidate] = fallbackPaths(process.platform);
    ctx.skip(candidate === undefined, 'this platform has no fallback git candidates');
    existsSyncMock.mockImplementation((path: unknown) => path === candidate);
    spawnSyncMock.mockImplementation((command: string) =>
      command === 'git' ? spawnError('ENOENT') : exited(1, ''),
    );
    expect(probeOf(detectGit)).toEqual({ path: 'enoent', fallback: 'nonzero' });
    expect(spawnSyncMock).toHaveBeenCalledWith(candidate, ['--version'], expect.anything());
  });
});
