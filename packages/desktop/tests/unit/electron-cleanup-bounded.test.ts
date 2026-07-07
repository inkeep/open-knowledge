import { describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { ElectronApplication } from '@playwright/test';
import { captureAppProcess, closeAppBounded } from '../smoke/_helpers/electron-cleanup';

/**
 * Pins the bounded-time + force-kill contract of `closeAppBounded`, the
 * primitive used by the `captureStderrFor` smoke fixture's teardown to
 * guarantee that every Electron process group launched in a smoke test is
 * reaped within a bounded budget — even when the underlying process hangs.
 *
 * Why this contract is load-bearing: when a Playwright smoke test attempt
 * times out (60s per `playwright.config.ts`), Playwright cancels the
 * test body's microtask queue. The user-written `try { ... } finally {
 * await app.close() }` does not complete; the Electron child process
 * group is orphaned. Across 5 tests in a single Playwright worker (the
 * `desktop-smoke` config has `workers: 1`), accumulated orphan process
 * groups hold open file descriptors → Node can't exit cleanly →
 * Playwright's worker-teardown deadline (= `project.timeout` = 60s) fires
 * → SIGKILL the worker → reporter classifies as "1 error not part of any
 * test" → exit 1.
 *
 * The fix moves cleanup ownership from test-body finally blocks (which
 * are interrupted by Playwright's per-test timeout) to the fixture's
 * teardown (which is guaranteed to run, even on test-body interruption).
 *
 * The PRIOR shape `closeAppBounded(app, opts)` re-queried `app.process()`
 * at teardown — but Playwright's `ElectronApplication.process()` throws
 * after `app.close()` resolves (the dispatcher record is removed from
 * `_dispatcherByGuid` and `toImpl()` dereferences `undefined._object`).
 * Every
 * smoke test body has a `finally { await app.close(); }` that runs before
 * the fixture teardown, so the wrapper is reliably disposed by the time
 * cleanup runs.
 *
 * The CURRENT shape `closeAppBounded(proc, opts)` operates on the raw
 * Node `ChildProcess` captured at registration time (via
 * `captureAppProcess(app)`, called inside the fixture's `use()` callback
 * when the channel is alive). The OS process record outlives Playwright's
 * API state, so cleanup is robust to disposed-channel state by
 * construction.
 *
 * `closeAppBounded(proc, opts)` provides the bounded-close primitive:
 *   1. Waits up to `gracefulMs` for the process to exit on its own
 *      (typical when test body's `app.close()` already kicked off
 *      shutdown).
 *   2. If the grace period elapses, force-kills the process group via
 *      `process.kill(-pid, 'SIGKILL')` — the same kill that Playwright's
 *      processLauncher uses on the kill path (kills Electron main +
 *      helpers + utility process tree atomically on POSIX systems).
 *   3. Idempotent on already-exited / already-killed processes — safe to
 *      call from multiple cleanup sites without double-kill errors.
 *
 * If you change this contract, you are changing the timing invariant
 * that protects the desktop-smoke job from worker-teardown-class
 * exit-1 failures.
 */

interface MockProc extends EventEmitter {
  pid: number | undefined;
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killCalls: { pid: number; signal: NodeJS.Signals | string }[];
  /** Drive a graceful exit: marks exitCode + emits 'exit'. */
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

/**
 * Build a kill spy that pushes invocations to `proc.killCalls` and
 * mirrors Node's effect: marks the proc killed + sets signalCode.
 * Lets the test assert which kill arguments were sent without monkey-
 * patching the global `process.kill`.
 */
function mockKill(proc: MockProc) {
  return (pid: number, signal: NodeJS.Signals | string) => {
    proc.killCalls.push({ pid, signal });
    proc.killed = true;
    proc.signalCode = signal as NodeJS.Signals;
    proc.emit('exit', null, signal);
  };
}

/**
 * Schedule a graceful exit after `delayMs`. Returns the timer so the test
 * can clean up if needed (we unref so it never blocks the runner).
 */
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
    // captureAppProcess is intended to be called WHILE the channel is
    // alive. If the caller invokes it on a disposed app, it must surface
    // the throw immediately — the bug we're protecting against is calling
    // app.process() at teardown (post-close), where it throws SILENTLY
    // wrt the test body and crashes the fixture. At registration time,
    // surfacing the throw is correct: the caller is doing the wrong
    // thing and should know immediately.
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
    // Don't schedule any exit — process hangs forever.
    const kill = mockKill(proc);

    const start = Date.now();
    await closeAppBounded(proc as unknown as ChildProcess, {
      gracefulMs: 200,
      kill,
    });
    const elapsed = Date.now() - start;

    // Upper-bounded by gracefulMs + small slack for the kill itself.
    // Lower bound is intentionally loose: under CPU contention from
    // parallel test execution, setTimeout fires at "approximately"
    // gracefulMs and Date.now() granularity adds jitter — pinning the
    // exact graceful-budget value would be flaky without adding test
    // value (the FORCE-KILL invariant is what matters, asserted below).
    expect(elapsed).toBeLessThan(2_000);

    // Kill was invoked with the negated PID (process-group kill on POSIX)
    // and SIGKILL.
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
    // Distinct from the .killed check: a process can have signalCode set
    // (was killed by a signal, e.g. parent process group reaped it) without
    // .killed === true (only set when WE called kill on it). The cleanup
    // primitive must treat signalCode !== null as dead.
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
    // If proc.pid is undefined (unlikely in practice — Playwright sets it
    // on launch — but the helper must not throw on this shape), the kill
    // path is skipped. The graceful wait still runs and times out.
    const proc = makeProc();
    proc.pid = undefined; // explicit override — JS coerces a passed `undefined` arg back to the default
    const kill = mockKill(proc);

    const start = Date.now();
    await closeAppBounded(proc as unknown as ChildProcess, {
      gracefulMs: 100,
      kill,
    });
    const elapsed = Date.now() - start;

    // Upper-bounded only — see "hung process" test for rationale on the
    // missing lower bound.
    expect(elapsed).toBeLessThan(2_000);
    expect(proc.killCalls).toEqual([]);
  });

  test('kill-fn throws ESRCH (kill→already-dead race) → catch swallows, resolves cleanly', async () => {
    // Pins the empty catch in electron-cleanup.ts. POSIX has no atomic
    // "is-it-alive AND kill-it" syscall, so a process can exit between the
    // `isProcessGone(proc)` check and the kill — the kernel then returns
    // ESRCH (no such process). The catch swallows because the goal
    // (process is dead) is achieved by other means.
    //
    // Without this catch, the race surfaces as an unhandled promise
    // rejection in fixture teardown → "1 error not part of any test" →
    // exit 1 under Playwright's reporter — the same failure mode the
    // bounded-cleanup contract exists to prevent.
    const proc = makeProc(99999);
    // Don't schedule any exit — proc appears hung until the kill attempt,
    // which throws as if the OS had already reaped it.
    let killAttempts = 0;
    const throwingKill = (_pid: number, _signal: NodeJS.Signals | string) => {
      killAttempts += 1;
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    };

    // Must NOT throw or reject — closeAppBounded swallows the kill error.
    // If the catch became unreachable or the throw escaped, this await
    // would propagate and Bun would mark the test failed.
    await closeAppBounded(proc as unknown as ChildProcess, {
      gracefulMs: 100,
      kill: throwingKill,
    });

    // Proves the catch path was actually exercised. Without this, a future
    // refactor that short-circuited before the kill (e.g. an over-eager
    // isProcessGone re-check) would silently pass this test even though
    // the catch became unreachable — a tautology disguised as a regression
    // pin.
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

    // Second call: process is now killed; no further kill should fire.
    await closeAppBounded(proc as unknown as ChildProcess, {
      gracefulMs: 100,
      kill,
    });

    expect(proc.killCalls.length).toBe(killCountAfterFirst);
  });

  test('null proc → no-op (safe to call when capture failed before assignment)', async () => {
    // Test files pattern `let proc: ChildProcess | null = null; try {
    // proc = captureAppProcess(app); } catch { /* swallow */ } finally
    // { closeAppBounded(proc); }`. closeAppBounded must accept null
    // without throwing.
    await closeAppBounded(null, { gracefulMs: 5_000 });
    // No assertion needed beyond "did not throw".
    expect(true).toBe(true);
  });

  test('REGRESSION (PR #677): cleanup never touches the wrapper, so disposed channels cannot crash it', async () => {
    // The bug introduced by the prior fix was: `closeAppBounded(app, opts)`
    // called `app.process()` at teardown. After the test body's `finally
    // { await app.close(); }` resolves, Playwright's dispatcher record is
    // removed from `_dispatcherByGuid`. Subsequent `app.process()` calls
    // throw `TypeError: Cannot read properties of undefined (reading
    // '_object')`. Every smoke test followed this pattern → every fixture
    // teardown crashed → every test attempt failed → 20 tests RED in CI.
    //
    // The architectural fix: capture the underlying ChildProcess at
    // registration time (via `captureAppProcess(app)`, called inside the
    // fixture's `use()` callback when the channel is alive). Cleanup
    // operates on the captured ChildProcess directly — never re-queries
    // the wrapper, so the disposed-channel state is structurally
    // unreachable.
    //
    // This test pins the structural property: closeAppBounded never
    // touches an ElectronApplication. It takes a ChildProcess. There's
    // no way for it to crash from disposed-channel state because it
    // can't access the wrapper at all.
    //
    // Note: this is partially a structural test (the type signature
    // proves it) plus a behavioral assertion (cleanup completes when
    // operating on a captured proc whose origin app would throw if
    // queried). The fixture's job is to never re-query, and that's
    // verified at the fixture level (smoke-test.ts) by composition.
    const proc = makeProc(55555);
    scheduleExitIn(proc, 50);
    const kill = mockKill(proc);

    // No app reference is passed at all — proves the primitive is
    // wrapper-independent.
    await closeAppBounded(proc as unknown as ChildProcess, {
      gracefulMs: 5_000,
      kill,
    });

    expect(proc.exitCode).toBe(0);
    expect(proc.killCalls).toEqual([]);
  });
});
