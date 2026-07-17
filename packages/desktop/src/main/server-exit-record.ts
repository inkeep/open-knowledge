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
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVER_EXIT_LOG } from '@inkeep/open-knowledge-core';

/** How long a `code` and a `reason` for the same death may be apart. */
const REASON_CORRELATION_WINDOW_MS = 3_000;

export interface ServerExitRecord {
  /** ISO timestamp of the exit the desktop host observed. */
  at: string;
  /** The server's pid, or null when the exit event carried none. */
  pid: number | null;
  /** `utilityProcess` exit code; null when the process was killed by a signal. */
  code: number | null;
  /**
   * Electron's `child-process-gone` reason, or null when no reason arrived in
   * the correlation window. `killed` covers an OS OOM-kill / SIGKILL; `crashed`
   * / `oom` a genuine in-process crash; `clean-exit` / `abnormal-exit` a
   * managed shutdown or a nonzero self-exit.
   */
  reason: string | null;
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
   * `utilityProcess.on('exit')` handler, which knows the `lockDir`, pid, and
   * exit code. Attaches a `reason` if `noteGoneReason` fired for the same death
   * moments earlier.
   */
  recordExit(info: { lockDir: string; pid: number | null; code: number | null }): void;
  /**
   * Note Electron's classified process-gone reason. Called from
   * `app.on('child-process-gone')`, which has the reason but no lockDir. Patches
   * the just-written record when the exit event already fired for this death.
   */
  noteGoneReason(reason: string): void;
}

export function createServerExitRecorder(deps: ServerExitRecorderDeps): ServerExitRecorder {
  let lastExit: { lockDir: string; record: ServerExitRecord; atMs: number } | null = null;
  let lastReason: { reason: string; atMs: number } | null = null;

  function write(lockDir: string, record: ServerExitRecord): void {
    try {
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(join(lockDir, SERVER_EXIT_LOG), `${JSON.stringify(record, null, 2)}\n`);
    } catch (err) {
      // Best-effort diagnostic — a server death must never be masked by an
      // unwritable state dir. The bundle simply won't carry the record.
      deps.logger.warn(
        {
          event: 'server-exit-record.write-failed',
          cause: err instanceof Error ? err.message : String(err),
        },
        'could not record server exit',
      );
    }
  }

  return {
    recordExit({ lockDir, pid, code }): void {
      const now = deps.now();
      const nowMs = now.getTime();
      const reason =
        lastReason !== null && nowMs - lastReason.atMs <= REASON_CORRELATION_WINDOW_MS
          ? lastReason.reason
          : null;
      const record: ServerExitRecord = { at: now.toISOString(), pid, code, reason };
      write(lockDir, record);
      lastExit = { lockDir, record, atMs: nowMs };
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
        const patched: ServerExitRecord = { ...lastExit.record, reason };
        write(lastExit.lockDir, patched);
        lastExit = { ...lastExit, record: patched };
      }
    },
  };
}
