/**
 * Shared Playwright fixture for desktop smoke tests.
 *
 * Encodes three repo-wide contracts that every Electron app launched in a
 * smoke test must satisfy:
 *
 *   (1) STDERR ATTACH CONTRACT — the Electron app's stdout/stderr is
 *   captured during the test attempt, and the captured buffer is attached
 *   to `testInfo` as the `main-process-stderr` artifact ONLY when (a) this
 *   is the final attempt — retries exhausted — AND (b) the final attempt
 *   is failing. Flake-passed and success-first-try attempts skip the
 *   attachment because the captured buffer can carry helper-teardown XPC
 *   noise that Playwright's reporter would otherwise surface as "errors
 *   not part of any test". The gating predicate (`shouldAttachStderr`,
 *   exported from `./electron-stderr`) owns the decision.
 *
 *   (2) BOUNDED CLEANUP CONTRACT — every Electron process group launched
 *   in the test is reaped within bounded time after the test body
 *   completes (whether by success, assertion failure, timeout, or
 *   interruption). The fixture's teardown calls `closeAppBounded` on
 *   the `ChildProcess` captured at registration time; the helper has a
 *   ~5s graceful budget then force-kills the process group via
 *   `process.kill(-pid, 'SIGKILL')`. This protects against Playwright's
 *   worker-teardown deadline (= `project.timeout` = 60s) being exceeded
 *   by orphaned Electron processes from timed-out test attempts whose
 *   `try/finally` was interrupted by per-test timeout cancellation.
 *
 *   (3) TMP-DIR CLEANUP CONTRACT — every per-test tmp directory passed
 *   via `opts.cleanupDirs` is `rmSync`'d AFTER the bounded reap. Running
 *   rmSync from a test-body `finally` raced with Electron's still-alive
 *   utility process: shadow-repo flushes under `<projectDir>/.git/ok/`
 *   and Chromium cache compaction under `--user-data-dir`'s
 *   `electron-userdata/` were landing while the recursive walk ran, so
 *   `rmdir` of the parent threw `ENOTEMPTY`. Hoisting cleanup into the
 *   fixture serializes it after the process group is fully reaped — same
 *   timing window the bounded-cleanup contract was built for.
 *
 *   Why operate on a captured ChildProcess instead of the
 *   ElectronApplication wrapper: Playwright's `app.process()` throws
 *   `TypeError: Cannot read properties of undefined (reading '_object')`
 *   once the dispatcher record is removed from `_dispatcherByGuid`
 *   (`toImpl()` then dereferences `undefined`). The fixture's
 *   `closeAppBounded` teardown kills the OS process; as a consequence,
 *   Playwright removes the dispatcher record and the wrapper becomes
 *   unusable. Capturing the raw Node `ChildProcess` at registration
 *   (before any teardown) gives cleanup a stable handle that survives
 *   the channel disposal that follows the process death — the
 *   ChildProcess remains queryable + signalable independent of
 *   Playwright's wrapper state. See `_helpers/electron-cleanup.ts` for
 *   the algorithm + Playwright source citations.
 *
 *   The bounded-time contract belongs at the fixture layer, not in
 *   test-body finally blocks: fixture teardowns are guaranteed by
 *   Playwright; user-written finally blocks are not. The fixture's
 *   `closeAppBounded` is the FIRST and ONLY cleanup pass — no test
 *   body initiates close ahead of it (enforced by the static guard at
 *   `_helpers/no-unbounded-app-close.test.ts`).
 *
 * Both contracts engage off the SAME registration call: `captureStderrFor(app)`
 * after each `electron.launch(...)`. Tests do not need a separate
 * cleanup-registration call.
 *
 * Why a fixture instead of helper-call-in-finally:
 *
 *   1. Single source of truth. Adding both contracts to a new test is one
 *      line (`captureStderrFor(app)`) instead of an attach-finally and a
 *      close-finally per test.
 *   2. Survives test timeout. Playwright fixture cleanup runs even when
 *      the worker kills the test body mid-await — same guarantee the
 *      manual finally provides, but contract-as-fixture means it can't be
 *      forgotten and can't be skipped by per-test timeout cancellation.
 *   3. Multi-launch tolerant. Tests that boot multiple Electron processes
 *      (rare today, but the switch-project case in nav-close-on-open
 *      already does this) register each app once; both contracts apply
 *      to every registered app.
 *   4. Centralized decisions. The attach-or-skip decision and the
 *      bounded-cleanup loop are taken once each, so consumers cannot
 *      accidentally regress either contract.
 *
 * Migrate by switching `import { test, expect } from '@playwright/test'`
 * to `import { test, expect } from './_helpers/smoke-test'` and replacing
 * any manual `stderr.attachTo` finally wiring with `captureStderrFor(app)`
 * after the launch. Existing `({}, testInfo)` fixture destructures can be
 * dropped — testInfo is consumed inside the fixture, not in the test body.
 */

import type { ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { expect as baseExpect, test as baseTest, type ElectronApplication } from '@playwright/test';
import { captureAppProcess, closeAppBounded } from './electron-cleanup';
import {
  captureElectronStderr,
  type ElectronStderrCapture,
  shouldAttachStderr,
} from './electron-stderr';

export interface SmokeRegistrationOpts {
  /**
   * Per-test tmp directories to remove on test end, AFTER `closeAppBounded`
   * has reaped the Electron process group. Multiple `captureStderrFor`
   * calls in one test (e.g. multi-launch sharing one userDataDir)
   * append to the same dir list; duplicates are harmless because
   * `rmSync({ force: true })` no-ops on already-removed paths.
   */
  cleanupDirs?: readonly string[];
}

export interface SmokeFixtures {
  /**
   * Register an Electron app for three contracts: stdout/stderr capture,
   * bounded-time cleanup on test end, AND post-reap tmp-dir removal.
   * Subscribes to `app.process()` streams immediately, captures the
   * underlying Node `ChildProcess` for later cleanup (capture must happen
   * WHILE the channel is alive — see file-level comment), and queues:
   *   1. an attach to `testInfo` on test end (gated by `shouldAttachStderr`)
   *   2. a `closeAppBounded` cleanup on the captured ChildProcess
   *   3. (when `opts.cleanupDirs` is set) rmSync of each dir AFTER (2)
   *
   * All three queues run in the fixture's teardown — guaranteed to fire
   * even when the test body's finally was interrupted by per-test timeout
   * cancellation. The cleanup-dir step intentionally runs LAST so the
   * Electron process group is fully reaped before any unlink storm hits
   * its working directories (race window closed, no more concurrent
   * writes from helper subprocesses or the utility process).
   *
   * Call once per launched app, after `electron.launch(...)` resolves
   * and before the first await on app behavior — the chrome-
   * modernization warns fire during whenReady's microtasks within
   * milliseconds of launch resolving.
   */
  captureStderrFor: (app: ElectronApplication, opts?: SmokeRegistrationOpts) => void;
}

export const test = baseTest.extend<SmokeFixtures>({
  // Playwright's fixture signature requires a destructured first arg even
  // when no upstream fixtures are read; `_` is rejected at runtime with
  // "First argument must use the object destructuring pattern: _".
  // biome-ignore lint/correctness/noEmptyPattern: Playwright fixture contract
  captureStderrFor: async ({}, use, testInfo) => {
    const captures: ElectronStderrCapture[] = [];
    const procs: ChildProcess[] = [];
    const cleanupDirs: string[] = [];
    await use((app, opts) => {
      captures.push(captureElectronStderr(app));
      // Capture the underlying ChildProcess WHILE the Playwright channel
      // is alive. The fixture's `closeAppBounded` teardown kills the OS
      // process later; once Playwright observes that the process exited,
      // it removes the dispatcher record and `app.process()` would throw
      // the disposed-channel TypeError (see file-level comment +
      // `electron-cleanup.ts` algorithm comment). Capturing here, before
      // any teardown, gives the teardown path a stable handle.
      procs.push(captureAppProcess(app));
      if (opts?.cleanupDirs) {
        for (const dir of opts.cleanupDirs) cleanupDirs.push(dir);
      }
    });
    // Contract (1): stderr-attach. Skip when the predicate says the
    // captured buffer has no diagnostic value (success first try, flake-
    // passed on retry, non-final timed-out attempt that may still retry-
    // pass, skipped). The captured buffer goes out of scope when this
    // function returns and is reclaimed by GC. Rationale lives in
    // `shouldAttachStderr`'s JSDoc.
    if (shouldAttachStderr(testInfo)) {
      for (const capture of captures) {
        await capture.attachTo(testInfo);
      }
    }
    // Contract (2): bounded cleanup. Runs unconditionally for every
    // registered app, every attempt. This is the FIRST and ONLY
    // cleanup pass (no test-body `app.close()` runs ahead of it,
    // enforced by `_helpers/no-unbounded-app-close.test.ts`), so it
    // owns the full Electron graceful-shutdown chain within the
    // `gracefulMs` budget. Idempotent on already-exited processes via
    // the early `isProcessGone` check — relevant when a test
    // explicitly closed the proc earlier (e.g. inter-pass close
    // between two Electron launches). For
    // apps that don't shut down within `gracefulMs`, this is the
    // load-bearing reap that prevents the orphan-process-group
    // accumulation producing "Worker teardown timeout of 60000ms
    // exceeded" → SIGKILL → exit 1. See
    // `electron-cleanup.ts` for the algorithm + Playwright-source
    // citations.
    for (const proc of procs) {
      await closeAppBounded(proc, { gracefulMs: 5_000 });
    }
    // Contract (3): tmp-dir cleanup. Runs after every proc is reaped, so
    // no helper subprocess / utility process is still writing into the
    // tree being unlinked. Tolerant of ENOTEMPTY / EBUSY anyway — if an
    // OS-level straggler (XPC teardown, fsevents flush) loses the race,
    // the OS tmpdir reaper handles GC and the test result must not
    // depend on this cleanup succeeding. Leftover bytes in /var/folders
    // are harmless across runs because every test mkdtempSyncs its own
    // unique dir.
    for (const dir of cleanupDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Defensive: post-reap residual race is rare but not impossible;
        // tmpdir reaper handles GC. Swallow rather than fail the test.
      }
    }
  },
});

export const expect = baseExpect;
