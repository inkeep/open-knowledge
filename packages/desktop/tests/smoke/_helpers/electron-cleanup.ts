/**
 * Bounded-time Electron-app cleanup primitive for smoke-test fixtures.
 *
 * Why this exists: Playwright's `app.close()` (`ElectronApplication.close()`)
 * is NOT bounded in worst case. It delegates to processLauncher's
 * `gracefullyClose()`, which awaits `attemptToGracefullyClose` (== a chain
 * that calls `app.quit()` in the Electron main process and then waits for
 * the underlying child process to exit) WITHOUT a timeout. If the
 * Electron Helper subprocess is unresponsive (XPC errors, slow Cache
 * compaction, hung utility process draining CRDT state), `app.close()`
 * hangs without bound.
 *
 * When a Playwright smoke test attempt times out (60s),
 * Playwright cancels the test body's awaits.
 * The user-written `try { ... } finally { await app.close() }` does not
 * complete; the Electron child process group is orphaned. Across multiple
 * tests in the same Playwright worker, accumulated orphans hold open
 * file descriptors → Node can't exit cleanly → Playwright's
 * worker-teardown deadline (= `project.timeout` = 60s) fires →
 * SIGKILL the worker → reporter classifies as "1 error not part of any
 * test" → exit 1.
 *
 * This primitive enforces the timing invariant the fixture layer needs:
 *   For any captured ChildProcess `proc` and any cleanup invocation
 *   `await closeAppBounded(proc, opts)`, the call resolves within
 *   `opts.gracefulMs + small slack`, and on resolution, `proc`'s
 *   process group is dead (or was already dead when the call started).
 *
 * Why operate on a ChildProcess and not an ElectronApplication: Playwright's
 * `ElectronApplication.process()` calls
 * `this._connection.toImpl?.(this)?.process()`, where `toImpl` does
 *   `dispatcherConnection._dispatcherByGuid.get(x._guid)._object`
 * After
 * `app.close()` resolves, the dispatcher record is REMOVED from
 * `_dispatcherByGuid`, and `.get(x._guid)._object` then dereferences
 * `undefined` and throws
 *   `TypeError: Cannot read properties of undefined (reading '_object')`.
 *
 * The fixture's `closeAppBounded` is the FIRST and ONLY cleanup pass —
 * no test body initiates `app.close()` ahead of it (enforced by the
 * static guard at `_helpers/no-unbounded-app-close.test.ts`). The
 * cleanup primitive operates on the raw Node `ChildProcess` captured at
 * registration time (`captureAppProcess`) so the handle survives any
 * channel disposal that this teardown itself triggers — the OS process
 * record outlives Playwright's API state and remains queryable +
 * signalable.
 *
 * Algorithm:
 *   1. If `proc` is null OR already dead (`exitCode !== null` or
 *      `signalCode !== null` or `killed === true`), return immediately
 *      (idempotent on dead).
 *   2. Wait for `proc` to fire `'exit'` on its own, bounded by
 *      `gracefulMs`. This is the FIRST cleanup pass (no test-body
 *      `app.close()` runs ahead of it), so the wait spans the full
 *      Electron graceful-shutdown chain — utility-process reap, window
 *      close handlers, BrowserWindow disposal — up to the bound.
 *   3. Re-check `proc`. If still alive, force-kill the process group via
 *      `process.kill(-pid, 'SIGKILL')` — same kill mechanism Playwright's
 *      own processLauncher uses. The negated
 *      PID kills the entire group atomically: Electron main + helper
 *      subprocesses + utility process tree.
 *
 * The `kill` opts parameter exists for unit testability — the bun test
 * passes a spy to assert which arguments were sent without monkey-patching
 * the global `process.kill`. Production callers (the smoke fixture) omit
 * it; the helper defaults to `process.kill`.
 *
 * Process-group kill is POSIX-specific. The smoke harness is darwin-only
 * (per `.e2e.ts` skip gates referencing `process.platform === 'darwin'`),
 * so this is a sound assumption. If the harness is ever extended to
 * Windows, the kill code path here would need a parallel branch using
 * `taskkill`.
 *
 * No production code dependency. Test infrastructure only.
 */

import type { ChildProcess } from 'node:child_process';
import type { ElectronApplication } from '@playwright/test';

export interface CloseAppBoundedOpts {
  /**
   * Maximum time to wait for the underlying ChildProcess to exit on its
   * own before falling back to force-kill of the process group. Default
   * 5_000 ms. Five seconds is the operational sweet spot: long enough
   * for a healthy Electron app to finish exiting gracefully on a slow CI
   * runner (this teardown is the FIRST cleanup pass — no test-body
   * `app.close()` runs ahead of it, so the full `gracefulMs` budget is
   * the expected wall-clock cost per launched app), short enough that
   * the cumulative cost across N apps in a single worker stays well
   * inside Playwright's 60s worker-teardown budget.
   */
  gracefulMs?: number;
  /**
   * Kill function. Defaults to `process.kill`. Exposed as opts for unit
   * testability — the bun unit test passes a spy.
   */
  kill?: (pid: number, signal: NodeJS.Signals | string) => void;
}

/**
 * Capture the underlying Node `ChildProcess` from a freshly-launched
 * `ElectronApplication`. MUST be called while the Playwright channel is
 * alive (typically inside the fixture's `use((app) => { ... })` callback,
 * immediately after `electron.launch(...)` resolves). Calling
 * `app.process()` AFTER `app.close()` resolves throws the disposed-
 * channel TypeError (see file-level comment).
 *
 * The returned `ChildProcess` is the raw Node child process; it survives
 * Playwright channel disposal and remains queryable
 * (`.killed`, `.exitCode`, `.signalCode`, `.pid`) and signalable
 * (via `process.kill`).
 */
export function captureAppProcess(app: ElectronApplication): ChildProcess {
  return app.process();
}

/**
 * Close an Electron app's process group with a bounded grace period and a
 * guaranteed force-kill fallback. Operates on the captured ChildProcess —
 * never re-queries Playwright's wrapper, so cannot throw from disposed-
 * channel state. Idempotent on already-dead processes; a no-op on `null`
 * (preserves the ergonomic of accepting `null` when launch failed before
 * assignment).
 *
 * Worst-case time: `opts.gracefulMs` (default 5_000) + small slack for
 * the kill itself. Typical time on a healthy Electron app: the full
 * graceful-shutdown chain runs while we wait — utility-process drain,
 * window close handlers, BrowserWindow disposal — so the wait spans
 * most of the `gracefulMs` budget per launched app, not "a few hundred
 * ms" the way it would if a test body had already kicked off shutdown.
 */
export async function closeAppBounded(
  proc: ChildProcess | null,
  opts: CloseAppBoundedOpts = {},
): Promise<void> {
  if (proc === null) return;

  // Idempotency: if the underlying process is already dead, skip everything.
  // Avoids double-kill races and SIGKILLing dead PIDs (which throws ESRCH on
  // POSIX). The fixture is the first/only cleanup path now, but a few tests
  // (e.g. qa-create-new-extended multi-launch) call `closeAppBounded`
  // explicitly between launches — the fixture's end-of-test pass on those
  // already-reaped procs must be a no-op.
  if (isProcessGone(proc)) return;

  const gracefulMs = opts.gracefulMs ?? 5_000;

  // Wait for the process to exit on its own. This is the FIRST cleanup
  // pass (no test-body `app.close()` runs ahead of us), so the wait
  // races the Electron app's natural `'exit'` event against the
  // `gracefulMs` budget — full budget is the expected wall-clock cost.
  await waitForExit(proc, gracefulMs);

  // Re-check after the wait. If the process exited on its own, no kill needed.
  if (isProcessGone(proc)) return;

  // Process is still alive after the graceful budget. Force-kill the
  // process group. Negated PID = process-group kill on POSIX.
  // Defensive: only attempt if pid is a positive integer (Playwright's
  // launchedProcess.pid is set on successful launch, but defending against
  // unexpected shapes is cheap).
  const killFn = opts.kill ?? process.kill.bind(process);
  if (typeof proc.pid === 'number' && Number.isInteger(proc.pid) && proc.pid > 0) {
    try {
      killFn(-proc.pid, 'SIGKILL');
    } catch {
      // Race: process exited between the check and the kill. Or ESRCH
      // because the pid is no longer in any process table. Either way,
      // the goal (process is dead) is achieved by other means.
    }
  }
}

/**
 * "Is the OS-level process record indicating death?" — checks all three
 * Node ChildProcess signals for process termination:
 *   - `exitCode`: set when the process exited normally
 *   - `signalCode`: set when the process was killed by a signal (external
 *     OR via `process.kill`)
 *   - `killed`: set after `kill()` was called on the ChildProcess
 *     (regardless of whether the signal was actually delivered)
 */
function isProcessGone(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null || proc.killed === true;
}

/**
 * Wait for `proc` to fire `'exit'`, bounded by `timeoutMs`. Resolves on
 * either the exit event OR the timeout — caller is responsible for
 * re-checking the process state to decide whether to force-kill.
 *
 * Cleans up the listener + timer exactly once via `settled`/`settle()` —
 * critical for not leaking event handlers across N cleanup calls per
 * worker.
 */
function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (isProcessGone(proc)) {
      resolve();
      return;
    }
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      proc.off('exit', settle);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(settle, timeoutMs);
    // Don't keep the worker process alive past the timer's natural fire.
    (timer as unknown as { unref?: () => void }).unref?.();
    proc.once('exit', settle);
  });
}
