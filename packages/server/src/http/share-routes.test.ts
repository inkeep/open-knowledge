import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { makeCaptureRes, makeSyntheticReq } from '../composition-rig.test-helper.ts';
import { loggerFactory } from '../logger.ts';
import { SHARE_PUBLISH_TIMEOUT_MS } from '../share/publish.ts';
import { createShareRoutes, type ShareRouteDeps } from './share-routes.ts';

function buildGroup(overrides: Partial<ShareRouteDeps> = {}) {
  return createShareRoutes({
    projectDir: undefined,
    contentDir: '/nonexistent-content',
    log: loggerFactory.getLogger('test'),
    checkLocalOpSecurity: () => true,
    localOpCliArgs: ['open-knowledge'],
    localOpGuard: { tryAcquire: () => true, release: () => {} },
    getSyncEngine: undefined,
    toGitRelativePath: () => null,
    ...overrides,
  });
}

describe('createShareRoutes table', () => {
  test('registers exactly the five share paths', () => {
    expect([...buildGroup().paths].sort()).toEqual(
      [
        '/api/share/construct-url',
        '/api/share/target-status',
        '/api/share/publish/owners',
        '/api/share/publish/name-check',
        '/api/share/publish',
      ].sort(),
    );
  });

  test('no share path is mutating — share/publish included, matching the legacy set', () => {
    const { table } = buildGroup();
    for (const path of [
      '/api/share/construct-url',
      '/api/share/target-status',
      '/api/share/publish/owners',
      '/api/share/publish/name-check',
      '/api/share/publish',
    ]) {
      expect(table.isMutating(path), path).toBe(false);
    }
  });
});

describe('spawnShareSubprocess timeout settlement', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('a SIGTERM-trapping, never-exiting subprocess times out to a 500 and releases the guard slot', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const readyPath = join(tmpdir(), `ok-share-latch-ready-${randomUUID()}`);
    const acquired: string[] = [];
    const released: string[] = [];
    const group = buildGroup({
      localOpCliArgs: [
        process.execPath,
        '-e',
        `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(
          readyPath,
        )}, 'x'); setInterval(() => {}, 1000);`,
      ],
      localOpGuard: {
        tryAcquire: (key: string) => {
          acquired.push(key);
          return true;
        },
        release: (key: string) => {
          released.push(key);
        },
      },
    });
    try {
      const resolved = group.table.resolve('/api/share/publish/owners');
      if (!resolved?.dispatch) throw new Error('no dispatch for /api/share/publish/owners');
      const req = makeSyntheticReq({ url: '/api/share/publish/owners', method: 'GET' });
      const { res, captured } = makeCaptureRes();
      const dispatched = resolved.dispatch(req, res);
      while (!existsSync(readyPath)) {
        await new Promise((r) => setImmediate(r));
      }
      expect(released).toEqual([]);
      await vi.advanceTimersByTimeAsync(SHARE_PUBLISH_TIMEOUT_MS + 1);
      await dispatched;
      expect(captured.status).toBe(500);
      expect(acquired).toEqual(['/api/share/publish/owners']);
      expect(released).toEqual(['/api/share/publish/owners']);
    } finally {
      rmSync(readyPath, { force: true });
    }
  });
});
