import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hocuspocus } from '@hocuspocus/server';
import { describe, expect, test } from 'vitest';
import { makeCaptureRes, makeSyntheticReq } from '../composition-rig.test-helper.ts';
import { loggerFactory } from '../logger.ts';
import type { SyncEngine } from '../sync-engine.ts';
import { createSyncRoutes } from './sync-routes.ts';

/**
 * Table-level pins for the sync group's mutating declaration. The wire cannot
 * pin this: the read half of the DNS-rebinding defense applies the identical
 * loopback + workspace-Host checks to every `/api/*` request, so an emptied
 * mutating set changes no composition-suite response — only which gate (and
 * telemetry tag) fires first. The declared membership is pinned here directly
 * against the legacy `MUTATING_ROUTES` membership it reproduces.
 *
 * Also pinned here (handler tier, synthetic dispatch): conflict-content's
 * working-tree `ours`-read errno discrimination — only a genuine ENOENT may
 * classify as the delete overlay; any other read failure must surface as a
 * 500, never as a silent `delete-modify` the UI resolves with `git rm`.
 */

function buildGroup() {
  return createSyncRoutes({
    projectDir: undefined,
    contentDir: '/tmp/ok-sync-routes-test',
    getPrincipal: undefined,
    hocuspocus: new Hocuspocus({ quiet: true }),
    log: loggerFactory.getLogger('test'),
    checkLocalOpSecurity: () => true,
    getSyncEngine: undefined,
    serializeDoc: undefined,
  });
}

describe('createSyncRoutes table', () => {
  test('registers exactly the six sync paths', () => {
    expect([...buildGroup().paths].sort()).toEqual(
      [
        '/api/sync/status',
        '/api/sync/trigger',
        '/api/sync/conflicts',
        '/api/sync/conflict-content',
        '/api/sync/resolve-conflict',
        '/api/sync/resolve-blocking',
      ].sort(),
    );
  });

  test('the trigger/resolve trio is mutating; the three reads are not', () => {
    const { table } = buildGroup();
    for (const path of [
      '/api/sync/trigger',
      '/api/sync/resolve-conflict',
      '/api/sync/resolve-blocking',
    ]) {
      expect(table.isMutating(path), path).toBe(true);
    }
    for (const path of ['/api/sync/status', '/api/sync/conflicts', '/api/sync/conflict-content']) {
      expect(table.isMutating(path), path).toBe(false);
    }
  });
});

describe('conflict-content working-tree ours-read errno discrimination', () => {
  // A working-tree-variant conflict with no pinned shas: `readBlob`
  // short-circuits on the undefined shas, so the handler reaches the
  // `ours` disk read without any git subprocess.
  function buildConflictGroup(projectDir: string) {
    const engine = {
      getConflicts: () => [
        { file: 'a.md', variant: 'working-tree', theirsSha: undefined, baseSha: undefined },
      ],
    } as unknown as SyncEngine;
    return createSyncRoutes({
      projectDir,
      contentDir: '/tmp/ok-sync-routes-test',
      getPrincipal: undefined,
      hocuspocus: new Hocuspocus({ quiet: true }),
      log: loggerFactory.getLogger('test'),
      checkLocalOpSecurity: () => true,
      getSyncEngine: () => engine,
      serializeDoc: undefined,
    });
  }

  async function dispatchConflictContent(
    projectDir: string,
  ): Promise<{ status: number; body: string }> {
    const resolved = buildConflictGroup(projectDir).table.resolve('/api/sync/conflict-content');
    if (!resolved?.dispatch) throw new Error('no dispatch for /api/sync/conflict-content');
    const req = makeSyntheticReq({ url: '/api/sync/conflict-content?file=a.md' });
    const { res, captured } = makeCaptureRes();
    await resolved.dispatch(req, res);
    return captured;
  }

  test('a genuinely absent working-tree file is the delete overlay (200 delete-modify)', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'sync-cc-enoent-'));
    try {
      const captured = await dispatchConflictContent(projectDir);
      expect(captured.status).toBe(200);
      expect((JSON.parse(captured.body) as { kind?: string }).kind).toBe('delete-modify');
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test('a non-ENOENT ours-read failure is a 500, never a silent delete-modify', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'sync-cc-eisdir-'));
    try {
      // A DIRECTORY at the conflicted path makes readFileSync throw EISDIR —
      // a portable stand-in for EACCES/EIO (no chmod/root dependency). Before
      // the errno discrimination this was swallowed into `oursPresent = false`
      // → 200 `delete-modify` → the UI offers `git rm` on the user's own doc.
      mkdirSync(join(projectDir, 'a.md'));
      const captured = await dispatchConflictContent(projectDir);
      expect(captured.status).toBe(500);
      expect((JSON.parse(captured.body) as { type?: string }).type).toBe(
        'urn:ok:error:internal-server-error',
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
