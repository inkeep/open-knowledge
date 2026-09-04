import { resolve } from 'node:path';

import { setToleranceTelemetryHook, type ToleranceFireRecord } from '@inkeep/open-knowledge-core';

import { getLocalDir } from './config/paths.ts';
import { getLogger } from './logger.ts';
import { RotatingAppender } from './telemetry-file-sink.ts';

const TELEMETRY_FILENAME = 'tolerance-telemetry.jsonl';
const TELEMETRY_PREV_FILENAME = 'tolerance-telemetry.prev.jsonl';
const TELEMETRY_MAX_BYTES = 8 * 1024 * 1024;

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
    void appender?.append(`${JSON.stringify(fireLine)}\n`).catch((err: unknown) => {
      if (!appendFailureWarned) {
        appendFailureWarned = true;
        getLogger('tolerance-telemetry').warn(
          { err: err instanceof Error ? err : new Error(String(err)) },
          'append failed; further failures are silent',
        );
      }
    });
  });
}

export async function teardownToleranceTelemetryWriter(): Promise<void> {
  setToleranceTelemetryHook(null);
  await appender?.drain();
  appender = null;
  appendFailureWarned = false;
}
