/**
 * Signal-driven clean-quit for the Electron main process.
 *
 * A `SIGTERM` / `SIGINT` / `SIGHUP` is an *orderly* request to stop — the OS
 * asking apps to quit for a logout, a parent process, `killall`, or Activity
 * Monitor's "Quit" (as opposed to "Force Quit", which is an uncatchable
 * `SIGKILL`). Node's default disposition terminates the process WITHOUT running
 * Electron's `before-quit` -> `will-quit` sequence, so the dirty-shutdown
 * sentinel is never cleared and the NEXT boot misreports the session as a crash
 * ("previous session ended without a clean quit"). That is the same
 * "the environment ended the session, not the app" class the reboot /
 * OS-shutdown / suspend suppression already covers — a termination signal is
 * just the one that arrives in-band at teardown time rather than as an
 * announced power marker.
 *
 * These handlers close that gap. On the first such signal we (1) clear the
 * sentinel synchronously so the record is durable even if a `SIGKILL`
 * escalation lands mid-teardown (the OS gives a signalled app a short grace
 * before force-killing it), then (2) drive Electron's normal `app.quit()` so
 * the full teardown (`will-quit` sentinel clear, PTY reap, logger flush,
 * owned-server drain on the update path) still runs. The handler fires once —
 * a second signal arriving while the quit sequence is already in flight is a
 * no-op rather than a second `app.quit()`.
 *
 * A genuine main-process crash is unaffected: it never delivers a signal here,
 * and the boot-time minidump scan remains the authoritative native-crash signal
 * (clearing the sentinel does not touch minidumps, so a fresh dump still arms a
 * dump-driven invitation on the next boot).
 *
 * This is deliberately NOT a `process.on('uncaughtException')` handler — see
 * `process-safety-net.ts` for why one must never be added. A signal handler is
 * a distinct disposition and does not change Electron's main-process
 * crash-dialog semantics. It mirrors the established teardown-signal wiring in
 * the sibling utility processes: `pty-host.ts` `installHostReaping` handles all
 * three of these signals, and `server-entry.ts` handles SIGTERM and SIGINT.
 *
 * Electron-free by construction (the process emitter, clean-quit hook, quit
 * driver, and logger are all injected) so it is unit-testable without a live
 * app.
 */

/** Catchable teardown signals that read as an orderly stop, not an app crash. */
export const CLEAN_QUIT_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];

interface SignalCleanQuitLogger {
  info(payload: Record<string, unknown>, msg: string): void;
}

/** Minimal surface this installer needs — `process` satisfies it; tests pass an emitter. */
interface ProcessSignalEmitter {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface InstallSignalCleanQuitOpts {
  /** The process to subscribe on — `process` in production, a fake emitter in tests. */
  process: ProcessSignalEmitter;
  /**
   * Clear the dirty-shutdown sentinel so the next boot doesn't read this
   * session as a crash. Runs synchronously before `quit()` so it is durable
   * against a `SIGKILL` escalation racing the async quit teardown.
   */
  markCleanQuit: () => void;
  /** Drive Electron's orderly quit (`before-quit` -> `will-quit` -> exit). */
  quit: () => void;
  logger: SignalCleanQuitLogger;
}

/**
 * Register clean-quit handlers for the catchable teardown signals. Call once,
 * during main-process boot, after crash detection is wired (so `markCleanQuit`
 * is live). The first signal wins; later signals during teardown are no-ops.
 */
export function installSignalCleanQuit(opts: InstallSignalCleanQuitOpts): void {
  let handled = false;
  const handle = (signal: NodeJS.Signals): void => {
    if (handled) return;
    handled = true;
    opts.logger.info(
      { event: 'desktop.signal-clean-quit', signal },
      'received termination signal — quitting cleanly',
    );
    // Clear the sentinel first: durable even if the OS escalates to SIGKILL
    // before `app.quit()`'s async teardown reaches `will-quit`. `markCleanQuit`
    // is idempotent, so the `will-quit` handler calling it again is a no-op.
    // A throw here must not skip `quit()` — the signal is a request to stop and
    // we honor it regardless of sentinel-clear outcome.
    try {
      opts.markCleanQuit();
    } catch {}
    opts.quit();
  };
  for (const signal of CLEAN_QUIT_SIGNALS) {
    opts.process.on(signal, () => handle(signal));
  }
}
