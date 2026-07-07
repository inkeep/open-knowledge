import { resolve } from 'node:path';

import { setToleranceTelemetryHook, type ToleranceFireRecord } from '@inkeep/open-knowledge-core';

import { getLocalDir } from './config/paths.ts';
import { RotatingAppender } from './telemetry-file-sink.ts';

const TELEMETRY_FILENAME = 'tolerance-telemetry.jsonl';
const TELEMETRY_PREV_FILENAME = 'tolerance-telemetry.prev.jsonl';
// Same two-generation ring as the span/log sinks (telemetry-file-sink.ts):
// rotation caps the active file and keeps one previous generation, so total
// disk footprint is bounded at ~2× this cap even when tolerance classes fire
// hot — which is exactly when an operator has this flag on.
const TELEMETRY_MAX_BYTES = 8 * 1024 * 1024;

/**
 * One JSONL line in `tolerance-telemetry.jsonl` — the single shape shared
 * with the aggregator CLI (`aggregate-tolerance-class-fires.ts`), so a field
 * rename cannot silently desync producer and consumer.
 *
 * `document` is the project-relative doc path in cleartext — a conscious
 * choice: this artifact is local-only, opt-in (OK_BRIDGE_TOLERANCE_TELEMETRY),
 * fixed-schema, and the path is the field an operator triaging a fidelity
 * incident needs verbatim. The span pipeline's scrubbing does not apply here.
 * For the same reason the file is deliberately a SIBLING of `.ok/local/telemetry/`,
 * not inside it: `ok diagnose bundle` harvests that subtree, and its redactor
 * only keys on `doc.name`-shaped span/log values — bundling this file would
 * ship these cleartext paths to a bug-report recipient unredacted.
 */
export interface ToleranceFireLine {
  event: 'bridge-tolerance-fire';
  timestamp: string;
  class: string;
  document: string | null;
  codeUnitPosition: number;
  severity: string;
}

let appender: RotatingAppender | null = null;
let appendFailureWarned = false;

export function isToleranceTelemetryEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.OK_BRIDGE_TOLERANCE_TELEMETRY === '1';
}

/**
 * Wire the core tolerance-telemetry hook to a rotating JSONL sink under
 * `<projectDir>/.ok/local/`. Self-gates on `OK_BRIDGE_TOLERANCE_TELEMETRY=1`;
 * called from `bootServer()` alongside `initTelemetry()`.
 *
 * The core hook is a process-global singleton BY DESIGN: it embeds a
 * per-project file path but registers process-wide, so under any future
 * multi-project host the last `initToleranceTelemetryWriter` wins. One
 * server process per contentDir (server.lock) makes this safe today;
 * revisit the hook shape before hosting multiple projects in-process.
 */
export function initToleranceTelemetryWriter(projectDir: string): void {
  if (!isToleranceTelemetryEnabled()) return;

  const localDir = getLocalDir(projectDir);
  appender = new RotatingAppender({
    currentPath: resolve(localDir, TELEMETRY_FILENAME),
    previousPath: resolve(localDir, TELEMETRY_PREV_FILENAME),
    maxBytes: TELEMETRY_MAX_BYTES,
  });

  setToleranceTelemetryHook((record: ToleranceFireRecord) => {
    const fireLine: ToleranceFireLine = {
      event: 'bridge-tolerance-fire',
      timestamp: record.timestamp,
      class: record.className,
      document: record.documentName ?? null,
      codeUnitPosition: record.codeUnitPosition,
      severity: record.severity,
    };
    // Best-effort fire-and-forget — telemetry must never block or fail the
    // bridge path. The appender serializes writes internally (raw node:fs by
    // design — observability sinks are exempt from the fs-traced STOP rule;
    // see RotatingAppender's recursion rationale). A swallowed failure still
    // warns ONCE: an operator who set the flag and gets an empty file needs
    // one signal pointing at the broken sink, not a silent no-op diagnostic.
    void appender?.append(`${JSON.stringify(fireLine)}\n`).catch((err: unknown) => {
      if (!appendFailureWarned) {
        appendFailureWarned = true;
        console.warn(
          '[tolerance-telemetry] append failed; further failures are silent:',
          err instanceof Error ? err.message : String(err),
        );
      }
    });
  });
}

/** Unhook and drain pending appends so teardown-time fires land on disk. */
export async function teardownToleranceTelemetryWriter(): Promise<void> {
  setToleranceTelemetryHook(null);
  await appender?.drain();
  appender = null;
  // Re-arm the one-shot append-failure warning: it budgets one diagnostic per
  // sink, and the appender it described is gone. Without this reset a
  // transient failure in one boot would silence the warning for every later
  // boot in the same process (test suites, Electron restart-recovery).
  appendFailureWarned = false;
}
