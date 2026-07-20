/**
 * Fatal-crash capture for the collab server process.
 *
 * A hard crash (uncaught exception, unhandled rejection under Node's default
 * throw mode) loses the async pino file sink's unwritten tail, so the log
 * files a bug-report bundle collects end at some arbitrary point BEFORE the
 * error that killed the process — bundles can prove the server is not
 * running but never why it died. This module closes that gap by writing two
 * synchronous artifacts on the way down:
 *
 *   1. One structured JSONL line appended to the same
 *      `<projectDir>/.ok/local/logs/server-current.jsonl` the bundle
 *      collector already harvests (pino-compatible: `level: 60` = fatal).
 *   2. `<projectDir>/.ok/local/last-server-crash.json` — a small standalone record
 *      (timestamp, origin, error name/message/stack, pid, uptime) staged
 *      into bundles beside `last-server-exit.json`.
 *
 * The hook is `process.on('uncaughtExceptionMonitor')` — observe-only by
 * contract, running BEFORE Node's default crash handling without replacing
 * it, so crash semantics (stderr stack + non-zero exit) are preserved
 * exactly and the process can never be turned into a zombie by this module.
 * Under Node's default `--unhandled-rejections=throw` mode the monitor also
 * fires for unhandled rejections (with `origin: 'unhandledRejection'`), so a
 * separate `unhandledRejection` listener — which WOULD suppress the default
 * crash — is deliberately not registered. Same posture as the MCP stdio
 * server's lifecycle breadcrumbs in the CLI package.
 *
 * One process-level listener serves every registered project (integration
 * tests boot many servers per process; a listener per boot would trip Node's
 * MaxListeners warning — same registry pattern as `process-lock.ts`'s exit
 * unlink handler). Everything in the crash path is wrapped so a write
 * failure can never itself perturb the dying process.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SERVER_CRASH_LOG } from '@inkeep/open-knowledge-core';
import { getLocalDir } from './config/paths.ts';
import { logsCurrentPath } from './telemetry-file-sink.ts';

export interface CrashRecord {
  timestamp: string;
  /** `'uncaughtException'` or `'unhandledRejection'` (Node's monitor origin). */
  origin: string;
  error: { name: string; message: string; stack: string | null };
  pid: number;
  uptimeSec: number;
}

/** Normalize an arbitrary thrown value into the crash-record error shape. */
export function buildCrashRecord(err: unknown, origin: string): CrashRecord {
  const error =
    err instanceof Error
      ? { name: err.name, message: err.message, stack: err.stack ?? null }
      : { name: 'NonError', message: String(err), stack: null };
  return {
    timestamp: new Date().toISOString(),
    origin,
    error,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime() * 1000) / 1000,
  };
}

/**
 * Write both crash artifacts for one project. Each write is independently
 * best-effort: raw synchronous `node:fs`, NOT the `fs-traced.ts` wrappers —
 * this runs mid-crash, after the async OTel/pino pipeline can no longer be
 * trusted to flush, and a traced write would emit a span into the dying SDK
 * (same carve-out as `RotatingAppender`'s observability-sink writes).
 */
export function writeCrashArtifacts(projectDir: string, record: CrashRecord): void {
  const localDir = getLocalDir(projectDir);
  try {
    mkdirSync(localDir, { recursive: true });
    // Truncate-write, latest-crash-only by design. In a crash-restart loop
    // this holds the most recent crash rather than the root-cause one, but the
    // full timeline (every crash, root cause included) is preserved by the
    // append-mode JSONL sink below — which the bundle collects too. Keeping
    // this write a single atomic truncate avoids a read-parse-append-write on
    // a possibly-half-written prior file while the process is already dying.
    writeFileSync(join(localDir, SERVER_CRASH_LOG), `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    // Nothing safe to do mid-crash; the other artifact may still land.
  }
  try {
    const logsPath = logsCurrentPath(projectDir);
    mkdirSync(dirname(logsPath), { recursive: true });
    const line = {
      level: 60,
      time: Date.parse(record.timestamp),
      name: 'crash',
      origin: record.origin,
      err: record.error,
      pid: record.pid,
      uptimeSec: record.uptimeSec,
      msg: `fatal ${record.origin} — process crashing`,
    };
    writeFileSync(logsPath, `${JSON.stringify(line)}\n`, { flag: 'a' });
  } catch {
    // Best-effort only.
  }
}

/** Refcounted registry of project dirs the single monitor listener serves. */
const capturedProjectDirs = new Map<string, number>();
let monitorRegistered = false;

function onMonitor(err: unknown, origin: string): void {
  try {
    const record = buildCrashRecord(err, origin);
    for (const projectDir of capturedProjectDirs.keys()) {
      writeCrashArtifacts(projectDir, record);
    }
  } catch {
    // A throwing monitor would itself trigger Node's default crash path
    // before the original exception is handled — swallow unconditionally.
  }
}

export interface CrashCaptureHandle {
  uninstall: () => void;
}

/**
 * Arm crash capture for `projectDir`. Returns a handle whose `uninstall`
 * detaches this project from the registry (the shared process listener stays
 * attached — it is a no-op with an empty registry).
 */
export function installCrashCapture(projectDir: string): CrashCaptureHandle {
  capturedProjectDirs.set(projectDir, (capturedProjectDirs.get(projectDir) ?? 0) + 1);
  if (!monitorRegistered) {
    monitorRegistered = true;
    process.on('uncaughtExceptionMonitor', onMonitor);
  }
  let uninstalled = false;
  return {
    uninstall: () => {
      if (uninstalled) return;
      uninstalled = true;
      const count = capturedProjectDirs.get(projectDir) ?? 0;
      if (count <= 1) capturedProjectDirs.delete(projectDir);
      else capturedProjectDirs.set(projectDir, count - 1);
    },
  };
}
