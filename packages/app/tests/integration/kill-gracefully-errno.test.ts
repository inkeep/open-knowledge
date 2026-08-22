/**
 * Errno policy for the e2e teardown kill path.
 *
 * The sibling `kill-gracefully-tree.test.ts` proves the tree really dies, with
 * real processes. This file proves the narrower thing real processes cannot be
 * made to demonstrate on demand: which signal errnos teardown absorbs, which it
 * still lets out, and that nothing here can ever address our own process group.
 *
 * The motivating failure was a Playwright run that reported `100 passed, 0
 * failed` and still exited 1, because a `kill EPERM` escaped a worker fixture's
 * teardown after every test had finished. Playwright counts that as "N errors
 * were not a part of any test" — a red run with a completely green report, and
 * in the merge queue an ejection that rebuilds everything behind it.
 *
 * `process.kill` and `ChildProcess.kill` fail in different shapes, so both are
 * exercised: the former throws, the latter returns false on ESRCH, throws only
 * for EINVAL/ENOSYS, and routes everything else (in practice EPERM) to an
 * 'error' EVENT — which is an uncaught throw when nothing is listening.
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { killGracefully, killGroup, signalTree } from '../stress/_helpers/server-process.ts';

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`kill ${code}`), { code });
}

/**
 * A ChildProcess-shaped stub whose `kill` each test supplies, so a test can
 * produce any of the three failure shapes Node's real `kill` has: return
 * false, throw, or emit an 'error' event (via `emitError`) and return false.
 */
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
    expect(killGroup(9_001, 'SIGTERM')).toBe(true);
    expect(kill).toHaveBeenCalledWith(-9_001, 'SIGTERM');
  });

  test('swallows ESRCH and reports that nothing was signalled', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errnoError('ESRCH');
    });
    expect(killGroup(9_001, 'SIGTERM')).toBe(false);
    // ESRCH is the ordinary end-of-life case; warning on it would be noise.
    expect(warn).not.toHaveBeenCalled();
  });

  test('swallows EPERM and reports that nothing was signalled', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errnoError('EPERM');
    });
    expect(killGroup(9_001, 'SIGKILL')).toBe(false);
  });

  test('warns on EPERM so a genuinely leaked tree still leaves a trace', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errnoError('EPERM');
    });
    killGroup(9_001, 'SIGKILL');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('EPERM');
  });

  test.each([
    'EACCES',
    'EINVAL',
    'ENOSYS',
    undefined,
  ])('rethrows %s rather than hiding it', (code) => {
    const err = code === undefined ? new Error('not an errno at all') : errnoError(code);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw err;
    });
    expect(() => killGroup(9_001, 'SIGTERM')).toThrow(err);
  });

  test.each([
    0,
    1,
    -5,
    1.5,
    Number.NaN,
  ])('refuses pid %p instead of signalling our own process group', (pid) => {
    // kill(-0) collapses to kill(0), which signals the caller's own group —
    // here, the whole test run. kill(-1) broadcasts. Neither may ever be
    // reached, so the guard must fire before the syscall.
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    expect(killGroup(pid, 'SIGKILL')).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('signalTree errno policy', () => {
  beforeEach(() => {
    // Force the direct-child fallback: the group attempt must miss so each
    // test below exercises the ChildProcess.kill half.
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw errnoError('ESRCH');
    });
  });

  test('reports the direct kill result instead of assuming success', () => {
    // ChildProcess.kill returns false on ESRCH without throwing, so a caller
    // that ignores the return value claims a signal landed when none did.
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
    // Converting the unhandled 'error' event into a synchronous throw at the
    // call site is the point: same failure, diagnosable stack.
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
    // The worker fixture and the warm-cache setup both register their own
    // 'error' listener for spawn failures; the temporary one must be additive.
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
    // The regression: this rejected, and Playwright attributed the rejection to
    // no test at all.
    await expect(killGracefully(proc, 500)).resolves.toBeUndefined();
  });

  test('still sweeps the group when the direct child has already exited', async () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const proc = fakeChild({ kill: () => true });
    (proc as unknown as { exitCode: number | null }).exitCode = 0;
    await killGracefully(proc, 500);
    expect(kill).toHaveBeenCalledWith(-424_242, 'SIGKILL');
  });
});
