import { EventEmitter } from 'node:events';
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { observePtyFork } from '../main/pty-phase-observation.ts';
import { createPtyPhaseTrace, type PtyPhaseRecord } from './pty-phase-trace.ts';

afterEach(() => vi.restoreAllMocks());

test.each([undefined, '0'])(
  'does not read clocks, emit records or install listeners with tracing %s',
  (flag) => {
    const now = vi.spyOn(performance, 'now');
    const wall = vi.spyOn(Date, 'now');
    const write = vi.fn();
    const trace = createPtyPhaseTrace({ OK_PTY_PHASE_TRACE: flag }, 'main', write);
    const utility = Object.assign(new EventEmitter(), { pid: undefined as number | undefined });
    expect(observePtyFork(trace, 7, 1, () => utility)).toBe(utility);
    expect(utility.eventNames()).toEqual([]);
    expect(trace).toBeUndefined();
    expect(now).not.toHaveBeenCalled();
    expect(wall).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  },
);

test('records utility creation, owned process identity and exit without an error listener', () => {
  const records: PtyPhaseRecord[] = [];
  const trace = createPtyPhaseTrace({ OK_PTY_PHASE_TRACE: '1' }, 'main', (record) =>
    records.push(record),
  );
  const utility = Object.assign(new EventEmitter(), { pid: undefined as number | undefined });
  expect(observePtyFork(trace, 7, 1, () => utility)).toBe(utility);
  utility.pid = 12345;
  utility.emit('spawn');
  utility.pid = undefined;
  utility.emit('exit', 3);
  expect(records.map(({ phase, edge }) => [phase, edge])).toEqual([
    ['utility-fork', 'begin'],
    ['utility-fork', 'end'],
    ['utility-spawn', 'point'],
    ['utility-exit', 'point'],
  ]);
  expect(records.at(-1)).toMatchObject({
    windowId: 7,
    forkId: 1,
    utilityPid: 12345,
    exitCode: 3,
    sequence: 4,
  });
  expect(utility.listenerCount('error')).toBe(0);
});

test('bounds an enabled trace with an explicit limit record', () => {
  const records: PtyPhaseRecord[] = [];
  const trace = createPtyPhaseTrace({ OK_PTY_PHASE_TRACE: '1' }, 'utility', (record) =>
    records.push(record),
  );
  for (let index = 0; index < 1000; index += 1) trace?.mark('message-received', 'point');
  expect(records.length).toBeLessThan(1000);
  expect(records.at(-1)).toMatchObject({
    phase: 'trace-limit',
    edge: 'point',
    sequence: records.length,
  });
});

test('a failed diagnostic write cannot replace an operation error', () => {
  const root = mkdtempSync(join(tmpdir(), 'ok-phase-write-'));
  const fd = openSync(join(root, 'closed.log'), 'w');
  closeSync(fd);
  try {
    const trace = createPtyPhaseTrace({ OK_PTY_PHASE_TRACE: '1' }, 'main', () => {
      writeSync(fd, 'unwritable');
    });
    let original: unknown;
    let caught: unknown;
    try {
      observePtyFork(trace, 7, 1, () => {
        try {
          return JSON.parse('{');
        } catch (error) {
          original = error;
          throw error;
        }
      });
    } catch (error) {
      caught = error;
    }
    expect(original).toBeInstanceOf(SyntaxError);
    expect(caught).toBe(original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
