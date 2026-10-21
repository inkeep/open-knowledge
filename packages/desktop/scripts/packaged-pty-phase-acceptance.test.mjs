import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { assertPackagedPtyPhaseEvidence } from './packaged-pty-phase-acceptance.test-helper.mjs';

const fixtures = [];
afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function evidence(utilityRecords) {
  const directory = mkdtempSync(join(tmpdir(), 'ok-pty-acceptance-'));
  fixtures.push(directory);
  const records = [
    {
      event: 'pty-phase',
      producer: 'renderer',
      phase: 'start',
      edge: 'begin',
      ptyId: 'echo-session',
      atMs: 0,
      sequence: 1,
    },
    {
      event: 'pty-phase',
      producer: 'renderer',
      phase: 'renderer-data-received',
      edge: 'point',
      ptyId: 'echo-session',
      atMs: 1,
      sequence: 2,
    },
    ...[
      { phase: 'utility-data-received', edge: 'point' },
      { phase: 'main-data-relay', edge: 'begin' },
      { phase: 'main-data-relay', edge: 'end', ok: true },
    ].map((record, index) => ({
      event: 'pty-phase',
      producer: 'main',
      pid: 7,
      timeOriginMs: 100,
      atMs: index,
      sequence: index + 1,
      ptyId: 'echo-session',
      ...record,
    })),
    ...utilityRecords.map((record, index) => ({
      event: 'pty-phase',
      producer: 'utility',
      pid: 42,
      timeOriginMs: 100,
      atMs: index,
      sequence: index + 1,
      ...record,
    })),
  ];
  writeFileSync(
    join(directory, 'phase-trace.jsonl'),
    records.map((record) => JSON.stringify(record)).join('\n'),
  );
  return directory;
}

const startup = [
  { phase: 'utility-entry', edge: 'point' },
  { phase: 'module-entry', edge: 'point' },
  { phase: 'logger-import', edge: 'begin' },
  { phase: 'logger-import', edge: 'end' },
  { phase: 'native-import', edge: 'begin' },
  { phase: 'native-import', edge: 'end' },
  { phase: 'listener-ready', edge: 'point' },
];
const session = [
  { phase: 'message-received', edge: 'point' },
  { phase: 'shell-resolution', edge: 'begin' },
  { phase: 'shell-resolution', edge: 'end' },
  { phase: 'pty-spawn', edge: 'begin' },
  { phase: 'pty-spawn', edge: 'end' },
  { phase: 'pty-first-output', edge: 'point', currentSession: true },
  { phase: 'pty-first-forward', edge: 'point' },
].map((record) => ({ ...record, ptyId: 'echo-session' }));

test('accepts retained utility startup and output evidence for the renderer session', () => {
  expect(() => assertPackagedPtyPhaseEvidence(evidence([...startup, ...session]))).not.toThrow();
});

test('accepts a reported logger import failure when utility startup and output are retained', () => {
  const failedLogger = startup.map((record) =>
    record.phase === 'logger-import' && record.edge === 'end'
      ? { ...record, edge: 'error' }
      : record,
  );
  expect(() =>
    assertPackagedPtyPhaseEvidence(evidence([...failedLogger, ...session])),
  ).not.toThrow();
});

test('rejects a retained renderer session with no utility phase evidence', () => {
  expect(() => assertPackagedPtyPhaseEvidence(evidence([]))).toThrow(
    'Packaged PTY phase evidence is missing the utility session',
  );
});

test('rejects utility output without its earliest startup evidence', () => {
  expect(() => assertPackagedPtyPhaseEvidence(evidence(session))).toThrow(
    'Packaged PTY phase evidence is missing utility utility-entry/point',
  );
});

test('rejects utility startup whose process never marked the diagnostic entry', () => {
  const withoutEntry = startup.filter((record) => record.phase !== 'utility-entry');
  expect(() => assertPackagedPtyPhaseEvidence(evidence([...withoutEntry, ...session]))).toThrow(
    'Packaged PTY phase evidence is missing utility utility-entry/point',
  );
});

test('rejects utility startup without the host module entry', () => {
  const withoutModule = startup.filter((record) => record.phase !== 'module-entry');
  expect(() => assertPackagedPtyPhaseEvidence(evidence([...withoutModule, ...session]))).toThrow(
    'Packaged PTY phase evidence is missing utility module-entry/point',
  );
});

const rendererTraceUnavailable = `${JSON.stringify({
  event: 'pty-phase-trace-unavailable',
  errorType: 'TimeoutError',
  error: 'the original echo budget is exhausted',
})}\n`;

test('rejects an unavailable renderer trace whose utility process stopped after its diagnostic entry, naming the host module entry', () => {
  const entryOnly = startup.filter((record) => record.phase === 'utility-entry');
  expect(() =>
    assertPackagedPtyPhaseEvidence(evidence(entryOnly), rendererTraceUnavailable),
  ).toThrow('Packaged PTY phase evidence is missing utility module-entry/point');
});

test('rejects utility records belonging to a different terminal session', () => {
  const otherSession = session.map((record) => ({ ...record, ptyId: 'other-session' }));
  expect(() => assertPackagedPtyPhaseEvidence(evidence([...startup, ...otherSession]))).toThrow(
    'Packaged PTY phase evidence is missing the utility session',
  );
});

test('rejects startup records from a different utility process', () => {
  const otherProcess = startup.map((record) => ({ ...record, pid: 43 }));
  expect(() => assertPackagedPtyPhaseEvidence(evidence([...otherProcess, ...session]))).toThrow(
    'Packaged PTY phase evidence is missing utility utility-entry/point',
  );
});

test('rejects a session whose first output was never forwarded', () => {
  const unforwarded = session.filter((record) => record.phase !== 'pty-first-forward');
  expect(() => assertPackagedPtyPhaseEvidence(evidence([...startup, ...unforwarded]))).toThrow(
    'Packaged PTY phase evidence is missing utility pty-first-forward/point for the renderer session',
  );
});

test('rejects a renderer session without a renderer receive phase', () => {
  const directory = evidence([...startup, ...session]);
  const tracePath = join(directory, 'phase-trace.jsonl');
  const records = readFileSync(tracePath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((record) => record.phase !== 'renderer-data-received');
  writeFileSync(tracePath, records.map((record) => JSON.stringify(record)).join('\n'));
  expect(() => assertPackagedPtyPhaseEvidence(directory)).toThrow(
    'Packaged PTY phase evidence is missing renderer renderer-data-received/point',
  );
});

test('rejects a renderer session whose main relay did not send', () => {
  const directory = evidence([...startup, ...session]);
  const tracePath = join(directory, 'phase-trace.jsonl');
  const records = readFileSync(tracePath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .map((record) =>
      record.producer === 'main' && record.phase === 'main-data-relay' && record.edge === 'end'
        ? { ...record, ok: false }
        : record,
    );
  writeFileSync(tracePath, records.map((record) => JSON.stringify(record)).join('\n'));
  expect(() => assertPackagedPtyPhaseEvidence(directory)).toThrow(
    'Packaged PTY phase evidence is missing main main-data-relay/end',
  );
});

test('rejects an evidence directory without a retained phase trace', () => {
  const root = mkdtempSync(join(tmpdir(), 'ok-pty-acceptance-missing-'));
  fixtures.push(root);
  const directory = join(root, 'evidence');
  mkdirSync(directory);
  expect(() => assertPackagedPtyPhaseEvidence(directory)).toThrow(/ENOENT/);
});
