import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hocuspocus } from '@hocuspocus/server';
import { LOCAL_DIR } from '@inkeep/open-knowledge-core';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { makeCaptureRes, makeSyntheticReq } from '../composition-rig.test-helper.ts';
import { createTestConflictAuthority } from '../conflict-authority.test-helper.ts';
import type { ConflictAuthority } from '../conflict-authority.ts';
import { createContentFilter } from '../content-filter.ts';
import {
  type AllFileEntries,
  type DiskEvent,
  type FileIndexEntry,
  type FolderIndexEntry,
  startWatcher,
} from '../file-watcher.ts';
import { localTargetInventoryFromWatcher } from '../local-target-inventory.ts';
import { loggerFactory } from '../logger.ts';
import {
  forgetNativeSubscriptions,
  nativeSubscriptionOn,
} from '../parcel-watcher-double.test-helper.ts';
import { createDocumentRoutes, type DocumentRouteDeps } from './document-routes.ts';

vi.mock('@parcel/watcher', async () => {
  const { parcelWatcherModule } = await import('../parcel-watcher-double.test-helper.ts');
  return parcelWatcherModule;
});

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

function buildGroup(
  conflicts: ConflictAuthority,
  hocuspocus: Hocuspocus,
  overrides: Partial<DocumentRouteDeps> = {},
) {
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
    ...overrides,
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

describe('/api/documents?showAll single-flight walk', () => {
  test('a disconnect with no other waiter aborts the shared walk', async () => {
    const started = Promise.withResolvers<AbortSignal>();
    const walk = Promise.withResolvers<{ truncated: boolean }>();
    const resolved = buildGroup(
      createTestConflictAuthority(projectDir),
      new Hocuspocus({ quiet: true }),
      {
        contentFilter: createContentFilter({ projectDir, contentDir: projectDir }),
        walkContentDirForShowAll: ({ signal }) => {
          started.resolve(signal);
          return walk.promise;
        },
      },
    ).table.resolve('/api/documents');
    if (!resolved?.dispatch) throw new Error('no dispatch for /api/documents');
    const req = makeSyntheticReq({ url: '/api/documents?showAll=true' });
    const res = new ServerResponse(req);
    const pending = resolved.dispatch(req, res);

    const signal = await started.promise;
    expect(signal.aborted).toBe(false);
    res.emit('close');
    expect(signal.aborted).toBe(true);

    walk.resolve({ truncated: false });
    await pending;
  });
});

test.each(['repeatable', 'single-pass'] as const)(
  'regular group members and true symlinks survive both listing traversals of a %s inventory',
  async (shape) => {
    const rich = {
      kind: 'file' as const,
      canonicalPath: join(projectDir, 'outside/atlas.csv'),
      inode: 41,
      size: 5,
      modified: '2026-01-01T00:00:00.000Z',
      aliases: ['linked-atlas.csv', 'linked-beacon.csv'],
      fileMembers: {
        regularPaths: ['outside/atlas.csv', 'canonical/beacon.csv'],
        symlinks: [
          { path: 'linked-atlas.csv', targetPath: 'outside/atlas.csv' },
          { path: 'linked-beacon.csv', targetPath: 'canonical/beacon.csv' },
        ],
      },
    };
    const rows = new Map<string, FileIndexEntry>([['outside/atlas.csv', rich]]);
    const allFiles: AllFileEntries = {
      *[Symbol.iterator]() {
        yield* rows;
      },
    };
    const folders = new Map<string, FolderIndexEntry>([
      [
        'canonical',
        {
          size: 0,
          modified: '2026-01-01T00:00:00.000Z',
          canonicalPath: join(projectDir, 'canonical'),
          inode: 42,
        },
      ],
    ]);
    const resolved = buildGroup(
      createTestConflictAuthority(projectDir),
      new Hocuspocus({ quiet: true }),
      {
        getAllFilesIndex: () => (shape === 'repeatable' ? allFiles : rows.entries()),
        getFolderIndex: () => folders,
        getFolderAliasIndex: () => new Map([['mirror', 'canonical']]),
      },
    ).table.resolve('/api/documents');
    if (!resolved?.dispatch) throw new Error('no dispatch for /api/documents');
    const readRows = async (url: string) => {
      const req = makeSyntheticReq({ url });
      const { res, captured } = makeCaptureRes();
      await resolved.dispatch(req, res);
      expect(captured.status).toBe(200);
      return (
        JSON.parse(captured.body) as {
          documents: Array<{
            kind: string;
            docName?: string;
            isSymlink: boolean;
            targetPath: string | null;
          }>;
        }
      ).documents;
    };

    for (const _read of [1, 2]) {
      const all = await readRows('/api/documents');
      expect
        .soft(all.filter((row) => row.kind === 'file' && row.docName === 'outside/atlas.csv'))
        .toEqual([expect.objectContaining({ isSymlink: false, targetPath: null })]);
      expect
        .soft(all.filter((row) => row.kind === 'file' && row.docName === 'canonical/beacon.csv'))
        .toEqual([expect.objectContaining({ isSymlink: false, targetPath: null })]);
      expect
        .soft(all.filter((row) => row.kind === 'file' && row.docName === 'linked-beacon.csv'))
        .toEqual([
          expect.objectContaining({
            isSymlink: true,
            canonicalDocName: 'outside/atlas.csv',
            targetPath: 'canonical/beacon.csv',
          }),
        ]);
      expect
        .soft(all.filter((row) => row.kind === 'file' && row.docName === 'mirror/beacon.csv'))
        .toEqual([
          expect.objectContaining({
            isSymlink: true,
            canonicalDocName: 'outside/atlas.csv',
            targetPath: 'canonical/beacon.csv',
          }),
        ]);

      const onlyCanonical = await readRows('/api/documents?dir=canonical');
      expect
        .soft(onlyCanonical.filter((row) => row.kind === 'file').map((row) => row.docName))
        .toEqual(['canonical/beacon.csv']);
      const onlyMirror = await readRows('/api/documents?dir=mirror');
      expect
        .soft(onlyMirror.filter((row) => row.kind === 'file').map((row) => row.docName))
        .toEqual(['mirror/beacon.csv']);
    }
  },
);

test('a folder alias lists a contained legacy file alias', async () => {
  const canonicalDir = join(projectDir, 'canonical');
  mkdirSync(canonicalDir);
  const target = join(canonicalDir, 'data.csv');
  writeFileSync(target, 'canonical,bytes\n');
  const alias = join(canonicalDir, 'y.csv');
  symlinkSync(target, alias);
  const mirror = join(projectDir, 'mirror');
  symlinkSync(canonicalDir, mirror);
  const targetStat = statSync(target);
  const folderStat = statSync(canonicalDir);
  const entry: FileIndexEntry = {
    kind: 'file',
    canonicalPath: target,
    inode: targetStat.ino,
    size: targetStat.size,
    modified: targetStat.mtime.toISOString(),
    aliases: ['canonical/y.csv'],
  };
  const allFiles = new Map<string, FileIndexEntry>([['canonical/data.csv', entry]]);
  const folders = new Map<string, FolderIndexEntry>([
    [
      'canonical',
      {
        size: 0,
        modified: folderStat.mtime.toISOString(),
        canonicalPath: canonicalDir,
        inode: folderStat.ino,
      },
    ],
  ]);
  const resolved = buildGroup(
    createTestConflictAuthority(projectDir),
    new Hocuspocus({ quiet: true }),
    {
      getAllFilesIndex: () => allFiles,
      getFolderIndex: () => folders,
      getFolderAliasIndex: () => new Map([['mirror', 'canonical']]),
    },
  ).table.resolve('/api/documents');
  if (!resolved?.dispatch) throw new Error('no dispatch for /api/documents');
  const readRows = async (url: string) => {
    const req = makeSyntheticReq({ url });
    const { res, captured } = makeCaptureRes();
    await resolved.dispatch(req, res);
    expect(captured.status).toBe(200);
    return (
      JSON.parse(captured.body) as {
        documents: Array<{
          kind: string;
          docName?: string;
          path?: string;
          size?: number;
          modified?: string;
          isSymlink: boolean;
          canonicalDocName?: string | null;
          targetPath: string | null;
        }>;
      }
    ).documents;
  };

  const all = await readRows('/api/documents');
  const onlyMirror = await readRows('/api/documents?dir=mirror');
  expect(all.filter((row) => row.kind === 'file' && row.docName === 'canonical/y.csv')).toEqual([
    expect.objectContaining({
      path: 'canonical/y.csv',
      size: targetStat.size,
      modified: targetStat.mtime.toISOString(),
      isSymlink: true,
      canonicalDocName: 'canonical/data.csv',
      targetPath: 'canonical/data.csv',
    }),
  ]);
  for (const rows of [all, onlyMirror]) {
    expect(rows.filter((row) => row.kind === 'file' && row.docName === 'mirror/data.csv')).toEqual([
      expect.objectContaining({
        path: 'mirror/data.csv',
        size: targetStat.size,
        modified: targetStat.mtime.toISOString(),
        isSymlink: true,
        canonicalDocName: 'canonical/data.csv',
        targetPath: 'canonical/data.csv',
      }),
    ]);
    expect
      .soft(rows.filter((row) => row.kind === 'file' && row.docName === 'mirror/y.csv'))
      .toEqual([
        expect.objectContaining({
          path: 'mirror/y.csv',
          size: targetStat.size,
          modified: targetStat.mtime.toISOString(),
          isSymlink: true,
          canonicalDocName: 'canonical/data.csv',
          targetPath: 'canonical/data.csv',
        }),
      ]);
  }
  expect(lstatSync(alias).isSymbolicLink()).toBe(true);
  expect(realpathSync(alias)).toBe(realpathSync(target));
  expect(lstatSync(mirror).isSymbolicLink()).toBe(true);
  expect(realpathSync(mirror)).toBe(realpathSync(canonicalDir));
  expect(lstatSync(target).isFile()).toBe(true);
});

test('a public recovery creation preserves its literal folder alias and one listed row', async () => {
  const root = realpathSync(projectDir);
  const real = join(root, 'real.md');
  mkdirSync(real);
  const known = join(real, 'known.csv');
  writeFileSync(known, 'known,bytes\n');
  const first = join(root, 'first.md');
  writeFileSync(first, '# First\n');
  const linked = join(root, 'linked.mdx');
  const created = join(real, 'created.csv');
  const events: DiskEvent[] = [];
  let creations = 0;
  forgetNativeSubscriptions();
  const watcher = await startWatcher(
    root,
    async (event) => {
      events.push(event);
      if (event.kind !== 'delete' || event.docName !== 'first') return;
      symlinkSync(real, linked);
      writeFileSync(join(linked, 'created.csv'), 'public,bytes\n');
      const stat = statSync(created);
      watcher.mutateFileIndex({
        kind: 'file-create',
        path: created,
        relativePath: 'linked.mdx/created.csv',
        size: stat.size,
        modifiedTs: stat.mtimeMs,
        inode: Number(stat.ino),
      });
      creations++;
      expect(
        localTargetInventoryFromWatcher(watcher, root)?.fileTargets.includes('real.md/known.csv'),
      ).toBe(true);
    },
    undefined,
    { forceBackend: 'parcel', platform: 'darwin' },
  );
  const hocuspocus = new Hocuspocus({ quiet: true });
  try {
    expect(watcher.getFolderIndex().has('real.md')).toBe(true);
    expect(watcher.getFolderAliasIndex().size).toBe(0);
    unlinkSync(first);
    await nativeSubscriptionOn(root).deliver(
      [],
      new Error('Events were dropped by the FSEvents client. File system must be re-scanned.'),
    );
    expect(creations).toBe(1);
    expect(events).toContainEqual({ kind: 'delete', path: first, docName: 'first' });
    expect.soft([...watcher.getFolderAliasIndex()]).toEqual([['linked.mdx', 'real.md']]);
    expect
      .soft(
        localTargetInventoryFromWatcher(watcher, root)?.fileTargets.includes(
          'linked.mdx/known.csv',
        ),
      )
      .toBe(true);
    const resolved = buildGroup(createTestConflictAuthority(root), hocuspocus, {
      contentDir: root,
      getFileIndex: () => watcher.getFileIndex(),
      getFileIndexGeneration: () => watcher.getFileIndexGeneration(),
      getAllFilesIndex: () => watcher.getAllFilesIndex(),
      getFolderIndex: () => watcher.getFolderIndex(),
      getFolderAliasIndex: () => watcher.getFolderAliasIndex(),
    }).table.resolve('/api/documents');
    if (!resolved?.dispatch) throw new Error('no dispatch for /api/documents');
    for (const url of ['/api/documents', '/api/documents?dir=linked.mdx']) {
      const req = makeSyntheticReq({ url });
      const { res, captured } = makeCaptureRes();
      await resolved.dispatch(req, res);
      expect(captured.status).toBe(200);
      const rows = (
        JSON.parse(captured.body) as { documents: Array<{ kind: string; path?: string }> }
      ).documents;
      expect
        .soft(rows.filter((row) => row.kind === 'folder' && row.path === 'linked.mdx'))
        .toEqual([
          expect.objectContaining({
            isSymlink: true,
            canonicalDocName: 'real.md',
            targetPath: 'real.md',
          }),
        ]);
    }
    expect(lstatSync(real).isDirectory()).toBe(true);
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
    expect(realpathSync(linked)).toBe(real);
    expect(readFileSync(known, 'utf8')).toBe('known,bytes\n');
    expect(readFileSync(created, 'utf8')).toBe('public,bytes\n');
  } finally {
    await watcher.unsubscribe();
    expect(nativeSubscriptionOn(root).nativeReleases()).toBe(1);
  }
});
