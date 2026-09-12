import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { ElectronApplication } from '@playwright/test';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  AppCleanupIncompleteError,
  captureAppProcess,
  closeAppBounded,
  taskkillTree,
} from '../smoke/_helpers/electron-cleanup';
import { reapedTaskkill } from '../smoke/_helpers/electron-cleanup.test-helper';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

const spawnMock = vi.mocked(spawn);

beforeEach(() => {
  spawnMock.mockReset();
});

const REAP_MS = 20;

interface MockProc extends EventEmitter {
  pid: number | undefined;
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killCalls: { pid: number; signal: NodeJS.Signals | string }[];
  stdio: ({ destroyed: boolean } | null | undefined)[];
  fireExit: (code?: number) => void;
  fireExitWithoutClose: (code?: number) => void;
  fireClose: () => void;
}

function makeProc(pid: number | undefined = 12345): MockProc {
  const ee = new EventEmitter() as MockProc;
  ee.pid = pid;
  ee.killed = false;
  ee.exitCode = null;
  ee.signalCode = null;
  ee.killCalls = [];
  ee.stdio = [];
  ee.fireExitWithoutClose = (code = 0) => {
    if (ee.exitCode !== null || ee.signalCode !== null) return;
    ee.exitCode = code;
    ee.emit('exit', code, null);
  };
  ee.fireClose = () => {
    if (ee.exitCode === null && ee.signalCode === null) {
      throw new Error('fireClose before exit: a ChildProcess never emits close ahead of exit');
    }
    if (ee.stdio.some((slot) => slot !== null && slot !== undefined && !slot.destroyed)) {
      throw new Error('fireClose with stdio still open: close follows every stdio slot closing');
    }
    ee.emit('close', ee.exitCode, ee.signalCode);
  };
  ee.fireExit = (code = 0) => {
    if (ee.exitCode !== null || ee.signalCode !== null) return;
    ee.fireExitWithoutClose(code);
    ee.fireClose();
  };
  return ee;
}

function mockKill(proc: MockProc) {
  return (pid: number, signal: NodeJS.Signals | string) => {
    proc.killCalls.push({ pid, signal });
    proc.killed = true;
    proc.signalCode = signal as NodeJS.Signals;
    proc.emit('exit', null, signal);
    proc.emit('close', null, signal);
  };
}

function scheduleExitIn(proc: MockProc, delayMs: number): NodeJS.Timeout {
  const t = setTimeout(() => proc.fireExit(0), delayMs);
  (t as unknown as { unref?: () => void }).unref?.();
  return t;
}

describe('captureAppProcess — registration-time process capture', () => {
  test('returns the raw ChildProcess from app.process()', () => {
    const proc = makeProc();
    const app = { process: () => proc } as unknown as ElectronApplication;
    expect(captureAppProcess(app)).toBe(proc as unknown as ChildProcess);
  });

  test('propagates app.process() throw at registration time (load-bearing)', () => {
    const app = {
      process: () => {
        throw new TypeError("Cannot read properties of undefined (reading '_object')");
      },
    } as unknown as ElectronApplication;
    expect(() => captureAppProcess(app)).toThrow(/_object/);
  });
});

describe('closeAppBounded — bounded-time process-group reap', () => {
  test('graceful exit fires within budget → no kill', async () => {
    const proc = makeProc();
    scheduleExitIn(proc, 50);
    const kill = mockKill(proc);

    const start = Date.now();
    await closeAppBounded(proc as unknown as ChildProcess, {
      gracefulMs: 5_000,
      kill,
      platform: 'linux',
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
    expect(proc.killCalls).toEqual([]);
    expect(proc.exitCode).toBe(0);
  });

  test('hung process → after gracefulMs, force-kills process group with SIGKILL', async () => {
    const proc = makeProc(12345);
    const kill = mockKill(proc);

    const start = Date.now();
    await closeAppBounded(proc as unknown as ChildProcess, {
      gracefulMs: 200,
      kill,
      platform: 'linux',
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2_000);

    expect(proc.killCalls.length).toBeGreaterThanOrEqual(1);
    const firstKill = proc.killCalls[0];
    expect(firstKill).toBeDefined();
    expect(firstKill?.pid).toBe(-12345);
    expect(firstKill?.signal).toBe('SIGKILL');
  });

  test('hung process on win32 → tree-kills via taskkill, never the negated PID', async () => {
    const proc = makeProc(23456);
    const kill = mockKill(proc);
    const taskkillPids: number[] = [];

    await expect(
      closeAppBounded(proc as unknown as ChildProcess, {
        gracefulMs: 200,
        postKillReapMs: REAP_MS,
        kill,
        taskkill: async (pid) => {
          taskkillPids.push(pid);
          return reapedTaskkill(pid);
        },
        platform: 'win32',
      }),
    ).rejects.toBeInstanceOf(AppCleanupIncompleteError);

    expect(taskkillPids).toEqual([23456, 23456]);
    expect(proc.killCalls).toEqual([]);
  });

  test('win32 → does not resolve until the tree is actually reaped', async () => {
    const proc = makeProc(23458);
    let resolved = false;

    const pending = closeAppBounded(proc as unknown as ChildProcess, {
      gracefulMs: 1_000,
      taskkill: async (pid) => {
        setTimeout(() => proc.fireExit(0), 150);
        return reapedTaskkill(pid);
      },
      platform: 'win32',
    }).then(() => {
      resolved = true;
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(resolved).toBe(false);

    await pending;
    expect(resolved).toBe(true);
    expect(proc.exitCode).toBe(0);
  });

  test('graceful exit on win32 → no taskkill (idempotency holds on both branches)', async () => {
    const proc = makeProc(23457);
    scheduleExitIn(proc, 50);
    const taskkillPids: number[] = [];

    await closeAppBounded(proc as unknown as ChildProcess, {
      gracefulMs: 5_000,
      kill: mockKill(proc),
      taskkill: async (pid) => {
        taskkillPids.push(pid);
        return reapedTaskkill(pid);
      },
      platform: 'win32',
    });

    expect(taskkillPids).toEqual([]);
    expect(proc.exitCode).toBe(0);
  });

  test('already-exited process → no kill (idempotent on dead)', async () => {
    const proc = makeProc(11111);
    proc.exitCode = 0;
    const kill = mockKill(proc);

    await closeAppBounded(proc as unknown as ChildProcess, {
      gracefulMs: 5_000,
      kill,
      platform: 'linux',
    });

    expect(proc.killCalls).toEqual([]);
  });

  test('a signal was sent but nothing exited → `killed` is not closure, so the group kill still fires', async () => {
    const proc = makeProc(22222);
    proc.killed = true;
    const killCalls: MockProc['killCalls'] = [];
    const noopKill = (pid: number, signal: NodeJS.Signals | string) => {
      killCalls.push({ pid, signal });
    };

    await expect(
      closeAppBounded(proc as unknown as ChildProcess, {
        gracefulMs: 100,
        postKillReapMs: REAP_MS,
        kill: noopKill,
        platform: 'linux',
      }),
    ).rejects.toBeInstanceOf(AppCleanupIncompleteError);

    expect(killCalls).toEqual([
      { pid: -22222, signal: 'SIGKILL' },
      { pid: -22222, signal: 'SIGKILL' },
    ]);
  });

  test('process killed by external signal → no kill (idempotent on signalCode-set)', async () => {
    const proc = makeProc(33333);
    proc.signalCode = 'SIGTERM';
    const kill = mockKill(proc);

    await closeAppBounded(proc as unknown as ChildProcess, {
      gracefulMs: 5_000,
      kill,
      platform: 'linux',
    });

    expect(proc.killCalls).toEqual([]);
  });

  test('missing pid → no kill lever exists, so closure is reported as unestablished', async () => {
    const proc = makeProc();
    proc.pid = undefined;
    const kill = mockKill(proc);

    const rejection = await closeAppBounded(proc as unknown as ChildProcess, {
      gracefulMs: 100,
      postKillReapMs: REAP_MS,
      kill,
      platform: 'linux',
    }).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(AppCleanupIncompleteError);
    expect((rejection as AppCleanupIncompleteError).attempts.map((a) => a.lever)).toEqual([
      'no-pid',
    ]);
    expect(proc.killCalls).toEqual([]);
  });

  test('kill-fn throws ESRCH → the throw is recorded in the report, never propagated raw', async () => {
    const proc = makeProc(99999);
    let killAttempts = 0;
    const throwingKill = (_pid: number, _signal: NodeJS.Signals | string) => {
      killAttempts += 1;
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    };

    const rejection = await closeAppBounded(proc as unknown as ChildProcess, {
      gracefulMs: 100,
      postKillReapMs: REAP_MS,
      kill: throwingKill,
      platform: 'linux',
    }).catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(AppCleanupIncompleteError);
    const thrown = (rejection as AppCleanupIncompleteError).attempts.map((attempt) =>
      attempt.lever === 'group-kill' && attempt.thrown instanceof Error
        ? attempt.thrown.message
        : attempt.lever,
    );
    expect(thrown).toEqual(['kill ESRCH', 'kill ESRCH']);
    expect(killAttempts).toBe(2);
  });

  test('a repeat call after failed close rethrows cached failure, then real close wins', async () => {
    const proc = makeProc(66666);
    const killCalls: MockProc['killCalls'] = [];
    const kill = (pid: number, signal: NodeJS.Signals | string) => {
      killCalls.push({ pid, signal });
    };
    const opts = { gracefulMs: 50, postKillReapMs: REAP_MS, kill, platform: 'linux' as const };

    const first = await closeAppBounded(proc as unknown as ChildProcess, opts).catch(
      (error: unknown) => error,
    );
    expect(first).toBeInstanceOf(AppCleanupIncompleteError);
    const killsAfterFirst = killCalls.length;

    const second = await closeAppBounded(proc as unknown as ChildProcess, opts).catch(
      (error: unknown) => error,
    );
    expect(second).toBe(first);
    expect(killCalls.length).toBe(killsAfterFirst);

    proc.fireExit(0);
    await expect(closeAppBounded(proc as unknown as ChildProcess, opts)).resolves.toBeUndefined();
  });

  test('idempotency — second call after kill is a no-op', async () => {
    const proc = makeProc(44444);
    const kill = mockKill(proc);

    await closeAppBounded(proc as unknown as ChildProcess, {
      gracefulMs: 100,
      kill,
      platform: 'linux',
    });
    const killCountAfterFirst = proc.killCalls.length;
    expect(killCountAfterFirst).toBe(1);

    await closeAppBounded(proc as unknown as ChildProcess, {
      gracefulMs: 100,
      kill,
      platform: 'linux',
    });

    expect(proc.killCalls.length).toBe(killCountAfterFirst);
  });

  test('exited at first sight with stdio a descendant still holds is not closure', async () => {
    const proc = makeProc(55555);
    proc.exitCode = 0;
    proc.stdio = [{ destroyed: false }, { destroyed: false }, { destroyed: false }];
    const kill = mockKill(proc);
    let resolved = false;

    const pending = closeAppBounded(proc as unknown as ChildProcess, {
      gracefulMs: 5_000,
      kill,
      platform: 'linux',
    }).then(() => {
      resolved = true;
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(resolved).toBe(false);
    expect(proc.killCalls).toEqual([]);

    for (const slot of proc.stdio) {
      if (slot !== null && slot !== undefined) slot.destroyed = true;
    }
    proc.fireClose();
    await pending;

    expect(resolved).toBe(true);
  });

  test("'exit' without 'close' leaves the call pending — an exited process whose stdio flags already read shut is not closure", async () => {
    const proc = makeProc(77777);
    const kill = mockKill(proc);
    let resolved = false;

    const pending = closeAppBounded(proc as unknown as ChildProcess, {
      gracefulMs: 5_000,
      kill,
      platform: 'linux',
    }).then(() => {
      resolved = true;
    });

    proc.fireExitWithoutClose(0);
    await new Promise((r) => setTimeout(r, 50));

    expect(resolved).toBe(false);
    expect(proc.killCalls).toEqual([]);

    proc.fireClose();
    await pending;

    expect(resolved).toBe(true);
  });

  test('null proc → no-op (safe to call when capture failed before assignment)', async () => {
    await closeAppBounded(null, { gracefulMs: 5_000 });
    expect(true).toBe(true);
  });

  test('REGRESSION (PR #677): cleanup never touches the wrapper, so disposed channels cannot crash it', async () => {
    const proc = makeProc(55555);
    scheduleExitIn(proc, 50);
    const kill = mockKill(proc);

    await closeAppBounded(proc as unknown as ChildProcess, {
      gracefulMs: 5_000,
      kill,
      platform: 'linux',
    });

    expect(proc.exitCode).toBe(0);
    expect(proc.killCalls).toEqual([]);
  });
});

interface FakeTaskkillChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (signal?: NodeJS.Signals) => boolean;
  killSignals: (NodeJS.Signals | undefined)[];
}

function fakeTaskkillChild(): FakeTaskkillChild {
  const child = new EventEmitter() as FakeTaskkillChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    return true;
  };
  return child;
}

describe('taskkillTree — the shipped win32 lever', () => {
  test('spawns the tree-kill with the pinned argv and reports what Windows said', async () => {
    const child = fakeTaskkillChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const outcome = taskkillTree(23456);
    child.stdout.emit('data', Buffer.from('SUCCESS: terminated.\r\n', 'utf8'));
    child.stderr.emit('data', Buffer.from('', 'utf8'));
    child.emit('close', 0, null);

    await expect(outcome).resolves.toEqual({
      status: 0,
      signal: null,
      stdout: 'SUCCESS: terminated.\r\n',
      stderr: '',
      timedOut: false,
    });
    expect(vi.mocked(spawn)).toHaveBeenCalledWith('taskkill', ['/pid', '23456', '/T', '/F'], {
      windowsHide: true,
    });
  });

  test('a taskkill that never exits is abandoned on its own timeout rather than blocking cleanup', async () => {
    vi.useFakeTimers();
    try {
      const child = fakeTaskkillChild();
      vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);

      const outcome = taskkillTree(23456);
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(outcome).resolves.toMatchObject({ timedOut: true, status: null });
      expect(child.killSignals).toEqual(['SIGKILL']);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a taskkill that cannot be spawned reports the error instead of throwing', async () => {
    const child = fakeTaskkillChild();
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const outcome = taskkillTree(23456);
    child.emit('error', new Error('spawn taskkill ENOENT'));

    await expect(outcome).resolves.toMatchObject({
      timedOut: false,
      error: expect.objectContaining({ message: 'spawn taskkill ENOENT' }),
    });
  });
});
