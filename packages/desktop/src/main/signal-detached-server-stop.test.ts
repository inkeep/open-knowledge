import { describe, expect, mock, test } from 'bun:test';
import {
  signalDetachedServerStop,
  signalStopOwnedUtilityForks,
  type UtilityProcessLike,
} from './window-manager.ts';

/** Minimal owned-utility-fork stub — only `.kill` is exercised. */
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
  test('sends SIGTERM to every detached server pid', () => {
    const killProbe = mock((_pid: number, _signal: number | NodeJS.Signals) => {});
    const signalled = signalDetachedServerStop(
      [
        ['/proj/a', 101],
        ['/proj/b', 202],
      ],
      killProbe,
    );
    expect(signalled).toBe(2);
    expect(killProbe).toHaveBeenCalledTimes(2);
    expect(killProbe).toHaveBeenNthCalledWith(1, 101, 'SIGTERM');
    expect(killProbe).toHaveBeenNthCalledWith(2, 202, 'SIGTERM');
  });

  test('treats an already-exited server (ESRCH) as done without logging a failure', () => {
    const killProbe = mock((_pid: number, _signal: number | NodeJS.Signals) => {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    const log = { warn: mock((_o: object, _m: string) => {}) };
    const signalled = signalDetachedServerStop([['/proj/gone', 303]], killProbe, log);
    expect(signalled).toBe(0);
    expect(log.warn).not.toHaveBeenCalled();
  });

  test('logs but never throws on a non-ESRCH signal failure, and continues to later pids', () => {
    const killProbe = mock((pid: number, _signal: number | NodeJS.Signals) => {
      if (pid === 404) {
        const err = new Error('operation not permitted') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
    });
    const log = { warn: mock((_o: object, _m: string) => {}) };
    // The EPERM pid is first to prove iteration continues past a failure.
    const signalled = signalDetachedServerStop(
      [
        ['/proj/locked', 404],
        ['/proj/ok', 505],
      ],
      killProbe,
      log,
    );
    expect(signalled).toBe(1);
    expect(killProbe).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toMatchObject({
      event: 'update-install-server-stop-failed',
      code: 'EPERM',
      pid: 404,
      projectPath: '/proj/locked',
    });
  });

  test('no entries (already drained — e.g. the Relaunch-now path) is a clean no-op', () => {
    const killProbe = mock((_pid: number, _signal: number | NodeJS.Signals) => {});
    expect(signalDetachedServerStop([], killProbe)).toBe(0);
    expect(killProbe).not.toHaveBeenCalled();
  });
});

describe('signalStopOwnedUtilityForks (shared utility-fork hard-kill)', () => {
  test('SIGKILLs every owned utility fork', () => {
    const killA = mock((_s: NodeJS.Signals) => {});
    const killB = mock((_s: NodeJS.Signals) => {});
    signalStopOwnedUtilityForks([ctx(true, killA, '/a'), ctx(true, killB, '/b')]);
    expect(killA).toHaveBeenCalledWith('SIGKILL');
    expect(killB).toHaveBeenCalledWith('SIGKILL');
  });

  test('skips contexts that do not own their server or have no utility', () => {
    const killOwned = mock((_s: NodeJS.Signals) => {});
    const killNotOwned = mock((_s: NodeJS.Signals) => {});
    signalStopOwnedUtilityForks([
      ctx(false, killNotOwned), // attached (sibling-owned) server — must not touch
      ctx(true, null), // detached server, no in-process utility fork
      ctx(true, killOwned), // the only one to kill
    ]);
    expect(killNotOwned).not.toHaveBeenCalled();
    expect(killOwned).toHaveBeenCalledWith('SIGKILL');
  });

  test('logs but never throws on a kill failure, and continues to later forks', () => {
    const killLater = mock((_s: NodeJS.Signals) => {});
    const throwing = mock((_s: NodeJS.Signals) => {
      throw new Error('already dead');
    });
    const log = { warn: mock((_o: object, _m: string) => {}) };
    signalStopOwnedUtilityForks([ctx(true, throwing, '/boom'), ctx(true, killLater, '/ok')], log);
    expect(killLater).toHaveBeenCalledWith('SIGKILL');
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toMatchObject({ projectPath: '/boom' });
  });
});
