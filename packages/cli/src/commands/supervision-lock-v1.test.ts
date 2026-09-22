import { describe, expect, test } from 'vitest';
import type { LockState } from './lock-state.ts';
import { projectV1LockMetadata, projectV1LockState } from './supervision-lock-v1.ts';

const lockPath = '/projects/wiki/.ok/local/server.lock';

describe('v1 lock projection', () => {
  test('valid metadata is normalized without synthesizing missing fields', () => {
    expect(
      projectV1LockMetadata({
        pid: 1234,
        port: 0,
        hostname: 'host-a',
        startedAt: '2026-09-22T10:20:30-04:00',
        draining: false,
        runtimeVersion: '0.77.1',
        protocolVersion: 2,
        capabilities: [],
        kind: 'interactive',
      }),
    ).toEqual({
      process: {
        pid: 1234,
        port: 0,
        hostname: 'host-a',
        startedAt: '2026-09-22T14:20:30.000Z',
        draining: false,
      },
      runtimeVersion: '0.77.1',
      protocolVersion: 2,
      capabilities: [],
      launchKind: 'interactive',
    });

    expect(projectV1LockMetadata({ pid: 1234 })).toEqual({
      process: { pid: 1234, port: null, hostname: null, startedAt: null, draining: null },
      runtimeVersion: null,
      protocolVersion: null,
      capabilities: null,
      launchKind: null,
    });
  });

  test('malformed optional metadata becomes null without discarding a valid PID', () => {
    expect(
      projectV1LockMetadata({
        pid: 1234,
        port: '4242',
        hostname: '',
        startedAt: 'yesterday',
        draining: 'false',
        runtimeVersion: 77,
        protocolVersion: -1,
        capabilities: ['http', 42],
        kind: 'background',
      }),
    ).toEqual({
      process: { pid: 1234, port: null, hostname: null, startedAt: null, draining: null },
      runtimeVersion: null,
      protocolVersion: null,
      capabilities: null,
      launchKind: null,
    });
    expect(projectV1LockMetadata({ pid: 0, runtimeVersion: '0.77.1' })).toEqual({
      process: null,
      runtimeVersion: null,
      protocolVersion: null,
      capabilities: null,
      launchKind: null,
    });
    expect(
      projectV1LockMetadata({ pid: 1234, startedAt: '2026-02-30T00:00:00Z' }).process,
    ).toHaveProperty('startedAt', null);
  });

  test.each([
    ['alive', true],
    ['dead-pid', false],
    ['foreign-host', null],
  ] as const)(
    '%s keeps the classified liveness without trusting optional fields',
    (status, alive) => {
      const state = {
        status,
        lockPath,
        lock: {
          pid: 1234,
          port: 4242,
          hostname: 'host-a',
          startedAt: '2026-09-22T14:20:30Z',
          worktreeRoot: '/projects/wiki',
        },
      } satisfies LockState;
      expect(projectV1LockState(state)).toEqual({
        lock: { path: lockPath, state: status },
        process: {
          pid: 1234,
          port: 4242,
          hostname: 'host-a',
          startedAt: '2026-09-22T14:20:30.000Z',
          draining: null,
        },
        alive,
        runtimeVersion: null,
        protocolVersion: null,
        capabilities: null,
        launchKind: null,
      });
    },
  );

  test('uncertain and absent locks retain their classifications and null metadata', () => {
    const states: LockState[] = [
      { status: 'unverified-owner', lockPath, pid: 1234 },
      { status: 'missing', lockPath },
      { status: 'corrupt', lockPath },
      { status: 'read-error', lockPath, error: 'permission denied' },
    ];
    const projected = states.map(projectV1LockState);

    expect(
      projected.map(({ lock, alive, process }) => [lock.state, alive, process?.pid ?? null]),
    ).toEqual([
      ['unverified-owner', null, 1234],
      ['missing', false, null],
      ['corrupt', null, null],
      ['read-error', null, null],
    ]);
    for (const entry of projected) {
      expect(entry.lock.path).toBe(lockPath);
      expect(entry.runtimeVersion).toBeNull();
      expect(entry.protocolVersion).toBeNull();
      expect(entry.capabilities).toBeNull();
      expect(entry.launchKind).toBeNull();
    }
    expect(projected[0]?.process).toEqual({
      pid: 1234,
      startedAt: null,
      port: null,
      hostname: null,
      draining: null,
    });
  });

  test('a nonabsolute lock path cannot enter the v1 document', () => {
    expect(
      projectV1LockState({ status: 'missing', lockPath: 'relative/server.lock' }).lock.path,
    ).toBeNull();
  });
});
