import { describe, expect, test, vi } from 'vitest';
import type { LockState } from './lock-state.ts';
import { buildStatusV1, statusV1Failure } from './status-v1.ts';

const project = { root: '/tmp/wiki', resolution: 'cwd' as const };
const lock: LockState = {
  status: 'alive',
  lockPath: '/tmp/wiki/.ok/local/server.lock',
  lock: {
    pid: 123,
    port: 4321,
    hostname: 'local',
    startedAt: '2026-01-01T00:00:00Z',
    worktreeRoot: '/tmp/wiki',
  },
};
const snapshot = {
  source: 'server',
  revision: 1,
  effectiveSince: '2026-01-01T00:00:00.000Z',
  port: 4321,
  bind: ['127.0.0.1'],
  idleShutdown: 'off',
  externalUrl: null,
};
const inspection = {
  pid: 123,
  projectRoot: '/tmp/wiki',
  serverInstanceId: 'instance',
  runtime: snapshot,
};

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function probe(inspectionResponse: Response, readyResponse: Response | Error) {
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/api/server-inspection')) return inspectionResponse;
    if (readyResponse instanceof Error) throw readyResponse;
    return readyResponse;
  });
  return { fetcher: fetcher as unknown as typeof fetch, spy: fetcher };
}

describe('status v1 readiness', () => {
  test.each([
    ['ready', 200, true, ['search', 'sync']],
    ['pending', 503, false, []],
    ['failed', 503, false, []],
    ['draining', 503, false, []],
  ] as const)(
    'preserves %s with matching status and body',
    async (status, httpStatus, ready, degraded) => {
      const { fetcher } = probe(
        response(200, inspection),
        response(httpStatus, { status, ready, degraded }),
      );
      const document = await buildStatusV1({
        project,
        lockDir: '/tmp/wiki/.ok/local',
        inspect: () => lock,
        fetch: fetcher,
        now: () => Date.UTC(2026, 0, 1),
      });
      expect(document.result).toEqual({ kind: 'success', code: 'observed', detail: null });
      expect(document.server.identity).toEqual({ serverInstanceId: 'instance' });
      expect(document.server.readiness).toEqual({
        status,
        checkedAt: '2026-01-01T00:00:00.000Z',
        degraded,
      });
      expect(document.server.runtime).toEqual(snapshot);
    },
  );

  test.each([
    [200, { status: 'pending', ready: false, degraded: [] }],
    [503, { status: 'ready', ready: true, degraded: [] }],
    [200, { status: 'ready', ready: false, degraded: [] }],
    [200, { status: 'ready', ready: true, degraded: ['ok', 1] }],
    [200, { status: 'alien', ready: true, degraded: [] }],
    [404, { status: 'ready', ready: true, degraded: [] }],
  ])('rejects invalid readiness status/body %#', async (httpStatus, body) => {
    const { fetcher } = probe(response(200, inspection), response(httpStatus, body));
    const document = await buildStatusV1({
      project,
      lockDir: '/tmp/wiki/.ok/local',
      inspect: () => lock,
      fetch: fetcher,
    });
    expect(document.server.readiness.status).toBe('unknown');
    expect(document.server.readiness.checkedAt).not.toBeNull();
  });

  test.each([
    [403, inspection],
    [200, { ...inspection, pid: 124 }],
    [200, { ...inspection, projectRoot: '/tmp/other' }],
    [200, { ...inspection, serverInstanceId: '' }],
    [200, { ...inspection, runtime: { ...snapshot, revision: 'bad' } }],
  ])('does not confirm invalid inspection %#', async (httpStatus, body) => {
    const { fetcher, spy } = probe(
      response(httpStatus, body),
      response(200, { status: 'ready', ready: true, degraded: [] }),
    );
    const document = await buildStatusV1({
      project,
      lockDir: '/tmp/wiki/.ok/local',
      inspect: () => lock,
      fetch: fetcher,
    });
    expect(document.server.identity).toBeNull();
    expect(document.server.runtime).toBeNull();
    expect(document.server.readiness.status).toBe('unknown');
    expect(spy).toHaveBeenCalledTimes(3);
  });

  test('uses the advertised IPv6 loopback origin for inspection and readiness', async () => {
    const fetcher = vi.fn(async (url: string) =>
      url.endsWith('/api/server-inspection')
        ? response(200, { ...inspection, runtime: { ...snapshot, bind: ['::1'] } })
        : response(200, { status: 'ready', ready: true, degraded: [] }),
    );
    const document = await buildStatusV1({
      project,
      lockDir: '/tmp/wiki/.ok/local',
      inspect: () => ({ ...lock, lock: { ...lock.lock, url: 'http://[::1]:4321' } }),
      fetch: fetcher as unknown as typeof fetch,
    });
    expect(document.server.readiness.status).toBe('ready');
    expect(document.server.runtime?.bind).toEqual(['::1']);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'http://[::1]:4321/api/server-inspection',
      'http://[::1]:4321/readyz',
    ]);
  });

  test('tries IPv6 when other loopback origins cannot confirm the server', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.startsWith('http://localhost:')) throw new Error('connection refused');
      if (url.startsWith('http://127.0.0.1:')) return response(200, { ...inspection, pid: 999 });
      return url.endsWith('/api/server-inspection')
        ? response(200, inspection)
        : response(200, { status: 'ready', ready: true, degraded: [] });
    });
    const document = await buildStatusV1({
      project,
      lockDir: '/tmp/wiki/.ok/local',
      inspect: () => lock,
      fetch: fetcher as unknown as typeof fetch,
    });
    expect(document.server.identity).toEqual({ serverInstanceId: 'instance' });
    expect(document.server.readiness.status).toBe('ready');
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'http://localhost:4321/api/server-inspection',
      'http://127.0.0.1:4321/api/server-inspection',
      'http://[::1]:4321/api/server-inspection',
      'http://[::1]:4321/readyz',
    ]);
  });

  test('confirmed identity followed by transport failure is unreachable', async () => {
    const { fetcher } = probe(response(200, inspection), new Error('connection reset'));
    const document = await buildStatusV1({
      project,
      lockDir: '/tmp/wiki/.ok/local',
      inspect: () => lock,
      fetch: fetcher,
    });
    expect(document.server.readiness.status).toBe('unreachable');
    expect(document.server.readiness.checkedAt).not.toBeNull();
  });

  test('inspection and readiness share one two-second deadline', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn((url: string, init?: RequestInit) => {
        if (url.endsWith('/api/server-inspection')) {
          return new Promise<Response>((resolve) =>
            setTimeout(() => resolve(response(200, inspection)), 1_500),
          );
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      });
      const promise = buildStatusV1({
        project,
        lockDir: '/tmp/wiki/.ok/local',
        inspect: () => lock,
        fetch: fetcher as unknown as typeof fetch,
      });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(fetcher).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(500);
      const document = await promise;
      expect(document.server.readiness.status).toBe('unreachable');
      expect(document.server.readiness.checkedAt).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test.each([
    ['missing', { status: 'missing', lockPath: lock.lockPath }],
    ['dead-pid', { ...lock, status: 'dead-pid' }],
    ['corrupt', { status: 'corrupt', lockPath: lock.lockPath }],
    ['read-error', { status: 'read-error', lockPath: lock.lockPath, error: 'EACCES' }],
    ['unverified-owner', { status: 'unverified-owner', lockPath: lock.lockPath, pid: 123 }],
    ['foreign-host', { ...lock, status: 'foreign-host' }],
  ] as const)('classifies %s without probing', async (_label, state) => {
    const fetcher = vi.fn();
    const document = await buildStatusV1({
      project,
      lockDir: '/tmp/wiki/.ok/local',
      inspect: () => state as LockState,
      fetch: fetcher,
    });
    expect(document.server.readiness.status).toBe(
      document.server.alive === false ? 'not-running' : 'unknown',
    );
    expect(document.server.readiness.checkedAt).toBeNull();
    expect(document.server.runtime).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('legacy lock fields remain nullable', async () => {
    const { fetcher } = probe(response(404, {}), response(200, {}));
    const document = await buildStatusV1({
      project,
      lockDir: '/tmp/wiki/.ok/local',
      inspect: () => lock,
      fetch: fetcher,
    });
    expect(document.server).toMatchObject({
      runtimeVersion: null,
      protocolVersion: null,
      capabilities: null,
      launchKind: null,
    });
    expect(document.server.process?.startedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  test('pre-classification failure has the required null envelope', () => {
    expect(statusV1Failure('project-unavailable', 'bad config')).toMatchObject({
      project: { root: null, resolution: 'unavailable' },
      server: {
        lock: { path: null, state: 'unknown' },
        process: null,
        identity: null,
        runtime: null,
        readiness: { status: 'unknown', checkedAt: null, degraded: [] },
      },
    });
  });
});
