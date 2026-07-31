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
 *      subprocesses + utility process tree. On win32 this step is
 *      `taskkill /T /F` plus a bounded wait for the OS to finish reaping
 *      (see below).
 *
 * The `kill` / `taskkill` / `platform` opts exist for unit testability —
 * the unit test passes spies to assert which arguments were sent, and pins
 * the platform so both force-kill branches are exercised from any host,
 * without monkey-patching the global `process.kill`. Production callers
 * (the smoke fixture) omit all three.
 *
 * Process-group kill is POSIX-specific — Windows has no process groups
 * and Node throws on a negative pid there, which the catch below would
 * swallow, making the force-kill a silent no-op. That exact shape broke
 * the first cross-platform run of the multi-launch specs: app1 survived
 * its "kill", held the Chromium userData singleton, and app2's browser
 * process did the singleton rendezvous and exited 0 mid-CDP-attach
 * (`electron.launch: WebSocket error: read ECONNRESET`). POSIX was never
 * affected because `kill(-pid)` nukes the whole group. On win32 the
 * force-kill therefore shells out to `taskkill /pid <pid> /T /F` — the
 * `/T` tree flag is the load-bearing part.
 *
 * `taskkill` only REQUESTS termination, so returning on its exit reproduces
 * the same ECONNRESET intermittently: the lock survives until Windows has
 * actually reaped the browser process. The win32 branch therefore also waits
 * (bounded) for the real `'exit'`, which is what makes "dead on resolution"
 * true rather than merely requested.
 *
 * No production code dependency. Test infrastructure only.
 */

import type { ChildProcess } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { type Dirent, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
   * POSIX kill function. Defaults to `process.kill`. Exposed as opts for
   * unit testability — the unit test passes a spy.
   */
  kill?: (pid: number, signal: NodeJS.Signals | string) => void;
  /**
   * Windows tree-kill. Defaults to `taskkill /pid <pid> /T /F`. A seam
   * separate from `kill` because the Windows call carries no signal
   * argument, so pinning platform dispatch needs a spy per branch.
   */
  taskkill?: (pid: number) => void;
  /**
   * Platform the force-kill branches on. Defaults to `process.platform`.
   * Tests pin it so both branches are exercised from any host — otherwise
   * the win32 branch would only ever run on a Windows runner.
   */
  platform?: NodeJS.Platform;
}

/**
 * Default Windows force-kill: `taskkill /pid <pid> /T /F`. The `/T` tree
 * flag is the load-bearing part — Windows has no process groups, so
 * without it Electron's helper and utility subprocesses survive.
 *
 * `timeout` keeps this synchronous call inside the primitive's bounded-
 * time contract. taskkill returns in well under a second in practice; the
 * bound exists so a wedged call can't block the event loop indefinitely
 * and defeat the very invariant `closeAppBounded` enforces.
 */
/**
 * Cap on the post-taskkill wait for Windows to actually reap the tree. Short
 * because the reap is normally sub-second; the bound exists so a wedged
 * process can't stretch teardown past the fixture's budget.
 */
const POST_KILL_REAP_MS = 2_000;

function taskkillTree(pid: number): void {
  spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    timeout: 5_000,
  });
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

/** Depth that reaches `<tmpHome>/<project>/.ok/local/server.lock`. */
const LOCK_SEARCH_DEPTH = 3;

function collectServerLockPids(dir: string, depth: number, out: number[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return; // Already removed, or never created — nothing to reap.
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === '.ok') {
      try {
        const raw = readFileSync(join(dir, '.ok', 'local', 'server.lock'), 'utf8');
        const pid = (JSON.parse(raw) as { pid?: unknown }).pid;
        // Guard 0/1/negatives: `process.kill` treats 0 as "this group" and
        // negatives as a group id, so a malformed lock could signal the test
        // runner itself.
        if (typeof pid === 'number' && Number.isInteger(pid) && pid > 1) out.push(pid);
      } catch {
        // No lock, unreadable, or not JSON — the server never started or
        // already released it.
      }
      continue;
    }
    if (depth > 0) collectServerLockPids(join(dir, entry.name), depth - 1, out);
  }
}

/**
 * Kill the OK servers that a packaged app spawned, before their content dirs
 * are unlinked.
 *
 * A packaged build spawns its server DETACHED so it outlives the app — that is
 * the product behavior, not a bug. But it also puts the server in its own
 * process group, so `closeAppBounded`'s `kill(-pid)` on the Electron group
 * never reaches it. Each packaged smoke test therefore leaves a live server
 * reparented to init, holding the file descriptors it inherited from the
 * Playwright worker. Enough of those and the worker cannot exit, which
 * surfaces as `Worker teardown timeout ... exceeded` and a non-zero exit with
 * every test green — indistinguishable from a real gate failure to anything
 * reading the exit code.
 *
 * Unpackaged runs never see this: the dev-mode server is a child of the app
 * and dies with the group, which is why the accumulation only appears once the
 * suite runs against a real bundle.
 *
 * The pid comes from the server's own `.ok/local/server.lock`, so this reaps
 * exactly the servers these tests started and never a developer's own.
 * Best-effort by design: a missing lock, a dead pid, or an unreadable tree all
 * mean there is nothing to reap.
 */
export function reapDetachedServers(dirs: readonly string[]): void {
  const pids: number[] = [];
  for (const dir of dirs) collectServerLockPids(dir, LOCK_SEARCH_DEPTH, pids);
  for (const pid of new Set(pids)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ESRCH — already gone, which is the common case on a clean shutdown.
    }
  }
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
  // process group. Negated PID = process-group kill on POSIX; Windows has
  // no groups, so taskkill's /T walks the tree instead (see file header —
  // without it the kill is a silent no-op and the app survives).
  // Defensive: only attempt if pid is a positive integer (Playwright's
  // launchedProcess.pid is set on successful launch, but defending against
  // unexpected shapes is cheap).
  const killFn = opts.kill ?? process.kill.bind(process);
  if (typeof proc.pid === 'number' && Number.isInteger(proc.pid) && proc.pid > 0) {
    if ((opts.platform ?? process.platform) === 'win32') {
      (opts.taskkill ?? taskkillTree)(proc.pid);
      // taskkill REQUESTS termination; it returns before Windows has reaped
      // the tree. That gap is observable: Chromium holds `SingletonLock` in
      // userData open until the browser process is actually gone, so a
      // relaunch against the same userData inside the window fails the
      // singleton rendezvous ("Lock file can not be created! Error code: 32"
      // == ERROR_SHARING_VIOLATION) and the new app exits mid-CDP-attach with
      // `electron.launch: WebSocket error: read ECONNRESET`. Waiting for the
      // real exit makes the post-condition — dead on resolution — hold.
      //
      // POSIX needs no equivalent: `kill(-pid, SIGKILL)` is delivered by the
      // kernel before it returns, and the singleton there is a symlink with a
      // liveness check rather than an exclusively-held handle.
      await waitForExit(proc, Math.min(gracefulMs, POST_KILL_REAP_MS));
      return;
    }
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
