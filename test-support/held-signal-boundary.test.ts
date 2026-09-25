import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { installSignalBoundary, type SignalBoundary } from './held-signal-boundary.test-helper';

const PID_BEYOND_ANY_KERNEL_LIMIT = 4_194_331;
const SECOND_PID_BEYOND_ANY_KERNEL_LIMIT = 4_194_347;
const THIRD_PID_BEYOND_ANY_KERNEL_LIMIT = 4_194_353;

const originalKill = process.kill;
let underlying: Array<[number, unknown]>;
let underlyingSender: (target: number, signal?: unknown) => true;
let boundary: SignalBoundary | undefined;

beforeEach(() => {
  underlying = [];
  underlyingSender = (target, signal) => {
    underlying.push([target, signal]);
    return true;
  };
  process.kill = underlyingSender as typeof process.kill;
  if (process.kill !== underlyingSender) {
    process.kill = originalKill;
    throw new Error('process.kill could not be stubbed; refusing to exercise the boundary');
  }
});

afterEach(() => {
  boundary?.restore();
  boundary = undefined;
  process.kill = originalKill;
});

function fakeChild(
  pid: number,
  state: { exitCode: number | null; signalCode: NodeJS.Signals | null },
): ChildProcess {
  return Object.assign(new EventEmitter(), { pid, ...state }) as unknown as ChildProcess;
}

describe('installSignalBoundary', () => {
  test('replaces process.kill until restored, and refuses a second install', () => {
    boundary = installSignalBoundary({ deliverToHeldChildren: true });
    expect(process.kill).toBe(boundary.send);
    expect(() => installSignalBoundary({ deliverToHeldChildren: true })).toThrow();
    boundary.restore();
    expect(process.kill).toBe(underlyingSender);
  });

  test('delivers a signal to a held child that has not been reaped, and to its group', () => {
    boundary = installSignalBoundary({ deliverToHeldChildren: true });
    boundary.hold(fakeChild(PID_BEYOND_ANY_KERNEL_LIMIT, { exitCode: null, signalCode: null }));

    boundary.send(PID_BEYOND_ANY_KERNEL_LIMIT, 'SIGTERM');
    boundary.send(-PID_BEYOND_ANY_KERNEL_LIMIT, 'SIGKILL');

    expect({ underlying, refused: boundary.refused }).toEqual({
      underlying: [
        [PID_BEYOND_ANY_KERNEL_LIMIT, 'SIGTERM'],
        [-PID_BEYOND_ANY_KERNEL_LIMIT, 'SIGKILL'],
      ],
      refused: [],
    });
  });

  test('records without delivering a signal to a held child that exited or was killed', () => {
    boundary = installSignalBoundary({ deliverToHeldChildren: true });
    boundary.hold(fakeChild(PID_BEYOND_ANY_KERNEL_LIMIT, { exitCode: 0, signalCode: null }));
    boundary.hold(
      fakeChild(SECOND_PID_BEYOND_ANY_KERNEL_LIMIT, { exitCode: null, signalCode: 'SIGTERM' }),
    );

    boundary.send(-PID_BEYOND_ANY_KERNEL_LIMIT, 'SIGKILL');
    boundary.send(SECOND_PID_BEYOND_ANY_KERNEL_LIMIT, 'SIGKILL');

    expect({ underlying, refused: boundary.refused }).toEqual({
      underlying: [],
      refused: [
        { target: -PID_BEYOND_ANY_KERNEL_LIMIT, signal: 'SIGKILL' },
        { target: SECOND_PID_BEYOND_ANY_KERNEL_LIMIT, signal: 'SIGKILL' },
      ],
    });
  });

  test('records without delivering a signal to a pid it was never given', () => {
    boundary = installSignalBoundary({ deliverToHeldChildren: true });
    boundary.hold(fakeChild(PID_BEYOND_ANY_KERNEL_LIMIT, { exitCode: null, signalCode: null }));

    boundary.send(THIRD_PID_BEYOND_ANY_KERNEL_LIMIT, 'SIGKILL');

    expect({ underlying, refused: boundary.refused }).toEqual({
      underlying: [],
      refused: [{ target: THIRD_PID_BEYOND_ANY_KERNEL_LIMIT, signal: 'SIGKILL' }],
    });
  });

  test('delivers nothing to a held, unreaped child when told to deliver to no child', () => {
    boundary = installSignalBoundary({ deliverToHeldChildren: false });
    boundary.hold(fakeChild(PID_BEYOND_ANY_KERNEL_LIMIT, { exitCode: null, signalCode: null }));

    boundary.send(PID_BEYOND_ANY_KERNEL_LIMIT, 'SIGKILL');

    expect({ underlying, refused: boundary.refused.length }).toEqual({
      underlying: [],
      refused: 1,
    });
  });

  test.each([0, 1, -1, 1.5, Number.NaN])(
    'records without delivering a signal to %p, which names no single process',
    (target) => {
      boundary = installSignalBoundary({ deliverToHeldChildren: true });
      boundary.hold(fakeChild(1, { exitCode: null, signalCode: null }));

      boundary.send(target, 'SIGKILL');

      expect({ underlying, refused: boundary.refused.length }).toEqual({
        underlying: [],
        refused: 1,
      });
    },
  );

  test('passes a liveness probe through without recording it as a signal', () => {
    boundary = installSignalBoundary({ deliverToHeldChildren: false });

    boundary.send(PID_BEYOND_ANY_KERNEL_LIMIT, 0);

    expect({ underlying, probes: boundary.probes.length, refused: boundary.refused }).toEqual({
      underlying: [[PID_BEYOND_ANY_KERNEL_LIMIT, 0]],
      probes: 1,
      refused: [],
    });
  });

  test('records without delivering a signal addressed to this process', () => {
    boundary = installSignalBoundary({ deliverToHeldChildren: true });

    boundary.send(process.pid, 'SIGTERM');

    expect({ underlying, selfSignals: boundary.selfSignals.length }).toEqual({
      underlying: [],
      selfSignals: 1,
    });
  });
});
