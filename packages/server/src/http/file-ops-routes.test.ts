import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { Hocuspocus } from '@hocuspocus/server';
import { describe, expect, test } from 'vitest';
import { SymlinkEscapeError } from '../apply-managed-rename.ts';
import { DocInConflictError } from '../conflict-errors.ts';
import { ContentRootUnavailableError } from '../fs-safety.ts';
import { loggerFactory } from '../logger.ts';
import type { AssetService } from '../services/assets.ts';
import type { FileOpsService } from '../services/file-ops.ts';
import { createFileOpsRoutes } from './file-ops-routes.ts';

type Deps = Parameters<typeof createFileOpsRoutes>[0];

function buildGroup(overrides: Partial<Deps> = {}) {
  return createFileOpsRoutes({
    contentDir: '/nonexistent-content',
    projectDir: undefined,
    log: loggerFactory.getLogger('test'),
    getPrincipal: undefined,
    contentFilter: undefined,
    signalChannel: undefined,
    getSyncEngine: undefined,
    flushContributors: undefined,
    hocuspocus: {} as Hocuspocus,
    fileOpsService: {} as FileOpsService,
    assetService: {} as AssetService,
    extractAgentIdentity: () => {
      throw new Error('not dispatched');
    },
    recordDerivedDocumentBestEffort: () => Promise.resolve(),
    invalidateReferencedAssetsCache: () => {},
    listManagedDocNamesUnderFolderFromDisk: () => [],
    resolveContentEntryPath: () => {
      throw new Error('not dispatched');
    },
    docNameForFileOperationPath: () => {
      throw new Error('not dispatched');
    },
    withPeriod: (s) => s,
    toManagedRenamePublicError: () => {
      throw new Error('not dispatched');
    },
    attributeRenameWriteToActor: () => undefined,
    renameAttributionCounter: () => {
      throw new Error('not dispatched');
    },
    _performAssetRename: () => Promise.reject(new Error('not dispatched')),
    _performDocumentToFileRename: () => Promise.reject(new Error('not dispatched')),
    _performManagedRenameForDocs: () => Promise.reject(new Error('not dispatched')),
    isValidRelativeContentPath: () => false,
    ...overrides,
  });
}

function makeReq(url: string, body: unknown): IncomingMessage {
  const readable = Readable.from(Buffer.from(JSON.stringify(body))) as unknown as IncomingMessage;
  readable.method = 'POST';
  readable.url = url;
  readable.headers = { host: 'localhost', 'content-type': 'application/json' };
  return readable;
}

function makeRes(): { res: ServerResponse; captured: { status: number; body: string } } {
  const captured = { status: 0, body: '' };
  const res = {
    writeHead(status: number) {
      captured.status = status;
    },
    end(body?: string) {
      captured.body = body ?? '';
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

const FAMILY_PATHS = [
  '/api/create-page',
  '/api/create-folder',
  '/api/duplicate-path',
  '/api/rename-path',
  '/api/delete-path',
  '/api/trash/cleanup',
  '/api/upload',
];

describe('createFileOpsRoutes table', () => {
  test('registers exactly the seven file-ops paths', () => {
    expect([...buildGroup().paths].sort()).toEqual([...FAMILY_PATHS].sort());
  });

  test('every path in the family is mutating (whole-family legacy MUTATING_ROUTES membership)', () => {
    const { table } = buildGroup();
    for (const path of FAMILY_PATHS) {
      expect(table.isMutating(path), path).toBe(true);
    }
  });
});

describe('rename-path conflict envelope', () => {
  test('maps a DocInConflictError from the rewrite spine to a 409 doc-in-conflict', async () => {
    const group = buildGroup({
      hocuspocus: { documents: new Map() } as unknown as Hocuspocus,
      docNameForFileOperationPath: () => 'a',
      isValidRelativeContentPath: () => true,
      _performManagedRenameForDocs: () =>
        Promise.reject(new DocInConflictError({ file: 'referrer.md' })),
    });
    const resolved = group.table.resolve('/api/rename-path');
    if (!resolved?.dispatch) throw new Error('rename-path did not resolve to a dispatch handler');
    const { res, captured } = makeRes();
    await resolved.dispatch(
      makeReq('/api/rename-path', { kind: 'file', fromPath: 'a', toPath: 'b' }),
      res,
    );
    expect(captured.status).toBe(409);
    expect((JSON.parse(captured.body) as { type?: string }).type).toBe(
      'urn:ok:error:doc-in-conflict',
    );
  });
});

describe('create-page path-resolution error classification', () => {
  async function dispatchCreatePage(resolveContentEntryPath: () => never) {
    const group = buildGroup({ resolveContentEntryPath });
    const resolved = group.table.resolve('/api/create-page');
    if (!resolved?.dispatch) throw new Error('create-page did not resolve to a dispatch handler');
    const { res, captured } = makeRes();
    await resolved.dispatch(makeReq('/api/create-page', { path: 'notes/x.md' }), res);
    return captured;
  }

  test('a SymlinkEscapeError maps to a 400 path-escape', async () => {
    const captured = await dispatchCreatePage(() => {
      throw new SymlinkEscapeError('path resolves outside content directory');
    });
    expect(captured.status).toBe(400);
    expect((JSON.parse(captured.body) as { type?: string }).type).toBe('urn:ok:error:path-escape');
  });

  test('a ContentRootUnavailableError surfaces as a 500, not a 400', async () => {
    const captured = await dispatchCreatePage(() => {
      throw new ContentRootUnavailableError('content directory does not exist');
    });
    expect(captured.status).toBe(500);
    expect((JSON.parse(captured.body) as { type?: string }).type).toBe(
      'urn:ok:error:internal-server-error',
    );
  });

  test('a raw realpath errno surfaces as a 500, not a 400', async () => {
    const captured = await dispatchCreatePage(() => {
      const err = new Error('EACCES: permission denied, stat') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    });
    expect(captured.status).toBe(500);
    expect((JSON.parse(captured.body) as { type?: string }).type).toBe(
      'urn:ok:error:internal-server-error',
    );
  });
});
