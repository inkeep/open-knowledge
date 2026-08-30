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

/**
 * Table-level pins for the file-ops group's mutating declaration. The wire
 * cannot pin this: the read half of the DNS-rebinding defense applies the
 * identical loopback + workspace-Host checks to every `/api/*` request, so an
 * emptied mutating set changes no composition-suite response — only which
 * gate (and telemetry tag) fires first. The declared membership is pinned
 * here directly against the legacy `MUTATING_ROUTES` membership it
 * reproduces: every path in this family mutated, so every path is declared.
 */

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
    // Never dispatched by these pins; the table declaration is what's under
    // test, and constructing the group must not touch any of these.
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
  // When the managed-rename spine throws `DocInConflictError`, the rename-path
  // branch must return the documented 409 doc-in-conflict envelope rather than
  // fall through `toManagedRenamePublicError` to a generic 500. Injecting a
  // throwing spine pins that catch directly.
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
  // The create-page containment catch discriminates the WIDER throw set of
  // `resolveContentEntryPath`: a client-side containment rejection (grouped by
  // `isContainmentRejection` — the lexical `PathContainmentError` or the
  // realpath `SymlinkEscapeError`) is a 400 path-escape, but a raw realpath
  // errno that `assertNoSymlinkEscape` rethrows by contract must reach the
  // handler's outer catch as a 500 — never be flattened into a client 400.
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
    // The missing-anchor condition is a server fault (dir deleted under a
    // running server); `isContainmentRejection` excludes it, so it must reach
    // the outer catch, never be flattened into the caller's path-escape.
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
