import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { makeCaptureRes, makeSyntheticReq } from '../composition-rig.test-helper.ts';
import { loggerFactory } from '../logger.ts';
import { useIsolatedHome } from '../share/git-host-declarations.test-helper.ts';
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
  const home = useIsolatedHome();

  test('keeps declared hosts for its lifetime and accepts an injected boot snapshot', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'ok-share-host-snapshot-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: projectDir });
    try {
      git('init', '--initial-branch=main');
      git('remote', 'add', 'origin', 'https://ghes.example.com/team/kb.git');
      mkdirSync(join(home(), '.ok'));
      const config = join(home(), '.ok', 'global.yml');
      writeFileSync(config, 'git:\n  hosts:\n    ghes.example.com:\n      provider: github\n');
      const initial = buildGroup({ projectDir });
      const refused = buildGroup({ projectDir, declaredGitHubHosts: new Set() });
      writeFileSync(config, 'git:\n  hosts: {}\n');
      const restarted = buildGroup({ projectDir });
      for (const [group, expected] of [
        [initial, 'branch-not-on-origin'],
        [refused, 'non-github-remote'],
        [restarted, 'non-github-remote'],
      ] as const) {
        const req = Readable.from([
          Buffer.from(JSON.stringify({ kind: 'doc', docPath: 'README.md' })),
        ]) as IncomingMessage;
        req.method = 'POST';
        req.url = '/api/share/construct-url';
        const { res, captured } = makeCaptureRes();
        const route = group.table.resolve(req.url);
        if (!route?.dispatch) throw new Error('missing construct-url handler');
        await route.dispatch(req, res);
        expect(captured.status).toBe(200);
        expect(JSON.parse(captured.body)).toMatchObject({ ok: false, error: expected });
      }
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
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
