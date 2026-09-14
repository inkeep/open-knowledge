import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, test, vi } from 'vitest';
import type { FileIndexEntry } from '../file-watcher.ts';
import { getLogger } from '../logger.ts';
import { createGitRoutes } from './git-routes.ts';

const worktreeReadCalls = vi.hoisted(() => [] as (AbortSignal | undefined)[]);

vi.mock('../git-worktree-status.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git-worktree-status.ts')>();
  return {
    ...actual,
    readWorktreeStatus: (
      _projectDir: string,
      _isSyncScoped: unknown,
      _toOpenTarget: unknown,
      options: { abortSignal?: AbortSignal } = {},
    ) => {
      worktreeReadCalls.push(options.abortSignal);
      return new Promise((resolve) => {
        options.abortSignal?.addEventListener(
          'abort',
          () =>
            resolve({
              readable: false,
              branch: null,
              detached: false,
              upstream: null,
              staged: [],
              notStaged: [],
              untracked: [],
              incoming: [],
              truncated: false,
            }),
          { once: true },
        );
      });
    },
  };
});

function buildGroup() {
  return createGitRoutes({
    projectDir: undefined,
    contentDir: '/nonexistent-content',
    contentFilter: undefined,
    getFileIndex: () => new Map<string, FileIndexEntry>(),
    checkLocalOpSecurity: () => true,
    getSyncEngine: undefined,
    getPrincipal: undefined,
    localOpCliArgs: ['open-knowledge'],
  });
}

describe('createGitRoutes table', () => {
  test('registers exactly the three git paths', () => {
    expect([...buildGroup().paths].sort()).toEqual(
      ['/api/git/branch-info', '/api/git/worktree-status', '/api/git/checkout'].sort(),
    );
  });

  test('checkout is mutating; the two reads are not', () => {
    const { table } = buildGroup();
    expect(table.isMutating('/api/git/checkout')).toBe(true);
    for (const path of ['/api/git/branch-info', '/api/git/worktree-status']) {
      expect(table.isMutating(path), path).toBe(false);
    }
  });
});

describe('worktree-status cancels its git work when the client gives up', () => {
  test('a client abort aborts the signal the read was given', async () => {
    worktreeReadCalls.length = 0;
    const dispatch = buildGroup().table.resolve('/api/git/worktree-status')?.dispatch;
    expect(dispatch).toBeDefined();

    const server = createServer((req, res) => {
      void dispatch?.(req, res).catch(() => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/api/git/worktree-status`, {
      signal: controller.signal,
    }).catch(() => undefined);

    await vi.waitFor(() => expect(worktreeReadCalls).toHaveLength(1));
    const signal = worktreeReadCalls[0];
    expect(signal?.aborted).toBe(false);

    controller.abort();
    await pending;
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('a client abort writes nothing to the support grep once the read settles', async () => {
    worktreeReadCalls.length = 0;
    const log = getLogger('http');
    const reported: Record<string, unknown>[] = [];
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(((data: unknown) => {
      reported.push((data ?? {}) as Record<string, unknown>);
    }) as never);
    const dispatch = buildGroup().table.resolve('/api/git/worktree-status')?.dispatch;
    const settled: unknown[] = [];

    const server = createServer((req, res) => {
      void dispatch?.(req, res).then(
        () => settled.push('ok'),
        (err) => settled.push(err),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const controller = new AbortController();
      const pending = fetch(`http://127.0.0.1:${port}/api/git/worktree-status`, {
        signal: controller.signal,
      }).catch(() => undefined);

      await vi.waitFor(() => expect(worktreeReadCalls).toHaveLength(1));
      controller.abort();
      await pending;
      await vi.waitFor(() => expect(settled).toHaveLength(1));

      expect(settled[0]).toBe('ok');
      expect(reported).toEqual([]);
    } finally {
      errorSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
