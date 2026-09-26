import { describe, expect, test, vi } from 'vitest';
import type { LockState } from './lock-state.ts';
import { buildPsV1, psV1Failure } from './ps.ts';

const root = '/tmp/wiki';
const path = `${root}/.ok/local/server.lock`;
const complete: LockState = {
  status: 'alive',
  lockPath: path,
  lock: {
    pid: 123,
    port: 4321,
    hostname: 'host',
    startedAt: '2026-01-01T00:00:00Z',
    worktreeRoot: root,
    protocolVersion: 2,
    runtimeVersion: '1.0',
    capabilities: ['http'],
    kind: 'interactive',
  },
};

describe('ps v1 inventory', () => {
  test('empty discovery is a successful empty object', async () => {
    expect(await buildPsV1({ discover: async () => [] })).toEqual({
      schemaVersion: 1,
      command: 'ps',
      result: { kind: 'success', code: 'inventoried', detail: null },
      servers: [],
    });
  });

  test('projects complete metadata and omits probe-only fields', async () => {
    const http = vi.fn(() => {
      throw new Error('HTTP probe attempted');
    });
    vi.stubGlobal('fetch', http);
    const document = await buildPsV1({
      discover: async () => [`${root}/.ok/local`],
      inspect: () => complete,
    });
    vi.unstubAllGlobals();
    expect(http).not.toHaveBeenCalled();
    expect(document.servers).toEqual([
      {
        projectRoot: root,
        lock: { path, state: 'alive' },
        process: {
          pid: 123,
          port: 4321,
          hostname: 'host',
          startedAt: '2026-01-01T00:00:00.000Z',
          draining: null,
        },
        alive: true,
        runtimeVersion: '1.0',
        protocolVersion: 2,
        capabilities: ['http'],
        launchKind: 'interactive',
      },
    ]);
    expect(JSON.stringify(document)).not.toMatch(/readiness|identity|runtime":/);
  });

  test('keeps each classification, deduplicates only equal paths, and sorts by path', async () => {
    const dirs = ['z', 'a', 'b', 'c', 'd', 'e', 'f'].map((name) => `/tmp/${name}/.ok/local`);
    const states: LockState[] = [
      complete,
      { ...complete, status: 'dead-pid' },
      { ...complete, status: 'foreign-host' },
      { status: 'unverified-owner', lockPath: '', pid: 123 },
      { status: 'corrupt', lockPath: '' },
      { status: 'read-error', lockPath: '', error: 'EACCES' },
      { status: 'missing', lockPath: '' },
    ];
    const inspect = vi.fn((dir: string) => {
      const index = dirs.indexOf(dir);
      return { ...states[index], lockPath: `${dir}/server.lock` } as LockState;
    });
    const document = await buildPsV1({ discover: async () => [...dirs, dirs[0]], inspect });
    expect(document.servers.map((entry) => entry.lock.state)).toEqual([
      'dead-pid',
      'foreign-host',
      'unverified-owner',
      'corrupt',
      'read-error',
      'missing',
      'alive',
    ]);
    expect(document.servers.map((entry) => entry.lock.path)).toEqual(
      document.servers.map((entry) => entry.lock.path).sort(),
    );
    expect(inspect).toHaveBeenCalledTimes(7);
    expect(document.servers[2]).toMatchObject({ process: { pid: 123, port: null }, alive: null });
    expect(document.servers[3]).toMatchObject({ process: null, alive: null });
  });

  test('distinct conflicting paths remain distinct and optional legacy metadata stays null', async () => {
    const dirs = ['/tmp/one/.ok/local', '/tmp/two/.ok/local'];
    const document = await buildPsV1({
      discover: async () => dirs,
      inspect: (dir) => ({
        ...complete,
        lockPath: `${dir}/server.lock`,
        lock: {
          ...complete.lock,
          startedAt: '',
          protocolVersion: undefined,
          runtimeVersion: undefined,
          capabilities: undefined,
          kind: undefined,
        },
      }),
    });
    expect(document.servers).toHaveLength(2);
    expect(document.servers[0]).toMatchObject({
      runtimeVersion: null,
      protocolVersion: null,
      capabilities: null,
      launchKind: null,
      process: { startedAt: null },
    });
  });

  test('discovery failures have a stable error envelope', async () => {
    await expect(
      buildPsV1({
        discover: async () => {
          throw new Error('scan failed');
        },
      }),
    ).rejects.toThrow('scan failed');
    expect(psV1Failure('discovery-failed', 'scan failed')).toEqual({
      schemaVersion: 1,
      command: 'ps',
      result: { kind: 'error', code: 'discovery-failed', detail: 'scan failed' },
      servers: [],
    });
  });
});
