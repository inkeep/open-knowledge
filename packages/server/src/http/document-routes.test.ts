import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hocuspocus } from '@hocuspocus/server';
import { LOCAL_DIR } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { makeCaptureRes, makeSyntheticReq } from '../composition-rig.test-helper.ts';
import { createTestConflictAuthority } from '../conflict-authority.test-helper.ts';
import type { ConflictAuthority } from '../conflict-authority.ts';
import { loggerFactory } from '../logger.ts';
import { createDocumentRoutes } from './document-routes.ts';

const DOC_NAME = 'notes/topic';
const DOC_FILE = 'notes/topic.md';

let projectDir = '';

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'document-routes-test-'));
  mkdirSync(join(projectDir, '.ok', LOCAL_DIR), { recursive: true });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function buildGroup(conflicts: ConflictAuthority, hocuspocus: Hocuspocus) {
  return createDocumentRoutes({
    hocuspocus,
    conflicts,
    contentDir: projectDir,
    isSafeDocName: () => true,
    resolveAlias: (docName) => docName,
    resolveContentEntryPath: (dir, _kind, path) => join(dir, `${path}.md`),
    resolveDocPath: () => null,
    extractHeadings: () => [],
    getFileIndex: () => new Map(),
    log: loggerFactory.getLogger('test'),
    ready: undefined,
    contentFilter: undefined,
    safeSubdir: (baseDir) => baseDir,
    getShowAllMaxEntries: () => 0,
    streamShowAllEntries: async function* () {
      yield* [];
      return { truncated: false };
    },
    walkContentDirForShowAll: async () => ({ truncated: false }),
    synthesizeShowAllAssetExt: (name) => name,
    getAllFilesIndex: () => new Map(),
    getFolderIndex: undefined,
    getFolderAliasIndex: undefined,
    onReferencedAssetsCacheInvalidator: undefined,
  });
}

async function readDocument(
  conflicts: ConflictAuthority,
  hocuspocus: Hocuspocus,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const resolved = buildGroup(conflicts, hocuspocus).table.resolve('/api/document');
  if (!resolved?.dispatch) throw new Error('no dispatch for /api/document');
  const req = makeSyntheticReq({ url: `/api/document?docName=${encodeURIComponent(DOC_NAME)}` });
  const { res, captured } = makeCaptureRes();
  await resolved.dispatch(req, res);
  return { status: captured.status, body: JSON.parse(captured.body) as Record<string, unknown> };
}

describe('/api/document lifecycle reflects the conflict ledger', () => {
  test('a doc with a reconcile ledger entry reports lifecycle conflict with its reason', async () => {
    const hocuspocus = new Hocuspocus({ quiet: true });
    const conflicts = createTestConflictAuthority(projectDir);
    conflicts.raise({
      kind: 'reconcile',
      file: DOC_FILE,
      reason: 'disk-markers',
      stages: { base: 'BASE\n', ours: 'OURS\n', theirs: 'THEIRS\n' },
    });

    const dc = await hocuspocus.openDirectConnection(DOC_NAME);
    try {
      const { status, body } = await readDocument(conflicts, hocuspocus);
      expect(status).toBe(200);
      expect(body.lifecycle).toEqual({ status: 'conflict', reason: 'disk-markers' });
    } finally {
      await dc.disconnect();
    }
  });

  test('a doc with a merge-native ledger entry reports the merge-conflict reason', async () => {
    const hocuspocus = new Hocuspocus({ quiet: true });
    const conflicts = createTestConflictAuthority(projectDir);
    conflicts.raise({ kind: 'merge-native', file: DOC_FILE });

    const dc = await hocuspocus.openDirectConnection(DOC_NAME);
    try {
      const { status, body } = await readDocument(conflicts, hocuspocus);
      expect(status).toBe(200);
      expect(body.lifecycle).toEqual({ status: 'conflict', reason: 'merge-conflict' });
    } finally {
      await dc.disconnect();
    }
  });

  test('a doc with no ledger entry reports a null lifecycle', async () => {
    const hocuspocus = new Hocuspocus({ quiet: true });
    const conflicts = createTestConflictAuthority(projectDir);

    const dc = await hocuspocus.openDirectConnection(DOC_NAME);
    try {
      const { status, body } = await readDocument(conflicts, hocuspocus);
      expect(status).toBe(200);
      expect(body.lifecycle).toBeNull();
    } finally {
      await dc.disconnect();
    }
  });
});
