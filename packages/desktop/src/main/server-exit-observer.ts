/**
 * Turns a detached project server's `'exit'` event into the forensic record and
 * the one desktop log line that describe its death.
 *
 * In packaged builds the server is spawned with plain `child_process.spawn`
 * (see `resolve-detached-spawn-args.ts`), which puts its death outside every
 * mechanism that used to record one: it is an ordinary OS process, so Electron's
 * `app.on('child-process-gone')` can never classify it (`type === 'Utility'` is
 * structurally unreachable for it), and the `utilityProcess` exit handler that
 * calls the recorder in dev never runs. The `'exit'` listener on the spawned
 * child is the only observer of that death, and this is what it should do with
 * what it observes.
 *
 * The same unreachability cuts the other way: every `child-process-gone` reason
 * that can reach the recorder in a packaged build belongs to some other utility
 * (a pty-host, say), so this path names itself `detached-spawn` on the record,
 * which is what tells the recorder not to join a cause that describes a
 * different process.
 *
 * Deps are injected and nothing here imports `electron` or `./index.ts`, so the
 * mapping is unit-testable on its own — `index.ts` has no test file. Same
 * posture as the sibling `resolve-detached-spawn-args.ts`. `attachServerExitObserver`
 * exists so the registration itself is inside that testable surface rather than
 * being a shape the integration test has to rebuild by hand.
 *
 * Observing is all it does. The server is deliberately detached and `unref`ed
 * so it outlives the desktop process, so nothing here kills, restarts or
 * re-parents it, and it holds no reference to the child beyond reading its pid.
 */

import type { ServerExitInfo } from './server-exit-record.ts';

/** Structured `info` sink; `getLogger('server-exit')` satisfies it. */
interface ServerExitObserverLogger {
  info(payload: Record<string, unknown>, msg: string): void;
}

export interface ServerExitObserverDeps {
  /** Where the record lands: `<lockDir>/last-server-exit.json`. */
  lockDir: string;
  /**
   * The child's pid, read at exit time rather than taken by value. Safe because
   * Node retains `subprocess.pid` past handle teardown — inside the `'exit'`
   * handler `child._handle` is already null while `child.pid` still reads the
   * spawned pid. That is what lets the registration sit above the spawn site's
   * own `pid` binding, which is what keeps the listener ahead of `unref()`.
   *
   * `undefined` mirrors `ObservableChild.pid`, the only source this reads, and
   * records as null rather than dropping the record. Unreachable through the
   * one production caller, which resolves the pid from an already-awaited
   * `'spawn'` event.
   */
  readPid(): number | undefined;
  /** The shared `ServerExitRecorder`'s `recordExit`. */
  recordExit(info: ServerExitInfo): void;
  logger: ServerExitObserverLogger;
}

/** The `'exit'` listener signature this module produces and attaches. */
type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;

/**
 * The slice of a spawned child this module touches: its pid, and the one event
 * it listens for. Structural rather than `ChildProcess` so nothing here depends
 * on `node:child_process`, and so the shape makes the "no kill, no restart, no
 * re-parenting" boundary a type-level fact rather than a promise in a comment.
 */
export interface ObservableChild {
  readonly pid?: number | undefined;
  on(event: 'exit', listener: ExitListener): unknown;
}

/**
 * Build the `'exit'` listener for a detached project server. Exported for the
 * unit tests, which drive the mapping directly; production and the integration
 * test both go through `attachServerExitObserver` so the registration is
 * covered too.
 */
export function createServerExitObserver(deps: ServerExitObserverDeps): ExitListener {
  return (code, signal) => {
    // A diagnostic must not be able to kill the process it observes. A throw out
    // of an `EventEmitter` callback becomes an `uncaughtException`, and this main
    // process deliberately installs no userland handler for those (see
    // `process-safety-net.ts`), so it would surface as Electron's fatal "A
    // JavaScript error occurred in the main process" dialog — at the exact moment
    // the user's server just died, taking away the app that would have filed the
    // report about it.
    //
    // One guard per artifact, not one around both. The two sinks live in
    // unrelated trees — the record goes to `<projectRoot>/.ok/local`, the log to
    // `~/.ok/logs` — so a fault in one says nothing about the other, and a shared
    // guard would silently let the first failure delete the second artifact.
    let pid: number | null = null;
    try {
      pid = deps.readPid() ?? null;
    } catch {}

    // The record first, because it is the durable artifact: `recordExit` writes
    // synchronously and is on disk before it returns, while the desktop log
    // destination is `sync: false` and only managed-shutdown paths flush it. It
    // is also already fail-soft internally, so this guard is belt-and-braces —
    // whereas the logger genuinely can throw, and stays broken for the rest of
    // the session once it does (`getRootLogger` memoizes only *after* its
    // `mkdirSync`). Ordering it second is what keeps a locked-down `~/.ok/logs`
    // from costing us the record on a perfectly writable project dir.
    try {
      deps.recordExit({
        lockDir: deps.lockDir,
        pid,
        code,
        signal,
        // No `child-process-gone` reason can describe this child (see header).
        observer: 'detached-spawn',
      });
    } catch {}

    // `lockDir` names which project lost its server, since a pid alone no longer
    // resolves. Failure here is deliberately terminal rather than escalated: the
    // only sink that could report it is the one that just failed. The record
    // written above is the surviving evidence — a record with no matching
    // `server-exit.detached-child-exited` line is itself the signal that this
    // session's logging was degraded.
    try {
      deps.logger.info(
        { event: 'server-exit.detached-child-exited', lockDir: deps.lockDir, pid, code, signal },
        'detached project server exited',
      );
    } catch {}
  };
}

/**
 * Register the exit observer on a spawned detached server.
 *
 * Production (`index.ts`'s `spawnDetachedServer`) and the integration test call
 * this same function, so the registration — that the observer is attached to
 * the child's `'exit'`, once, reading the pid through the child — is pinned by
 * a test rather than resting on review of a ~9,000-line file with no test file
 * of its own. Must be called before `unref()`; `unref()` releases the
 * event-loop reference, not listeners, but keeping the order explicit keeps the
 * spawn site readable.
 */
export function attachServerExitObserver(
  child: ObservableChild,
  deps: Omit<ServerExitObserverDeps, 'readPid'>,
): void {
  child.on('exit', createServerExitObserver({ ...deps, readPid: () => child.pid }));
}
