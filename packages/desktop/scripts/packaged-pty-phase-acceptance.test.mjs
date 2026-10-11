import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    'Packaged PTY phase evidence is missing utility module-entry/point',
  );
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
    'Packaged PTY phase evidence is missing utility module-entry/point',
  );
});

test('rejects a session whose first output was never forwarded', () => {
  const unforwarded = session.filter((record) => record.phase !== 'pty-first-forward');
  expect(() => assertPackagedPtyPhaseEvidence(evidence([...startup, ...unforwarded]))).toThrow(
    'Packaged PTY phase evidence is missing utility pty-first-forward/point for the renderer session',
  );
});

test('rejects an evidence directory without a retained phase trace', () => {
  const root = mkdtempSync(join(tmpdir(), 'ok-pty-acceptance-missing-'));
  fixtures.push(root);
  const directory = join(root, 'evidence');
  mkdirSync(directory);
  expect(() => assertPackagedPtyPhaseEvidence(directory)).toThrow(/ENOENT/);
});
