import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hocuspocus } from '@hocuspocus/server';
import { describe, expect, test } from 'vitest';
import { makeCaptureRes, makeSyntheticReq } from '../composition-rig.test-helper.ts';
import type { ConflictEntry } from '../conflict-storage.ts';
import { DocumentDurabilityState } from '../document-durability-state.ts';
import { loggerFactory } from '../logger.ts';
import type { SyncEngine } from '../sync-engine.ts';
import { createSyncRoutes } from './sync-routes.ts';

function buildGroup() {
  return createSyncRoutes({
    projectDir: undefined,
    contentDir: '/tmp/ok-sync-routes-test',
    getPrincipal: undefined,
    hocuspocus: new Hocuspocus({ quiet: true }),
    durabilityState: new DocumentDurabilityState(),
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

describe('conflict list origins', () => {
  test('labels Git and stale external-write conflicts distinctly', async () => {
    const durabilityState = new DocumentDurabilityState();
    durabilityState.recordStaleExternalWrite('stale', 'old bytes');
    const gitConflicts: ConflictEntry[] = [
      { file: 'git.md', detectedAt: '2026-09-08T10:00:00.000Z' },
    ];
    const engine = { getConflicts: () => gitConflicts } as unknown as SyncEngine;
    const group = createSyncRoutes({
      projectDir: '/tmp/ok-sync-routes-test',
      contentDir: '/tmp/ok-sync-routes-test',
      getPrincipal: undefined,
      hocuspocus: new Hocuspocus({ quiet: true }),
      durabilityState,
      log: loggerFactory.getLogger('test'),
      checkLocalOpSecurity: () => true,
      getSyncEngine: () => engine,
      serializeDoc: undefined,
    });
    const resolved = group.table.resolve('/api/sync/conflicts');
    if (!resolved?.dispatch) throw new Error('no dispatch for /api/sync/conflicts');
    const req = makeSyntheticReq({ url: '/api/sync/conflicts' });
    const { res, captured } = makeCaptureRes();

    await resolved.dispatch(req, res);

    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body)).toEqual({
      conflicts: [
        { file: 'git.md', detectedAt: '2026-09-08T10:00:00.000Z', conflictKind: 'git' },
        {
          file: 'stale.md',
          detectedAt: expect.any(String),
          conflictKind: 'stale-external-write',
        },
      ],
    });
  });

  test('an unrecognized variant degrades that field instead of failing the whole list', async () => {
    const degradedConflicts: ConflictEntry[] = [
      {
        file: 'weird.md',
        detectedAt: '2026-09-08T10:00:00.000Z',
        variant: 'index' as unknown as ConflictEntry['variant'],
      },
      {
        file: 'ok.md',
        detectedAt: '2026-09-08T10:01:00.000Z',
        variant: 'working-tree',
        theirsSha: 'a'.repeat(40),
      },
    ];
    const engine = { getConflicts: () => degradedConflicts } as unknown as SyncEngine;
    const group = createSyncRoutes({
      projectDir: '/tmp/ok-sync-routes-test',
      contentDir: '/tmp/ok-sync-routes-test',
      getPrincipal: undefined,
      hocuspocus: new Hocuspocus({ quiet: true }),
      durabilityState: new DocumentDurabilityState(),
      log: loggerFactory.getLogger('test'),
      checkLocalOpSecurity: () => true,
      getSyncEngine: () => engine,
      serializeDoc: undefined,
    });
    const resolved = group.table.resolve('/api/sync/conflicts');
    if (!resolved?.dispatch) throw new Error('no dispatch for /api/sync/conflicts');
    const { res, captured } = makeCaptureRes();

    await resolved.dispatch(makeSyntheticReq({ url: '/api/sync/conflicts' }), res);

    expect(captured.status).toBe(200);
    expect(JSON.parse(captured.body)).toEqual({
      conflicts: [
        { file: 'weird.md', detectedAt: '2026-09-08T10:00:00.000Z', conflictKind: 'git' },
        {
          file: 'ok.md',
          detectedAt: '2026-09-08T10:01:00.000Z',
          variant: 'working-tree',
          theirsSha: 'a'.repeat(40),
          conflictKind: 'git',
        },
      ],
    });
  });
});

describe('conflict-content working-tree ours-read errno discrimination', () => {
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
      durabilityState: new DocumentDurabilityState(),
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
