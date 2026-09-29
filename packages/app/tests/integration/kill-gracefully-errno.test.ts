import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { killGracefully, killGroup, signalTree } from '../stress/_helpers/server-process.ts';

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`kill ${code}`), { code });
}

function fakeChild(options: {
  pid?: number;
  kill: () => boolean;
}): ChildProcess & { emitError: (err: Error) => void } {
  const emitter = new EventEmitter() as EventEmitter & Record<string, unknown>;
  emitter.pid = options.pid ?? 424_242;
  emitter.exitCode = null;
  emitter.signalCode = null;
  emitter.kill = options.kill;
  (emitter as unknown as { emitError: (err: Error) => void }).emitError = (err: Error) => {
    emitter.emit('error', err);
  };
  return emitter as unknown as ChildProcess & { emitError: (err: Error) => void };
}

function silenceWarn() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {});
}

let warn: ReturnType<typeof silenceWarn>;

beforeEach(() => {
  warn = silenceWarn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('killGroup errno policy', () => {
  test('reports success when the group signal lands', () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    expect(killGroup(fakeChild({ pid: 9_001, kill: () => true }), 'SIGTERM')).toBe(true);
    expect(kill).toHaveBeenCalledWith(-9_001, 'SIGTERM');
  });

  test('swallows ESRCH and reports that nothing was signalled', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errnoError('ESRCH');
    });
    expect(killGroup(fakeChild({ pid: 9_001, kill: () => true }), 'SIGTERM')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  test('swallows EPERM and reports that nothing was signalled', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errnoError('EPERM');
    });
    expect(killGroup(fakeChild({ pid: 9_001, kill: () => true }), 'SIGKILL')).toBe(false);
  });

  test('warns on EPERM so a genuinely leaked tree still leaves a trace', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errnoError('EPERM');
    });
    killGroup(fakeChild({ pid: 9_001, kill: () => true }), 'SIGKILL');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('EPERM');
  });

  test.each(['EACCES', 'EINVAL', 'ENOSYS', undefined])(
    'rethrows %s rather than hiding it',
    (code) => {
      const err = code === undefined ? new Error('not an errno at all') : errnoError(code);
      vi.spyOn(process, 'kill').mockImplementation(() => {
        throw err;
      });
      expect(() => killGroup(fakeChild({ pid: 9_001, kill: () => true }), 'SIGTERM')).toThrow(err);
    },
  );

  test.each([0, 1, -5, 1.5, Number.NaN])(
    'refuses pid %p instead of signalling our own process group',
    (pid) => {
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      expect(killGroup(fakeChild({ pid, kill: () => true }), 'SIGKILL')).toBe(false);
      expect(kill).not.toHaveBeenCalled();
    },
  );
});

describe('killGroup signals the group only of a child that has not exited', () => {
  test.each([
    ['exits with a code', { exitCode: 0, signalCode: null }],
    ['is killed by a signal', { exitCode: null, signalCode: 'SIGKILL' }],
  ] as const)(
    'signals the group of a running child, and sends nothing once that child %s',
    (_label, exit) => {
      const sent: unknown[][] = [];
      vi.spyOn(process, 'kill').mockImplementation((...args) => {
        sent.push(args);
        return true;
      });
      expect(vi.isMockFunction(process.kill)).toBe(true);
      const proc = fakeChild({ pid: 424_242, kill: () => true });

      const whileRunning = killGroup(proc, 'SIGTERM');
      Object.assign(proc, exit);
      const afterExit = killGroup(proc, 'SIGKILL');

      expect({ whileRunning, afterExit, sent }).toEqual({
        whileRunning: true,
        afterExit: false,
        sent: [[-424_242, 'SIGTERM']],
      });
    },
  );
});

describe('signalTree errno policy', () => {
  beforeEach(() => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errnoError('ESRCH');
    });
  });

  test('reports the direct kill result instead of assuming success', () => {
    const proc = fakeChild({ kill: () => false });
    expect(signalTree(proc, 'SIGTERM')).toBe(false);
  });

  test('reports success when the direct kill lands', () => {
    const proc = fakeChild({ kill: () => true });
    expect(signalTree(proc, 'SIGTERM')).toBe(true);
  });

  test('tolerates EPERM delivered as an error event rather than a throw', () => {
    const proc = fakeChild({
      kill: () => {
        proc.emitError(errnoError('EPERM'));
        return false;
      },
    });
    expect(signalTree(proc, 'SIGKILL')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('rethrows a non-teardown errno delivered as an error event', () => {
    const err = errnoError('EACCES');
    const proc = fakeChild({
      kill: () => {
        proc.emitError(err);
        return false;
      },
    });
    expect(() => signalTree(proc, 'SIGKILL')).toThrow(err);
  });

  test('rethrows a synchronous EINVAL from the direct kill', () => {
    const err = errnoError('EINVAL');
    const proc = fakeChild({
      kill: () => {
        throw err;
      },
    });
    expect(() => signalTree(proc, 'SIGTERM')).toThrow(err);
  });

  test.each([
    ['a landed signal', () => true],
    ['a missed signal', () => false],
  ])('leaves no error listener behind after %s', (_label, kill) => {
    const proc = fakeChild({ kill });
    signalTree(proc, 'SIGTERM');
    expect(proc.listenerCount('error')).toBe(0);
  });

  test('leaves no error listener behind when the direct kill throws', () => {
    const proc = fakeChild({
      kill: () => {
        throw errnoError('EINVAL');
      },
    });
    expect(() => signalTree(proc, 'SIGTERM')).toThrow();
    expect(proc.listenerCount('error')).toBe(0);
  });

  test('does not suppress a pre-existing error listener', () => {
    const seen: Error[] = [];
    const proc = fakeChild({
      kill: () => {
        proc.emitError(errnoError('EPERM'));
        return false;
      },
    });
    proc.on('error', (err) => seen.push(err));
    signalTree(proc, 'SIGKILL');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.message).toContain('EPERM');
    expect(proc.listenerCount('error')).toBe(1);
  });
});

describe('killGracefully under a kill surface that reports EPERM everywhere', () => {
  test('resolves instead of failing a run whose tests have all passed', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errnoError('EPERM');
    });
    const proc = fakeChild({
      kill: () => {
        proc.emitError(errnoError('EPERM'));
        return false;
      },
    });
    await expect(killGracefully(proc, 500)).resolves.toBeUndefined();
  });

  test.each([
    ['exited with a code', { exitCode: 0, signalCode: null }],
    ['was killed by a signal', { exitCode: null, signalCode: 'SIGTERM' }],
  ] as const)(
    'sends nothing to the process group once the direct child %s, because its group id is no longer reserved',
    async (_label, exit) => {
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      const proc = fakeChild({ kill: () => true });
      Object.assign(proc, exit);
      await killGracefully(proc, 500);
      expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
    },
  );
});

describe('killGracefully drains the group of an exited leader until its probe answers ESRCH', () => {
  const LEADER_PID = 424_242;
  const PROBES_WHILE_MEMBERS_REMAIN = 3;

  function recordProbes(answer: (probe: number) => Error) {
    const sends: unknown[][] = [];
    const probedTargets: number[] = [];
    vi.spyOn(process, 'kill').mockImplementation((target, signal) => {
      if (signal !== 0) {
        sends.push([target, signal]);
        return true;
      }
      probedTargets.push(target);
      throw answer(probedTargets.length);
    });
    expect(vi.isMockFunction(process.kill)).toBe(true);
    return { sends, probedTargets };
  }

  function exitedLeader(): ChildProcess {
    const proc = fakeChild({ pid: LEADER_PID, kill: () => true });
    Object.assign(proc, { exitCode: 0, signalCode: null });
    return proc;
  }

  function leaderReported(): boolean {
    return warn.mock.calls.some(([message]) =>
      new RegExp(`(^|\\D)${LEADER_PID}(\\D|$)`).test(String(message)),
    );
  }

  test('keeps probing through EPERM answers and reports nothing once the group answers ESRCH', async () => {
    const { sends, probedTargets } = recordProbes((probe) =>
      errnoError(probe > PROBES_WHILE_MEMBERS_REMAIN ? 'ESRCH' : 'EPERM'),
    );

    await killGracefully(exitedLeader(), 500);

    expect({
      sends,
      probedTheLeaderGroupUntilItDrained:
        probedTargets.length > PROBES_WHILE_MEMBERS_REMAIN &&
        probedTargets.every((target) => target === -LEADER_PID),
      leaderReported: leaderReported(),
    }).toEqual({ sends: [], probedTheLeaderGroupUntilItDrained: true, leaderReported: false });
  });

  test('reports the leader when its group still answers EPERM at the bound', async () => {
    const { sends, probedTargets } = recordProbes(() => errnoError('EPERM'));

    await killGracefully(exitedLeader(), 500);

    expect({
      sends,
      probedMoreThanOnce: probedTargets.length > 1,
      leaderReported: leaderReported(),
    }).toEqual({ sends: [], probedMoreThanOnce: true, leaderReported: true });
  });

  test.each(['EACCES', 'EINVAL', 'ENOSYS', undefined])(
    'rethrows %s from the probe rather than reading it as a drained group',
    async (code) => {
      const err = code === undefined ? new Error('not an errno at all') : errnoError(code);
      recordProbes(() => err);
      await expect(killGracefully(exitedLeader(), 500)).rejects.toThrow(err);
    },
  );
});
