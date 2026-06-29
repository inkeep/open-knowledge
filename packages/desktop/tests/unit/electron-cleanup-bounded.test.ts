import { describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { ElectronApplication } from '@playwright/test';
import { captureAppProcess, closeAppBounded } from '../smoke/_helpers/electron-cleanup';


interface MockProc extends EventEmitter {
  pid: number | undefined;
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killCalls: { pid: number; signal: NodeJS.Signals | string }[];
  fireExit: (code?: number) => void;
}

function makeProc(pid: number | undefined = 12345): MockProc {
  const ee = new EventEmitter() as MockProc;
  ee.pid = pid;
  ee.killed = false;
  ee.exitCode = null;
  ee.signalCode = null;
  ee.killCalls = [];
  ee.fireExit = (code = 0) => {
    if (ee.exitCode !== null || ee.signalCode !== null) return;
    ee.exitCode = code;
    ee.emit('exit', code, null);
  };
  return ee;
}

function mockKill(proc: MockProc) {
  return (pid: number, signal: NodeJS.Signals | string) => {
    proc.killCalls.push({ pid, signal });
    proc.killed = true;
    proc.signalCode = signal as NodeJS.Signals;
    proc.emit('exit', null, signal);
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
    scheduleExitIn(proc, 50); // exits before gracefulMs
    const kill = mockKill(proc);

    const start = Date.now();
    await closeAppBounded(proc as unknown as ChildProcess, {
      gracefulMs: 5_000,
      kill,
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500); // returned soon after exit fired
    expect(proc.killCalls).toEqual([]); // no kill invoked
    expect(proc.exitCode).toBe(0); // exit fired naturally
  });

  test('hung process → after gracefulMs, force-kills process group with SIGKILL', async () => {
    const proc = makeProc(12345);
    const kill = mockKill(proc);

    const start = Date.now();
    await closeAppBounded(proc as unknown as ChildProcess, {
      gracefulMs: 200,
      kill,
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2_000);

    expect(proc.killCalls.length).toBeGreaterThanOrEqual(1);
    const firstKill = proc.killCalls[0];
    expect(firstKill).toBeDefined();
    expect(firstKill?.pid).toBe(-12345);
    expect(firstKill?.signal).toBe('SIGKILL');
  });

  test('already-exited process → no kill (idempotent on dead)', async () => {
    const proc = makeProc(11111);
    proc.exitCode = 0;
    const kill = mockKill(proc);

    await closeAppBounded(proc as unknown as ChildProcess, {
      gracefulMs: 5_000,
      kill,
    });

    expect(proc.killCalls).toEqual([]);
  });

  test('already-killed process → no kill (idempotent on killed)', async () => {
    const proc = makeProc(22222);
    proc.killed = true;
    const kill = mockKill(proc);

    await closeAppBounded(proc as unknown as ChildProcess, {
      gracefulMs: 5_000,
      kill,
    });

    expect(proc.killCalls).toEqual([]);
  });

  test('process killed by external signal → no kill (idempotent on signalCode-set)', async () => {
    const proc = makeProc(33333);
    proc.signalCode = 'SIGTERM';
    const kill = mockKill(proc);

    await closeAppBounded(proc as unknown as ChildProcess, {
      gracefulMs: 5_000,
      kill,
    });

    expect(proc.killCalls).toEqual([]);
  });

  test('missing pid → graceful wait only, no kill attempted (defensive)', async () => {
    const proc = makeProc();
    proc.pid = undefined; // explicit override — JS coerces a passed `undefined` arg back to the default
    const kill = mockKill(proc);

    const start = Date.now();
    await closeAppBounded(proc as unknown as ChildProcess, {
      gracefulMs: 100,
      kill,
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2_000);
    expect(proc.killCalls).toEqual([]);
  });

  test('kill-fn throws ESRCH (kill→already-dead race) → catch swallows, resolves cleanly', async () => {
    const proc = makeProc(99999);
    let killAttempts = 0;
    const throwingKill = (_pid: number, _signal: NodeJS.Signals | string) => {
      killAttempts += 1;
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    };

    await closeAppBounded(proc as unknown as ChildProcess, {
      gracefulMs: 100,
      kill: throwingKill,
    });

    expect(killAttempts).toBeGreaterThanOrEqual(1);
  });

  test('idempotency — second call after kill is a no-op', async () => {
    const proc = makeProc(44444);
    const kill = mockKill(proc);

    await closeAppBounded(proc as unknown as ChildProcess, {
      gracefulMs: 100,
      kill,
    });
    const killCountAfterFirst = proc.killCalls.length;
    expect(killCountAfterFirst).toBe(1); // first call killed

    await closeAppBounded(proc as unknown as ChildProcess, {
      gracefulMs: 100,
      kill,
    });

    expect(proc.killCalls.length).toBe(killCountAfterFirst);
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
    });

    expect(proc.exitCode).toBe(0);
    expect(proc.killCalls).toEqual([]);
  });
});
