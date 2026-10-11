import { EventEmitter, once } from 'node:events';
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import { expect, test } from 'vitest';
import { observePtyFork } from '../src/main/pty-phase-observation.ts';
import { createPtyPhaseTrace } from '../src/shared/pty-phase-trace.ts';
import { preservePtyEvidence, readPtyPhaseRecords } from './pty-phase-evidence.mjs';

const records = ['module-entry', 'listener-ready'].map((phase, index) => ({
  event: 'pty-phase',
  producer: 'utility',
  pid: 42,
  timeOriginMs: 100,
  sequence: index + 1,
  atMs: index,
  phase,
  edge: 'point',
}));

async function capture(flag) {
  const root = mkdtempSync(join(tmpdir(), 'ok-pty-transport-'));
  const logPath = join(root, 'app.log');
  const destination = createWriteStream(logPath);
  const stderr = new PassThrough();
  const utility = Object.assign(new EventEmitter(), { pid: 42, stderr });
  const trace = createPtyPhaseTrace({ OK_PTY_PHASE_TRACE: flag }, 'main', () => {});
  const bytes = Buffer.from(
    `${JSON.stringify(records[0])}\nutility π\n${JSON.stringify(records[1])}\n`,
  );
  const split = bytes.indexOf(Buffer.from('π')) + 1;
  const ended = once(stderr, 'end');
  try {
    stderr.write(bytes.subarray(0, split));
    observePtyFork(trace, 7, 1, () => utility, destination);
    const firstData = once(stderr, 'data');
    stderr.resume();
    await firstData;
    utility.emit('exit', 0);
    utility.stderr = null;
    stderr.resume();
    stderr.end(bytes.subarray(split));
    await ended;
    const destinationEndedBySource = destination.writableEnded;
    destination.end();
    await finished(destination);
    const saved = preservePtyEvidence({
      diagnosticsDir: join(root, 'saved'),
      logPath,
      logDir: join(root, 'logs'),
      userDataDir: join(root, 'profile'),
      launchedAt: 0,
      driver: { status: 0, stdout: '', stderr: '' },
    });
    return {
      input: bytes,
      output: readFileSync(join(saved, 'app-stdio.log')),
      records: readPtyPhaseRecords(readFileSync(join(saved, 'phase-trace.jsonl'), 'utf8')),
      destinationEndedBySource,
    };
  } finally {
    if (!stderr.readableEnded) stderr.end();
    if (!destination.writableEnded) destination.end();
    await finished(destination);
    rmSync(root, { recursive: true, force: true });
  }
}

test('retains utility diagnostic bytes through stream end after utility exit', async () => {
  const result = await capture('1');
  expect(result.output).toEqual(result.input);
  expect(result.records).toEqual(records);
  expect(result.destinationEndedBySource).toBe(false);
});

test.each([undefined, '0'])('does not forward utility stderr when tracing is %s', async (flag) => {
  const result = await capture(flag);
  expect(result.input.length).toBeGreaterThan(0);
  expect(result.output.length).toBe(0);
  expect(result.records).toEqual([]);
  expect(result.destinationEndedBySource).toBe(false);
});
