import { describe, expect, test, vi } from 'vitest';
import {
  type SpawnedServer,
  signalDetachedServerStop,
  signalStopOwnedUtilityForks,
  type UtilityProcessLike,
} from './window-manager.ts';

function child(
  pid: number,
  signal: (signal: NodeJS.Signals) => void,
  exit: ReturnType<SpawnedServer['readExit']> = null,
): SpawnedServer {
  return { pid, readExit: () => exit, signal };
}

function ctx(
  ownsServer: boolean,
  kill: ((signal: NodeJS.Signals) => void) | null,
  projectPath = '/proj',
) {
  return {
    ownsServer,
    utility: (kill ? { kill } : null) as unknown as UtilityProcessLike | null,
    projectPath,
  };
}

describe('signalDetachedServerStop (before-quit-for-update teardown)', () => {
  test('sends SIGTERM to every running detached server through its child', () => {
    const signals: Array<[number, NodeJS.Signals]> = [];
    const signalled = signalDetachedServerStop([
      ['/proj/a', child(101, (signal) => signals.push([101, signal]))],
      ['/proj/b', child(202, (signal) => signals.push([202, signal]))],
    ]);
    expect(signalled).toBe(2);
    expect(signals).toEqual([
      [101, 'SIGTERM'],
      [202, 'SIGTERM'],
    ]);
  });

  test('skips a server whose child has exited, so its pid is never signalled', () => {
    const signal = vi.fn();
    const log = { warn: vi.fn((_o: object, _m: string) => {}) };
    const signalled = signalDetachedServerStop(
      [['/proj/gone', child(303, signal, { code: 0, signal: null })]],
      log,
    );
    expect(signalled).toBe(0);
    expect(signal).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  test('logs but never throws on a signal failure, and continues to later servers', () => {
    const later = vi.fn();
    const log = { warn: vi.fn((_o: object, _m: string) => {}) };
    const signalled = signalDetachedServerStop(
      [
        [
          '/proj/locked',
          child(404, () => {
            const err = new Error('operation not permitted') as NodeJS.ErrnoException;
            err.code = 'EPERM';
            throw err;
          }),
        ],
        ['/proj/ok', child(505, later)],
      ],
      log,
    );
    expect(signalled).toBe(1);
    expect(later).toHaveBeenCalledWith('SIGTERM');
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toMatchObject({
      event: 'update-install-server-stop-failed',
      code: 'EPERM',
      pid: 404,
      projectPath: '/proj/locked',
    });
  });

  test('no entries (already drained — e.g. the Relaunch-now path) is a clean no-op', () => {
    expect(signalDetachedServerStop([])).toBe(0);
  });
});

describe('signalStopOwnedUtilityForks (shared utility-fork hard-kill)', () => {
  test('SIGKILLs every owned utility fork', () => {
    const killA = vi.fn((_s: NodeJS.Signals) => {});
    const killB = vi.fn((_s: NodeJS.Signals) => {});
    signalStopOwnedUtilityForks([ctx(true, killA, '/a'), ctx(true, killB, '/b')]);
    expect(killA).toHaveBeenCalledWith('SIGKILL');
    expect(killB).toHaveBeenCalledWith('SIGKILL');
  });

  test('skips contexts that do not own their server or have no utility', () => {
    const killOwned = vi.fn((_s: NodeJS.Signals) => {});
    const killNotOwned = vi.fn((_s: NodeJS.Signals) => {});
    signalStopOwnedUtilityForks([ctx(false, killNotOwned), ctx(true, null), ctx(true, killOwned)]);
    expect(killNotOwned).not.toHaveBeenCalled();
    expect(killOwned).toHaveBeenCalledWith('SIGKILL');
  });

  test('logs but never throws on a kill failure, and continues to later forks', () => {
    const killLater = vi.fn((_s: NodeJS.Signals) => {});
    const throwing = vi.fn((_s: NodeJS.Signals) => {
      throw new Error('already dead');
    });
    const log = { warn: vi.fn((_o: object, _m: string) => {}) };
    signalStopOwnedUtilityForks([ctx(true, throwing, '/boom'), ctx(true, killLater, '/ok')], log);
    expect(killLater).toHaveBeenCalledWith('SIGKILL');
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toMatchObject({ projectPath: '/boom' });
  });
});
