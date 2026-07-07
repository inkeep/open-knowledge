/**
 * Real-subprocess narrow-integration test for `closeAppBounded` — the
 * primitive used by the `captureStderrFor` smoke fixture's teardown to
 * guarantee bounded reap of every Electron process group launched in a
 * smoke test.
 *
 * Why this is a NARROW INTEGRATION test, not a unit test: tests (a) and
 * (c) observe real `'exit'` events from a real Node `ChildProcess`
 * (the mock unit tier fires `'exit'` synthetically via EventEmitter,
 * which can't catch regressions in how the primitive consumes the real
 * event stream). Test (b)'s differentiation is real `proc.pid` flow
 * from `spawn` into the negated-PID kill argument — the spy
 * deliberately doesn't deliver the kill (the contract is "bounded fires
 * within budget" — OS-level signal-receipt is a separate concern). The
 * sibling unit test at `tests/unit/electron-cleanup-bounded.test.ts`
 * already pins call patterns against mocked ChildProcess + mocked kill
 * spies; this file complements that with real subprocess spawn + real
 * PID flow + real wall-clock measurement, so a regression in real-PID
 * arg construction or real-`'exit'`-event consumption is caught at the
 * OS layer that production smoke fixtures actually run against.
 *
 * Why this lives in `_helpers/` rather than `tests/unit/`: it's a sibling
 * of `electron-cleanup.ts` and `parse-timeouts.test.ts`, both of which
 * carry test infrastructure that the smoke harness depends on. Keeping
 * tests next to the helpers they exercise makes ownership obvious when a
 * future helper change requires updating the contract.
 *
 * Contract these tests protect: the primitive's interaction with the OS
 * — real-process `'exit'` event observation, real-PID kill argument
 * construction, real wall-clock budget enforcement. Real-signal-receipt
 * verification (i.e., asserting `proc.signalCode === 'SIGKILL'` after
 * delivery) is intentionally out of scope here — the afterEach reaper
 * handles real cleanup, and a real-delivery variant would race the
 * reaper without adding signal beyond the existing assertions.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { closeAppBounded } from './electron-cleanup';

/**
 * Subprocess tracker for afterEach teardown. The `kill` spy in some tests
 * records the kill call but does not actually deliver the signal — so the
 * underlying process is still alive when `closeAppBounded` returns. The
 * teardown reaper guarantees we don't leak hung subprocesses across tests.
 */
const spawnedProcs: ChildProcess[] = [];

afterEach(() => {
  for (const proc of spawnedProcs) {
    if (
      proc.pid !== undefined &&
      !proc.killed &&
      proc.exitCode === null &&
      proc.signalCode === null
    ) {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        // Best-effort — the proc may have exited between the check and the
        // kill (ESRCH); either way the test teardown goal is achieved.
      }
    }
  }
  spawnedProcs.length = 0;
});

/**
 * Spawn a real Node subprocess with the given inline body. `detached: true`
 * creates a new process group so `process.kill(-pid, SIGKILL)` reaps the
 * whole group — same shape Playwright's processLauncher uses on close.
 * `stdio: 'ignore'` prevents the subprocess's
 * stdout/stderr from polluting the test runner output.
 */
function spawnNode(body: string): ChildProcess {
  const proc = spawn('node', ['-e', body], {
    detached: true,
    stdio: 'ignore',
  });
  spawnedProcs.push(proc);
  return proc;
}

/**
 * Wait until `proc.pid` is populated (spawn complete). Bun's `spawn` is
 * synchronous wrt pid assignment in practice, but defensive against
 * future async-spawn shapes.
 */
async function awaitSpawn(proc: ChildProcess): Promise<void> {
  if (proc.pid !== undefined) return;
  await new Promise<void>((resolve) => {
    proc.once('spawn', () => resolve());
  });
}

describe('closeAppBounded — real subprocess contract', () => {
  test('(a) graceful exit during gracefulMs wait → returns shortly after exit, no SIGKILL fired', async () => {
    // Subprocess exits naturally after ~100 ms — well within the 5_000 ms
    // graceful budget. closeAppBounded should observe the 'exit' event and
    // return without invoking the kill function.
    const proc = spawnNode(`setTimeout(() => process.exit(0), 100);`);
    await awaitSpawn(proc);

    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | string }> = [];
    const spyKill = (pid: number, signal: NodeJS.Signals | string) => {
      killCalls.push({ pid, signal });
    };

    const start = Date.now();
    await closeAppBounded(proc, { gracefulMs: 5_000, kill: spyKill });
    const elapsed = Date.now() - start;

    // Subprocess takes ~100 ms to exit; closeAppBounded should return
    // shortly thereafter. Generous upper bound to absorb CI scheduler jitter.
    expect(elapsed).toBeLessThan(1_500);
    // No kill fired — graceful path observed the 'exit' event.
    expect(killCalls).toEqual([]);
    // Subprocess reaped naturally.
    expect(proc.exitCode === 0 || proc.signalCode !== null).toBe(true);
  });

  test('(b) hung subprocess (traps + ignores SIGTERM) → returns within gracefulMs + slack, kill spy receives (-pid, SIGKILL)', async () => {
    // Subprocess installs a SIGTERM handler that does nothing — typical
    // Electron-app shutdown-hang failure mode on macOS CI (utility-process
    // CRDT-drain delay, Helper XPC unresponsive, BrowserWindow blocked).
    // The subprocess never exits on its own. closeAppBounded must enforce
    // the wall-clock bound and fall through to SIGKILL on the negated PID.
    const hangBody = `
      process.on('SIGTERM', () => { /* swallow */ });
      setInterval(() => {}, 1000);
    `;
    const proc = spawnNode(hangBody);
    await awaitSpawn(proc);
    const pid = proc.pid;
    if (pid === undefined) throw new Error('spawn did not assign pid');

    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | string }> = [];
    const spyKill = (killPid: number, signal: NodeJS.Signals | string) => {
      killCalls.push({ pid: killPid, signal });
      // Deliberately do NOT actually deliver the kill. The contract under
      // test is "closeAppBounded fires the kill within budget"; whether
      // the OS receives it is a separate concern. The afterEach reaper
      // handles real subprocess cleanup so the test doesn't leak.
    };

    const start = Date.now();
    await closeAppBounded(proc, { gracefulMs: 300, kill: spyKill });
    const elapsed = Date.now() - start;

    // Upper bound only: gracefulMs + generous slack for the kill call.
    // A 3_000 ms ceiling (10× the 300 ms gracefulMs) catches a regression
    // that adds an unbounded `await` between the wait and the kill (or
    // accidentally re-applies app.close()-style unbounded waiting on the
    // OS process). NO lower-bound assertion — `setTimeout` jitter under
    // heavily loaded CI runners can fire 100ms+ early, and the contract
    // this tier uniquely verifies ("kill fires with correct args against
    // a hung process") is fully covered by the killCalls assertions
    // below. The mock-ChildProcess unit tier (tests/unit/electron-cleanup-
    // bounded.test.ts) covers the force-kill invocation shape with
    // generous upper bounds against synthetic 'exit' events; this real-
    // subprocess tier doesn't need to redo that timing work. A test
    // designed to prevent flake-class CI failures must not itself be a
    // flake source.
    expect(elapsed).toBeLessThan(3_000);

    // Kill spy received exactly one call with the negated PID + SIGKILL —
    // mirrors Playwright processLauncher process-group kill. The
    // negated-PID detail is load-bearing: positive PID kills only the
    // Electron main process, leaving Helper subprocesses + utility-process
    // tree as orphans that hold file descriptors and accumulate across N
    // tests in the worker.
    expect(killCalls.length).toBe(1);
    expect(killCalls[0]).toEqual({ pid: -pid, signal: 'SIGKILL' });
  });

  test('(c) already-exited subprocess → closeAppBounded returns ~immediately, no kill fired', async () => {
    // Subprocess exits before closeAppBounded is invoked. Idempotency: the
    // early-return at `isProcessGone(proc)` must short-circuit without
    // entering the wait or kill path.
    const proc = spawnNode(`process.exit(0);`);
    await awaitSpawn(proc);
    // Wait for actual exit before invoking closeAppBounded.
    await new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        resolve();
        return;
      }
      proc.once('exit', () => resolve());
    });
    expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);

    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | string }> = [];
    const spyKill = (pid: number, signal: NodeJS.Signals | string) => {
      killCalls.push({ pid, signal });
    };

    const start = Date.now();
    await closeAppBounded(proc, { gracefulMs: 5_000, kill: spyKill });
    const elapsed = Date.now() - start;

    // Early-return: no wait, no kill. Generous 100 ms ceiling for setup +
    // syscall overhead.
    expect(elapsed).toBeLessThan(100);
    expect(killCalls).toEqual([]);
  });
});
