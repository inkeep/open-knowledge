import { getEnvironmentData, setEnvironmentData } from 'node:worker_threads';
import { expect, test, vi } from 'vitest';
import type {
  PtyProcessLike,
  PtyStartupObservation,
  PtyStartupSpawnContext,
} from '../../src/utility/pty-host.ts';
import {
  PTY_STARTUP_WORKER_CONTEXT,
  windowsPtyStartupTrace,
} from '../support/pty-startup-trace.test-helper.ts';

function context(): PtyStartupSpawnContext & { observations: PtyStartupObservation[] } {
  const observations: PtyStartupObservation[] = [];
  return {
    traceId: process.pid,
    attempt: process.pid,
    backend: 'bundled',
    startedAt: performance.timeOrigin + performance.now(),
    emit: (entry) => observations.push(entry),
    observations,
  };
}

const pty: PtyProcessLike = {
  pid: process.pid,
  onData: vi.fn(),
  onExit: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
};

test('observer scopes each spawn context and restores the previous context after a throw', () => {
  const previous = getEnvironmentData(PTY_STARTUP_WORKER_CONTEXT);
  const outer = { owner: 'outer-fixture' };
  const observation = context();
  const error = new Error('fixture spawn failure');
  setEnvironmentData(PTY_STARTUP_WORKER_CONTEXT, outer);
  try {
    const next = vi.fn(() => {
      expect(getEnvironmentData(PTY_STARTUP_WORKER_CONTEXT)).toEqual(
        expect.objectContaining({ traceId: observation.traceId, attempt: observation.attempt }),
      );
      throw error;
    });
    expect(() => windowsPtyStartupTrace.aroundSpawn?.(next, observation)).toThrow(error);
    expect(next).toHaveBeenCalledOnce();
    expect(getEnvironmentData(PTY_STARTUP_WORKER_CONTEXT)).toBe(outer);
  } finally {
    setEnvironmentData(PTY_STARTUP_WORKER_CONTEXT, previous);
  }
});

test('an unsupported native object reports missing observation without substituting a process or snapshot', () => {
  const observation = context();
  const next = vi.fn(() => pty);
  const previous = getEnvironmentData(PTY_STARTUP_WORKER_CONTEXT);
  const result = windowsPtyStartupTrace.aroundSpawn?.(next, observation);
  expect(next).toHaveBeenCalledOnce();
  expect(result?.pty).toBe(pty);
  expect(result?.snapshot).toBeUndefined();
  expect(observation.observations).toEqual([
    { stage: 'observer-unavailable', reason: 'unsupported-node-pty-shape' },
  ]);
  expect(getEnvironmentData(PTY_STARTUP_WORKER_CONTEXT)).toBe(previous);
  expect(pty.kill).not.toHaveBeenCalled();
});
