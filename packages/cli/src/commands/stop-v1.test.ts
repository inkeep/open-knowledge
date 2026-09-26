import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import type { LockState } from './lock-state.ts';
import { runStop } from './stop.ts';
import { buildStopV1 } from './stop-v1.ts';

const first = '/tmp/ok-stop-v1-a/.ok/local';
const second = '/tmp/ok-stop-v1-b/.ok/local';

function alive(dir: string, pid: number, port: number): LockState {
  return {
    status: 'alive',
    lockPath: join(dir, 'server.lock'),
    lock: {
      pid,
      port,
      hostname: 'host',
      startedAt: '2026-09-22T00:00:00.000Z',
      worktreeRoot: '/copied',
    },
  };
}

describe('stop v1 numeric selection', () => {
  test('returns target-not-found without records for an absent number', async () => {
    const stop = vi.fn<typeof runStop>();
    const document = await buildStopV1({
      target: '4242',
      force: false,
      projectRoot: '/tmp',
      discover: async () => [],
      stop,
    });
    expect(document.result).toMatchObject({ code: 'target-not-found', kind: 'no-op' });
    expect(document.targets).toEqual([]);
    expect(stop).not.toHaveBeenCalled();
  });

  test('keeps the explicit path selector and a missing lock record', async () => {
    const path = '/tmp/ok-stop-v1-a';
    const document = await buildStopV1({
      target: path,
      force: false,
      projectRoot: '/tmp',
      inspect: (dir) => ({ status: 'missing', lockPath: join(dir, 'server.lock') }),
    });
    expect(document.target.kind).toBe('path');
    expect(document.target.value).toBe(path);
    expect(document.result.code).toBe('already-stopped');
    expect(document.targets).toHaveLength(1);
  });

  test('aggregates a successful all signal with a connected-client refusal', async () => {
    const stop = (deps: Parameters<typeof runStop>[0]) =>
      runStop({
        ...deps,
        kill: () => {},
        probeClients: async () => (deps.lockDir === second ? 2 : 0),
      });
    const document = await buildStopV1({
      target: 'all',
      force: false,
      projectRoot: '/tmp',
      discover: async () => [first, second],
      inspect: (dir) => alive(dir, dir === first ? 101 : 102, 4242),
      stop,
    });
    expect(document.result).toMatchObject({ code: 'partially-signalled', kind: 'partial' });
    expect(document.targets.map((item) => item.code)).toEqual(['signalled', 'clients-connected']);
  });
  test.each([
    [4242, 101, 102, 4242, 4242],
    [101, 101, 101, 4242, 4243],
    [101, 101, 102, 4242, 101],
  ])(
    'refuses distinct matches for %i before mutation',
    async (target, pidA, pidB, portA, portB) => {
      const stop = vi.fn<typeof runStop>();
      const document = await buildStopV1({
        target: String(target),
        force: true,
        projectRoot: '/tmp',
        discover: async () => [first, second],
        inspect: (dir) => (dir === first ? alive(first, pidA, portA) : alive(second, pidB, portB)),
        confirm: async () => null,
        stop,
      });
      expect(document.result).toMatchObject({ code: 'ambiguous-target', kind: 'refused' });
      expect(document.targets.map((item) => item.lockPath)).toEqual([
        join(first, 'server.lock'),
        join(second, 'server.lock'),
      ]);
      expect(document.targets.map((item) => item.projectRoot)).toEqual([
        '/tmp/ok-stop-v1-a',
        '/tmp/ok-stop-v1-b',
      ]);
      expect(stop).not.toHaveBeenCalled();
    },
  );

  test('deduplicates repeated discovery of one normalized lock path', async () => {
    const stop = vi.fn((deps: Parameters<typeof runStop>[0]) =>
      runStop({ ...deps, kill: () => {}, probeClients: async () => null }),
    );
    const document = await buildStopV1({
      target: '4242',
      force: false,
      projectRoot: '/tmp',
      discover: async () => [first, join(first, '.')],
      inspect: () => alive(first, 101, 4242),
      confirm: async () => null,
      stop,
    });
    expect(document.result.code).toBe('signalled');
    expect(document.targets).toHaveLength(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test('collapses distinct paths only with matching confirmed identity', async () => {
    const stop = vi.fn((deps: Parameters<typeof runStop>[0]) =>
      runStop({ ...deps, kill: () => {}, probeClients: async () => null }),
    );
    const document = await buildStopV1({
      target: '4242',
      force: false,
      projectRoot: '/tmp',
      discover: async () => [first, second],
      inspect: (dir) => alive(dir, 101, 4242),
      confirm: async () => 'same-instance',
      stop,
    });
    expect(document.result.code).toBe('ambiguous-target');
    expect(stop).not.toHaveBeenCalled();
    const workspace = mkdtempSync(join(tmpdir(), 'ok-stop-v1-identity-'));
    try {
      const root = join(workspace, 'project');
      const alias = join(workspace, 'alias');
      mkdirSync(join(root, '.ok', 'local'), { recursive: true });
      symlinkSync(root, alias);
      const originalDir = join(root, '.ok', 'local');
      const aliasDir = join(alias, '.ok', 'local');
      const collapsed = await buildStopV1({
        target: '4242',
        force: false,
        projectRoot: root,
        discover: async () => [originalDir, aliasDir],
        inspect: (dir) => alive(dir, 101, 4242),
        confirm: async () => 'same-instance',
        stop,
      });
      expect(collapsed.result.code).toBe('signalled');
      expect(collapsed.targets).toHaveLength(1);
      expect(collapsed.targets[0]?.serverInstanceId).toBe('same-instance');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test('retains duplicate-looking observations after inspection failure', async () => {
    const stop = vi.fn<typeof runStop>();
    const document = await buildStopV1({
      target: '4242',
      force: false,
      projectRoot: '/tmp',
      discover: async () => [first, second],
      inspect: (dir) => alive(dir, 101, 4242),
      confirm: async () => null,
      stop,
    });
    expect(document.result.code).toBe('ambiguous-target');
    expect(stop).not.toHaveBeenCalled();
  });
});
