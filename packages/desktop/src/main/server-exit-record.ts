/**
 * Records why the OpenKnowledge server process last exited, so a bug-report
 * bundle can tell an unexpected death (a crash, or an OS OOM-kill / SIGKILL)
 * apart from a managed shutdown. The desktop main process observes the child's
 * death even when the child itself could not report it (a SIGKILL leaves no
 * last words), which is exactly the case the bundle otherwise can't diagnose:
 * its liveness probe only ever reports the port "unreachable", identical for a
 * crashed server and one that was cleanly stopped.
 *
 * The record lands at `<lockDir>/last-server-exit.json` — beside `server.lock`
 * under `<projectRoot>/.ok/local/`, where the bundle collector already harvests
 * runtime state.
 *
 * Two Electron signals describe the same death and can arrive in either order:
 *   - the per-window `utilityProcess.on('exit')` handler carries the exit
 *     `code` and the pid, and knows which server it belongs to (its `lockDir`);
 *   - `app.on('child-process-gone')` carries Electron's classified `reason`
 *     (`clean-exit` / `abnormal-exit` / `killed` / `crashed` / `oom` / ...) but
 *     no pid and no lockDir.
 * This recorder joins them: whichever fires first writes the record, and the
 * later one patches in its field. Correlation is a short time window rather
 * than an identity match — the main process is single-threaded so the two
 * handlers never interleave, and a lone desktop rarely tears down two distinct
 * servers within the same window. On a wider overlap the `reason` may attach to
 * the wrong record, so it is advisory; the `code` and timing are authoritative.
 *
 * A third observer writes here in packaged builds, where the server is a plain
 * `child_process.spawn` child rather than a `utilityProcess`: the detached-spawn
 * exit observer (`server-exit-observer.ts`). Two consequences.
 *
 * Its `'exit'` carries the POSIX `signal` as well as the code. That is the field
 * a SIGKILL needs: it leaves `code === null`, so without the signal the death
 * the record exists to describe is the one it cannot tell apart from an
 * unexplained exit. The dev `utilityProcess` path has no signal to give, so it
 * stays optional and records as null there.
 *
 * And that child can never be the subject of a `child-process-gone` reason —
 * an ordinary OS process is not classifiable as `Utility`, so every reason that
 * can reach the recorder in a packaged build belongs to some *other* utility
 * (a pty-host, say). Which is why each producer names itself on the record
 * (`observer`) rather than passing a correlate-or-not preference: whether a
 * death may carry a reason follows from how the process was created, so the
 * recorder derives the rule from that fact and the record carries it forward.
 * A `detached-spawn` record's `reason: null` therefore means "not observable on
 * this path", not "the correlation window missed it".
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVER_EXIT_LOG } from '@inkeep/open-knowledge-core';

/** How long a `code` and a `reason` for the same death may be apart. */
const REASON_CORRELATION_WINDOW_MS = 3_000;

/**
 * Which host observed the death. Determines how a null `reason` and a null
 * `signal` read, and whether a `child-process-gone` reason may be joined at
 * all — so it is the fact, not a caller preference, and every writer states it.
 *
 * - `utility-process` — the dev/test Electron `utilityProcess` fork. Reports a
 *   `code` but never a `signal`, and IS classifiable by Electron, so a reason
 *   may be correlated onto its record.
 * - `detached-spawn` — the packaged plain `child_process.spawn` child. Reports
 *   both `code` and `signal`; an ordinary OS process can never be the subject
 *   of a `Utility` process-gone reason, so correlation is declined and `reason`
 *   is structurally null there.
 */
type ServerExitObserverHost = 'utility-process' | 'detached-spawn';

/**
 * Compile-time exhaustiveness guard for `ServerExitObserverHost` consumers. Per-DU
 * helper rather than one shared `assertNever`, matching `assertNeverLinkTarget`
 * (`packages/core/src/utils/link-targets.ts`) and `assertNeverDiskEvent`
 * (`packages/server/src/file-watcher.ts`).
 */
function assertNeverObserverHost(value: never): never {
  throw new Error(`Unhandled ServerExitObserverHost: ${JSON.stringify(value as unknown)}`);
}

/**
 * Whether a death observed by this host may be joined to an
 * `app.on('child-process-gone')` reason.
 *
 * A switch rather than `observer !== 'detached-spawn'` deliberately: the SPEC
 * anticipates a third host (an attach-mode liveness poll), and under a negative
 * check it would land silently on the correlatable side — inheriting exactly the
 * unsafe default the `observer` discriminator replaced. A liveness poll is the
 * worst case for that, since it can only ever observe `{code: null, signal: null}`,
 * so a borrowed reason would be the record's only apparent content. Here a new
 * member fails to compile until someone states its answer.
 */
function mayCorrelateGoneReason(observer: ServerExitObserverHost): boolean {
  switch (observer) {
    // Electron classifies its own `utilityProcess`, so the join describes this
    // very child.
    case 'utility-process':
      return true;
    // An ordinary OS process can never be the subject of a `Utility` reason, so
    // every reason reaching the recorder here belongs to some other utility.
    case 'detached-spawn':
      return false;
    default:
      return assertNeverObserverHost(observer);
  }
}

export interface ServerExitRecord {
  /** ISO timestamp of the exit the desktop host observed. */
  at: string;
  /** The server's pid, or null when the exit event carried none. */
  pid: number | null;
  /**
   * Exit code reported by whichever host observed the death; null when a signal
   * killed the process.
   *
   * Not a fallback for a null `signal` on Windows. libuv terminates for every
   * supported signal with `TerminateProcess(handle, 1)`, and the exit status it
   * then reports is that literal 1 — so a SIGTERM, a SIGKILL escalation, a Task
   * Manager "End task" and a voluntary `exit(1)` are all `{code: 1, signal:
   * null}` there. On Windows this record narrows to `code: 0` = orderly stop,
   * anything else = unresolved.
   */
  code: number | null;
  /**
   * POSIX signal name that killed the process (`SIGKILL`, `SIGTERM`, ...), or
   * null when it exited on its own, when the exit event carried no signal, or
   * when the observing host cannot report one (see `observer`). Absent on a
   * record written before this field existed, which reads as unknown.
   *
   * POSIX-only, and narrower on Windows than "we killed it, so we know". libuv
   * records the signal on the `uv_process_t` handle, and only `uv_process_kill`
   * — i.e. `subprocess.kill()` on that same `ChildProcess` object — writes it.
   * `process.kill(pid, signal)` routes through `uv_kill`, which opens a handle
   * by pid and calls `TerminateProcess` without touching the child's handle.
   * This desktop kills the detached server exclusively by pid (`killProbe` in
   * `window-manager.ts`), so on Windows the field is null for *every* death it
   * observes, including its own managed shutdowns. A null signal there carries
   * no information about who ended the process.
   */
  signal?: string | null;
  /**
   * Which host observed this death. Says how the two nullable fields above and
   * below read: on `detached-spawn` a null `reason` means "no such
   * classification can exist for this process", while on `utility-process` it
   * means "the correlation window produced nothing"; a null `signal` is never
   * observable on `utility-process` at all. Absent on a record written before
   * this field existed, which reads as unknown.
   */
  observer?: ServerExitObserverHost;
  /**
   * Electron's `child-process-gone` reason, or null — either because no reason
   * arrived in the correlation window, or because none can exist for this
   * `observer`. `killed` covers an OS OOM-kill / SIGKILL; `crashed` / `oom` a
   * genuine in-process crash; `clean-exit` / `abnormal-exit` a managed shutdown
   * or a nonzero self-exit; `launch-failed` / `integrity-failure` /
   * `memory-eviction` round out Electron 43's set. Forwarded verbatim and never
   * validated, and Electron adds values across releases — an unrecognised
   * string is a newer classification, not a corrupt record.
   */
  reason: string | null;
}

/**
 * What this module actually writes today, as opposed to what a reader may find.
 * The optionality on `ServerExitRecord` is a *read* affordance for the add-only
 * discipline — absent means "written before that field existed". Producing a
 * record that omits them would therefore forge that signal, so the write path
 * requires both and the invariant is a type fact rather than an inspection one.
 */
type WrittenServerExitRecord = ServerExitRecord &
  Required<Pick<ServerExitRecord, 'signal' | 'observer'>>;

/**
 * The one declaration of a `recordExit` payload. Both producers and the
 * `WindowManagerDeps` dep narrow from this (`Pick<>`) rather than restating it,
 * because a restated shape drifts silently: the adapters forward a typed
 * variable rather than a fresh object literal, and TypeScript's excess-property
 * check does not apply to variables — a renamed field on one copy compiles
 * clean and the value is dropped.
 */
export interface ServerExitInfo {
  lockDir: string;
  pid: number | null;
  code: number | null;
  /** Absent from the dev path, which has no signal to report; records as null. */
  signal?: string | null;
  observer: ServerExitObserverHost;
}

interface ServerExitRecorderLogger {
  warn(payload: Record<string, unknown>, msg: string): void;
}

export interface ServerExitRecorderDeps {
  now(): Date;
  logger: ServerExitRecorderLogger;
}

export interface ServerExitRecorder {
  /**
   * Record an observed server exit. Called from the window manager's
   * `utilityProcess.on('exit')` handler (dev/test) and from the packaged
   * detached-spawn exit observer (`server-exit-observer.ts`); both know the
   * `lockDir`, pid, and exit code. Attaches a `reason` if `noteGoneReason`
   * fired for the same death moments earlier — but only for an `observer` whose
   * child Electron can classify. A `detached-spawn` record opts out of that
   * join in both directions (no reason is read at write time, and no later one
   * may patch the record), so a foreign utility's reason is never adopted.
   */
  recordExit(info: ServerExitInfo): void;
  /**
   * Note Electron's classified process-gone reason. Called from
   * `app.on('child-process-gone')`, which has the reason but no lockDir. Patches
   * the just-written record when the exit event already fired for this death.
   */
  noteGoneReason(reason: string): void;
}

export function createServerExitRecorder(deps: ServerExitRecorderDeps): ServerExitRecorder {
  let lastExit: { lockDir: string; record: WrittenServerExitRecord; atMs: number } | null = null;
  let lastReason: { reason: string; atMs: number } | null = null;

  function write(lockDir: string, record: WrittenServerExitRecord): void {
    try {
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, SERVER_EXIT_LOG), `${JSON.stringify(record, null, 2)}\n`);
    } catch (err) {
      // Best-effort diagnostic — a server death must never be masked by an
      // unwritable state dir. The bundle simply won't carry the record.
      //
      // The warn is itself guarded because the desktop logger's first use
      // lazily `mkdirSync`s `~/.ok/logs`: when the state dir is unwritable the
      // log dir often is too, and a throw here would escape into the
      // `'exit'` listener that called us — an `EventEmitter` callback, so an
      // `uncaughtException` — turning "we could not write the record" into
      // Electron's fatal error dialog. That is exactly the masking this catch
      // exists to prevent.
      try {
        deps.logger.warn(
          {
            event: 'server-exit-record.write-failed',
            err,
          },
          'could not record server exit',
        );
      } catch {}
    }
  }

  return {
    recordExit({ lockDir, pid, code, signal = null, observer }): void {
      const now = deps.now();
      const nowMs = now.getTime();
      const correlatable = mayCorrelateGoneReason(observer);
      const reason =
        correlatable &&
        lastReason !== null &&
        nowMs - lastReason.atMs <= REASON_CORRELATION_WINDOW_MS
          ? lastReason.reason
          : null;
      const record: WrittenServerExitRecord = {
        at: now.toISOString(),
        pid,
        code,
        signal,
        observer,
        reason,
      };
      write(lockDir, record);
      // Clearing rather than storing is the other half of the opt-out: leaving
      // this record in the slot would let the next `noteGoneReason` patch a
      // reason onto it from behind.
      lastExit = correlatable ? { lockDir, record, atMs: nowMs } : null;
    },

    noteGoneReason(reason): void {
      const nowMs = deps.now().getTime();
      lastReason = { reason, atMs: nowMs };
      // Patch the exit record when the `exit` event already landed for this
      // death without a reason yet (the two events can arrive in either order).
      if (
        lastExit !== null &&
        lastExit.record.reason === null &&
        nowMs - lastExit.atMs <= REASON_CORRELATION_WINDOW_MS
      ) {
        const patched: WrittenServerExitRecord = { ...lastExit.record, reason };
        write(lastExit.lockDir, patched);
        lastExit = { ...lastExit, record: patched };
      }
    },
  };
}
