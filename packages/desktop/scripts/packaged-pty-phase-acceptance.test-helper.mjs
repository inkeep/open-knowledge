import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPtyPhaseRecords } from './pty-phase-evidence.mjs';

const UTILITY_STARTUP_PHASES = [
  ['module-entry', 'point'],
  ['logger-import', 'begin'],
  ['native-import', 'begin'],
  ['native-import', 'end'],
  ['listener-ready', 'point'],
];

const RENDERER_SESSION_UTILITY_PHASES = [
  ['message-received', 'point'],
  ['shell-resolution', 'begin'],
  ['shell-resolution', 'end'],
  ['pty-spawn', 'begin'],
  ['pty-spawn', 'end'],
  ['pty-first-output', 'point'],
  ['pty-first-forward', 'point'],
];

function findRendererTraceUnavailable(driverStderr) {
  for (const line of driverStderr.split(/\r?\n/u)) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.event === 'pty-phase-trace-unavailable') return entry;
  }
  return undefined;
}

function utilityProcessRecords(records, { pid, timeOriginMs }) {
  return records.filter(
    (record) =>
      record.producer === 'utility' && record.pid === pid && record.timeOriginMs === timeOriginMs,
  );
}

function missingUtilityStartup(utility) {
  for (const [phase, edge] of UTILITY_STARTUP_PHASES) {
    if (!utility.some((record) => record.phase === phase && record.edge === edge)) {
      return `Packaged PTY phase evidence is missing utility ${phase}/${edge}`;
    }
  }
  if (
    !utility.some(
      (record) => record.phase === 'logger-import' && ['end', 'error'].includes(record.edge),
    )
  ) {
    return 'Packaged PTY phase evidence is missing the utility logger-import outcome';
  }
  return undefined;
}

function assertSomeUtilityProcessStarted(records) {
  const failures = records
    .filter(
      (record) =>
        record.producer === 'utility' && record.phase === 'module-entry' && record.edge === 'point',
    )
    .map((entry) => missingUtilityStartup(utilityProcessRecords(records, entry)));
  assert.ok(failures.includes(undefined), failures[0] ?? missingUtilityStartup([]));
}

function describeUncheckedRendererSession({ errorType, error }) {
  const phases = [...new Set(RENDERER_SESSION_UTILITY_PHASES.map(([phase]) => phase))];
  return `Packaged PTY renderer trace unavailable (${errorType}: ${error}), so the renderer session of this passing echo and that session's utility phases (${phases.join(', ')}) were not checked`;
}

export function assertPackagedPtyPhaseEvidence(directory, driverStderr = '') {
  assert.ok(directory, 'Packaged PTY phase evidence was not preserved');
  const records = readPtyPhaseRecords(readFileSync(join(directory, 'phase-trace.jsonl'), 'utf8'));
  const rendererTraceUnavailable = findRendererTraceUnavailable(driverStderr);
  if (rendererTraceUnavailable) {
    assertSomeUtilityProcessStarted(records);
    return describeUncheckedRendererSession(rendererTraceUnavailable);
  }
  const start = records.find(
    (record) =>
      record.producer === 'renderer' && record.phase === 'start' && record.edge === 'begin',
  );
  assert.ok(start?.ptyId, 'Packaged PTY phase evidence is missing the renderer session');
  const session = records.filter(
    (record) => record.producer === 'utility' && record.ptyId === start.ptyId,
  );
  assert.ok(session.length > 0, 'Packaged PTY phase evidence is missing the utility session');
  const utility = utilityProcessRecords(records, session[0]);
  const missingStartup = missingUtilityStartup(utility);
  assert.ok(!missingStartup, missingStartup);
  for (const [phase, edge] of RENDERER_SESSION_UTILITY_PHASES) {
    assert.ok(
      utility.some(
        (record) =>
          record.ptyId === start.ptyId &&
          record.phase === phase &&
          record.edge === edge &&
          (phase !== 'pty-first-output' || record.currentSession === true),
      ),
      `Packaged PTY phase evidence is missing utility ${phase}/${edge} for the renderer session`,
    );
  }
}
