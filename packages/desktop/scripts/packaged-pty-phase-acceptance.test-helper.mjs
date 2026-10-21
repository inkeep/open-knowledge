import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPtyPhaseRecords } from './pty-phase-evidence.mjs';

const UTILITY_STARTUP_PHASES = [
  ['utility-entry', 'point'],
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

const MAIN_RELAY_PHASES = [
  ['utility-data-received', 'point'],
  ['main-data-relay', 'begin'],
  ['main-data-relay', 'end'],
];

const RENDERER_SESSION_PHASES = [['renderer-data-received', 'point']];

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
  const [entryPhase, entryEdge] = UTILITY_STARTUP_PHASES[0];
  const failures = records
    .filter(
      (record) =>
        record.producer === 'utility' && record.phase === entryPhase && record.edge === entryEdge,
    )
    .map((entry) => missingUtilityStartup(utilityProcessRecords(records, entry)));
  assert.ok(failures.includes(undefined), failures[0] ?? missingUtilityStartup([]));
}

const RENDERER_SESSION_PHASES_BY_PRODUCER = [
  ['utility', RENDERER_SESSION_UTILITY_PHASES],
  ['main', MAIN_RELAY_PHASES],
  ['renderer', RENDERER_SESSION_PHASES],
];

function describeUncheckedRendererSession({ errorType, error }) {
  const unchecked = RENDERER_SESSION_PHASES_BY_PRODUCER.map(
    ([producer, phases]) =>
      `${producer} phases (${[...new Set(phases.map(([phase]) => phase))].join(', ')})`,
  );
  return `Packaged PTY renderer trace unavailable (${errorType}: ${error}), so the renderer session of this passing echo and that session's ${unchecked.slice(0, -1).join(', ')} and ${unchecked.at(-1)} were not checked`;
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
  const main = records.filter(
    (record) => record.producer === 'main' && record.ptyId === start.ptyId,
  );
  for (const [phase, edge] of MAIN_RELAY_PHASES) {
    assert.ok(
      main.some(
        (record) =>
          record.phase === phase && record.edge === edge && (edge !== 'end' || record.ok === true),
      ),
      `Packaged PTY phase evidence is missing main ${phase}/${edge} for the renderer session`,
    );
  }
  for (const [phase, edge] of RENDERER_SESSION_PHASES) {
    assert.ok(
      records.some(
        (record) =>
          record.producer === 'renderer' &&
          record.ptyId === start.ptyId &&
          record.phase === phase &&
          record.edge === edge,
      ),
      `Packaged PTY phase evidence is missing renderer ${phase}/${edge} for the renderer session`,
    );
  }
}
