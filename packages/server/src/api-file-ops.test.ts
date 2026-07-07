import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { Hocuspocus } from '@hocuspocus/server';
import simpleGit from 'simple-git';
import type * as Y from 'yjs';
import { createApiExtension } from './api-extension.ts';
import { BacklinkIndex } from './backlink-index.ts';
import { type ContentFilter, createContentFilter } from './content-filter.ts';
import { _resetDocExtensionsForTests, getDocExtension } from './doc-extensions.ts';
import type { FileIndexEntry, FolderIndexEntry } from './file-watcher.ts';

function makeReq(url: string, method: string, body: unknown): IncomingMessage {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const readable = Readable.from(Buffer.from(raw)) as unknown as IncomingMessage;
  readable.method = method;
  readable.url = url;
  readable.headers = { host: 'localhost' };
  return readable;
}

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function makeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, headers: {}, body: '' };
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      if (headers) Object.assign(captured.headers, headers);
    },
    end(body?: string) {
      captured.body = body ?? '';
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

function buildFileIndex(contentDir: string): ReadonlyMap<string, FileIndexEntry> {
  const index = new Map<string, FileIndexEntry>();

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

      const stat = statSync(fullPath);
      const docName = fullPath.slice(contentDir.length + 1).replace(/\.md$/, '');
      index.set(docName, {
        size: stat.size,
        modified: stat.mtime.toISOString(),
        canonicalPath: fullPath,
        inode: stat.ino,
        aliases: [],
      });
    }
  }

  walk(contentDir);
  return index;
}

function buildFolderIndex(contentDir: string): ReadonlyMap<string, FolderIndexEntry> {
  const index = new Map<string, FolderIndexEntry>();

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const fullPath = resolve(dir, entry.name);
      const stat = statSync(fullPath);
      const folderPath = fullPath.slice(contentDir.length + 1);
      index.set(folderPath, {
        size: 0,
        modified: stat.mtime.toISOString(),
        canonicalPath: fullPath,
        inode: stat.ino,
      });
      walk(fullPath);
    }
  }

  walk(contentDir);
  return index;
}

async function buildBacklinkIndex(contentDir: string): Promise<BacklinkIndex> {
  const index = new BacklinkIndex({
    projectDir: contentDir,
    contentDir,
  });
  await index.rebuildFromDisk();
  return index;
}

type CallApiOptions = {
  backlinkIndex?: BacklinkIndex | Promise<BacklinkIndex> | null;
  hocuspocus?: Parameters<typeof createApiExtension>[0]['hocuspocus'];
  sessionManager?: Parameters<typeof createApiExtension>[0]['sessionManager'];
  getFileIndex?: () => ReadonlyMap<string, FileIndexEntry>;
  getFolderIndex?: () => ReadonlyMap<string, FolderIndexEntry>;
  onReferencedAssetsCacheInvalidator?: Parameters<
    typeof createApiExtension
  >[0]['onReferencedAssetsCacheInvalidator'];
  signalChannel?: Parameters<typeof createApiExtension>[0]['signalChannel'];
  projectDir?: string;
  contentFilter?: ContentFilter;
};

async function createTestApiExtension(contentDir: string, options?: CallApiOptions) {
  const resolvedBacklinkIndex =
    options && Object.hasOwn(options, 'backlinkIndex')
      ? await (options.backlinkIndex ?? undefined)
      : await buildBacklinkIndex(contentDir);
  return createApiExtension({
    hocuspocus:
      options?.hocuspocus ??
      ({
        documents: new Map(),
        closeConnections() {},
        unloadDocument: async () => {},
      } as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus']),
    sessionManager:
      options?.sessionManager ??
      ({
        closeSession: async () => {},
        closeAllForDoc: async () => {},
      } as unknown as Parameters<typeof createApiExtension>[0]['sessionManager']),
    contentDir,
    getFileIndex: options?.getFileIndex ?? (() => buildFileIndex(contentDir)),
    getFolderIndex: options?.getFolderIndex ?? (() => buildFolderIndex(contentDir)),
    onReferencedAssetsCacheInvalidator: options?.onReferencedAssetsCacheInvalidator,
    backlinkIndex: resolvedBacklinkIndex,
    signalChannel: options?.signalChannel,
    projectDir: options?.projectDir,
    contentFilter: options?.contentFilter,
  });
}

async function callApiExtension(
  ext: Awaited<ReturnType<typeof createTestApiExtension>>,
  url: string,
  method: string,
  body: unknown,
): Promise<CapturedResponse> {
  const req = makeReq(url, method, body);
  const { res, captured } = makeRes();
  await (
    ext as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request: req, response: res });
  return captured;
}

async function callApi(
  contentDir: string,
  url: string,
  method: string,
  body: unknown,
  options?: CallApiOptions,
): Promise<CapturedResponse> {
  const ext = await createTestApiExtension(contentDir, options);
  return callApiExtension(ext, url, method, body);
}

function assetPathsFromDocumentList(response: CapturedResponse): string[] {
  const body = JSON.parse(response.body) as {
    documents: Array<{ kind: string; path?: string }>;
  };
  return body.documents
    .filter((entry) => entry.kind === 'asset')
    .map((entry) => entry.path)
    .filter((path): path is string => typeof path === 'string');
}

let tmpDir: string;

function setupTmpDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'ok-file-ops-'));
  return tmpDir;
}

afterEach(() => {
  _resetDocExtensionsForTests();
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('file operation API routes', () => {
  test('managed rename rewrites inbound wiki-links and markdown links', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(join(dir, 'notes.md'), '# Notes\n', 'utf-8');
    writeFileSync(
      join(dir, 'journal.md'),
      '# Journal\n\nSee [[notes]] and [Notes](./notes.md).\n',
      'utf-8',
    );
    writeFileSync(
      join(dir, 'nested/child.md'),
      '# Child\n\nJump to [Notes](../notes.md#intro "Section").\n',
      'utf-8',
    );

    const result = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      {
        kind: 'file',
        fromPath: 'notes',
        toPath: 'renamed-notes',
      },
      { backlinkIndex: buildBacklinkIndex(dir) },
    );

    expect(result.status).toBe(200);
    expect(existsSync(join(dir, 'notes.md'))).toBe(false);
    expect(readFileSync(join(dir, 'renamed-notes.md'), 'utf-8')).toBe('# Notes\n');
    expect(readFileSync(join(dir, 'journal.md'), 'utf-8')).toBe(
      '# Journal\n\nSee [[renamed-notes]] and [Notes](./renamed-notes.md).\n',
    );
    expect(readFileSync(join(dir, 'nested/child.md'), 'utf-8')).toBe(
      '# Child\n\nJump to [Notes](../renamed-notes.md#intro "Section").\n',
    );

    const body = JSON.parse(result.body) as {
      ok: boolean;
      renamed: Array<{ fromDocName: string; toDocName: string }>;
      rewrittenDocs: Array<{ docName: string; rewrites: number }>;
    };
    expect(body.ok).toBeUndefined();
    expect(body.renamed).toEqual([{ fromDocName: 'notes', toDocName: 'renamed-notes' }]);
    expect(body.rewrittenDocs).toEqual([
      { docName: 'journal', rewrites: 2 },
      { docName: 'nested/child', rewrites: 1 },
    ]);
  });

  test('managed rename updates an already-loaded referring document', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'notes.md'), '# Notes\n', 'utf-8');
    writeFileSync(join(dir, 'journal.md'), '# Journal\n\nSee [[notes]].\n', 'utf-8');

    const hocuspocus = new Hocuspocus({ quiet: true });
    const conn = await hocuspocus.openDirectConnection('journal');
    const document = (conn as unknown as { document: Y.Doc }).document;
    const ytext = document.getText('source');
    document.transact(() => {
      ytext.insert(0, '# Journal\n\nSee [[notes]].\n');
    });

    try {
      const result = await callApi(
        dir,
        '/api/rename-path',
        'POST',
        {
          kind: 'file',
          fromPath: 'notes',
          toPath: 'renamed-notes',
        },
        {
          backlinkIndex: buildBacklinkIndex(dir),
          hocuspocus,
        },
      );

      expect(result.status).toBe(200);
      expect(document.getText('source').toString()).toBe('# Journal\n\nSee [[renamed-notes]].\n');
      expect(readFileSync(join(dir, 'journal.md'), 'utf-8')).toBe(
        '# Journal\n\nSee [[renamed-notes]].\n',
      );
    } finally {
      await conn.disconnect();
    }
  });

  test('GET /api/document returns 404 for missing docs (does not create a phantom Y.Doc)', async () => {
    // Repro for the upstream cause of the rename phantom-file bug:
    // `openDirectConnection` on a missing path adds an empty Y.Doc to
    // `Hocuspocus.documents` and (because auto-unload is suppressed) leaves
    // it sitting there. The persistence-layer phantom-doc guard blocks the
    // 0-byte file write, but the lingering in-memory Y.Doc is the
    // precondition for downstream phantom-file creation if anything later
    // populates it with content (rename rewrite spine, mistaken agent
    // write, etc.).
    //
    // Guard: `/api/document` checks the on-disk file BEFORE opening a
    // connection. Missing → 404, no Y.Doc created.
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'real-doc.md'), '# Real\n', 'utf-8');

    const hocuspocus = new Hocuspocus({ quiet: true });

    // Sanity: no in-memory Y.Doc for the missing name before the request.
    expect(hocuspocus.documents.has('nonexistent-doc')).toBe(false);

    const result = await callApi(
      dir,
      '/api/document?docName=nonexistent-doc',
      'GET',
      {},
      { hocuspocus },
    );

    expect(result.status).toBe(404);
    const parsed = JSON.parse(result.body) as Record<string, unknown>;
    expect(parsed.type).toBe('urn:ok:error:doc-not-found');
    expect(parsed.title).toContain('Document not found');
    expect(parsed.title).toContain('nonexistent-doc');

    // Critical: NO empty Y.Doc was materialized in `Hocuspocus.documents`
    // for the missing name. The downstream phantom-file path that depends
    // on a lingering in-memory Y.Doc cannot fire.
    expect(hocuspocus.documents.has('nonexistent-doc')).toBe(false);

    // Sibling positive case: real doc returns 200 (the existsSync gate
    // doesn't block legitimate reads). The bare-hocuspocus harness has
    // no persistence extension wired, so content is not asserted here —
    // the loaded-Y.Doc path is covered by `managed rename updates an
    // already-loaded referring document`.
    const ok = await callApi(dir, '/api/document?docName=real-doc', 'GET', {}, { hocuspocus });
    expect(ok.status).toBe(200);
    expect((JSON.parse(ok.body) as { docName: string }).docName).toBe('real-doc');
  });

  test('rename does NOT materialize a phantom file for an in-memory-only backlink source', async () => {
    // Repro for the user-reported bug: editor pre-warms or hovers over a
    // redlink (`[X](./missing.md)`), which calls `openDirectConnection` and
    // creates an empty Y.Doc for `missing` — but the file itself never
    // existed on disk. If the backlink index nonetheless lists this in-
    // memory-only docName as a backlink source of the rename target, the
    // rewrite spine would feed the Y.Doc through `applyRenameMap` and
    // `writeManagedRenameDocumentToDisk` would `tracedMkdirSync +
    // tracedWriteFileSync` a brand-new file at the docName's path.
    //
    // Guard: the rename spine must require an on-disk file before treating
    // a docName as a legitimate backlink source. In-memory-only Y.Docs
    // get classified as missing and the stale index entry is purged.
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'notes.md'), '# Notes\n', 'utf-8');
    writeFileSync(join(dir, 'journal.md'), '# Journal\n\nSee [[notes]].\n', 'utf-8');

    // Build the backlink index from disk (picks up journal → notes).
    // Then manually inject a backlink edge from a docName that has NO
    // disk file — simulating the in-memory phantom scenario without
    // having to hover-pre-warm in the test.
    const backlinkIndex = await buildBacklinkIndex(dir);
    backlinkIndex.updateDocumentFromMarkdown('phantom-doc', '# Phantom\n\nSee [[notes]].\n');
    expect(
      backlinkIndex.getBacklinks('notes').some((entry) => entry.source === 'phantom-doc'),
    ).toBe(true);

    // Open a real Y.Doc for the phantom name with content matching the
    // injected backlink. This is the state `openDirectConnection` would
    // produce for a redlink the editor pre-warms.
    const hocuspocus = new Hocuspocus({ quiet: true });
    const conn = await hocuspocus.openDirectConnection('phantom-doc');
    const document = (conn as unknown as { document: Y.Doc }).document;
    document.transact(() => {
      document.getText('source').insert(0, '# Phantom\n\nSee [[notes]].\n');
    });

    try {
      const result = await callApi(
        dir,
        '/api/rename-path',
        'POST',
        {
          kind: 'file',
          fromPath: 'notes',
          toPath: 'renamed-notes',
        },
        { backlinkIndex, hocuspocus },
      );

      expect(result.status).toBe(200);

      // The on-disk rename + disk-backed backlink rewrite happen normally.
      expect(existsSync(join(dir, 'renamed-notes.md'))).toBe(true);
      expect(readFileSync(join(dir, 'journal.md'), 'utf-8')).toBe(
        '# Journal\n\nSee [[renamed-notes]].\n',
      );

      // Critical: NO phantom file at `phantom-doc.md`. The in-memory Y.Doc
      // gets classified as missing and skipped — the stale backlink index
      // entry is purged via `deleteDocument`.
      expect(existsSync(join(dir, 'phantom-doc.md'))).toBe(false);

      // The phantom is also removed from the backlink index so future
      // operations don't re-trigger the same path.
      expect(
        backlinkIndex.getBacklinks('renamed-notes').some((entry) => entry.source === 'phantom-doc'),
      ).toBe(false);
    } finally {
      await conn.disconnect();
    }
  });

  test('cross-folder file move rewrites outbound links without duplicating content', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'artists'), { recursive: true });
    writeFileSync(join(dir, 'artists/picasso.md'), '# Picasso\n', 'utf-8');
    const sourceBody = [
      '# Some File',
      '',
      'See [Picasso](./picasso.md) and [[artists/picasso]].',
      '',
      'A second paragraph with [Other](./other.md).',
      '',
      '```md',
      '[Code link](./picasso.md) — should not rewrite',
      '```',
      '',
      'End of file.',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'artists/some-file.md'), sourceBody, 'utf-8');

    const result = await callApi(dir, '/api/rename-path', 'POST', {
      kind: 'file',
      fromPath: 'artists/some-file',
      toPath: 'venues/some-file',
    });

    expect(result.status).toBe(200);
    expect(existsSync(join(dir, 'artists/some-file.md'))).toBe(false);

    const destContent = readFileSync(join(dir, 'venues/some-file.md'), 'utf-8');
    const expectedDest = [
      '# Some File',
      '',
      'See [Picasso](../artists/picasso.md) and [[artists/picasso]].',
      '',
      'A second paragraph with [Other](../artists/other.md).',
      '',
      '```md',
      '[Code link](./picasso.md) — should not rewrite',
      '```',
      '',
      'End of file.',
      '',
    ].join('\n');
    expect(destContent).toBe(expectedDest);

    // Hard duplication guards: a duplicated body would double the byte count
    // and double the count of marker substrings.
    expect(destContent.length).toBe(expectedDest.length);
    expect(destContent.match(/# Some File/g)?.length).toBe(1);
    expect(destContent.match(/End of file\./g)?.length).toBe(1);
    expect(destContent.match(/A second paragraph/g)?.length).toBe(1);
  });

  test('cross-folder file move with frontmatter + image refs does not duplicate content', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs/photo.png'), 'fakebytes', 'utf-8');
    const sourceBody = [
      '---',
      'title: Meeting Notes',
      'date: 2026-04-30',
      '---',
      '',
      '# Meeting Notes',
      '',
      '![photo](./photo.png)',
      '',
      '[See agenda](./agenda.md)',
      '',
      'Closing paragraph.',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'docs/meeting.md'), sourceBody, 'utf-8');

    const result = await callApi(dir, '/api/rename-path', 'POST', {
      kind: 'file',
      fromPath: 'docs/meeting',
      toPath: 'archive/2026/meeting',
    });

    expect(result.status).toBe(200);

    const destContent = readFileSync(join(dir, 'archive/2026/meeting.md'), 'utf-8');
    const expected = [
      '---',
      'title: Meeting Notes',
      'date: 2026-04-30',
      '---',
      '',
      '# Meeting Notes',
      '',
      '![photo](../../docs/photo.png)',
      '',
      '[See agenda](../../docs/agenda.md)',
      '',
      'Closing paragraph.',
      '',
    ].join('\n');
    expect(destContent).toBe(expected);
    expect(destContent.match(/# Meeting Notes/g)?.length).toBe(1);
    expect(destContent.match(/Closing paragraph\./g)?.length).toBe(1);
    expect(destContent.match(/title: Meeting Notes/g)?.length).toBe(1);
  });

  test('cross-folder file move with currently-loaded Y.Doc does not duplicate content', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'artists'), { recursive: true });
    writeFileSync(join(dir, 'artists/picasso.md'), '# Picasso\n', 'utf-8');
    const initialBody = [
      '# Some File',
      '',
      'See [Picasso](./picasso.md).',
      '',
      'Body content.',
      '',
    ].join('\n');
    writeFileSync(join(dir, 'artists/some-file.md'), initialBody, 'utf-8');

    const hocuspocus = new Hocuspocus({ quiet: true });
    const conn = await hocuspocus.openDirectConnection('artists/some-file');
    const document = (conn as unknown as { document: Y.Doc }).document;
    const ytext = document.getText('source');
    document.transact(() => {
      ytext.insert(0, initialBody);
    });

    try {
      const result = await callApi(
        dir,
        '/api/rename-path',
        'POST',
        {
          kind: 'file',
          fromPath: 'artists/some-file',
          toPath: 'venues/some-file',
        },
        {
          backlinkIndex: buildBacklinkIndex(dir),
          hocuspocus,
        },
      );

      expect(result.status).toBe(200);

      const destContent = readFileSync(join(dir, 'venues/some-file.md'), 'utf-8');
      const expected = [
        '# Some File',
        '',
        'See [Picasso](../artists/picasso.md).',
        '',
        'Body content.',
        '',
      ].join('\n');
      expect(destContent).toBe(expected);
      expect(destContent.match(/# Some File/g)?.length).toBe(1);
      expect(destContent.match(/Body content\./g)?.length).toBe(1);
    } finally {
      await conn.disconnect();
    }
  });

  test('managed rename rejects destination collisions without changing files', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'notes.md'), '# Notes\n', 'utf-8');
    writeFileSync(join(dir, 'renamed-notes.md'), '# Existing\n', 'utf-8');
    writeFileSync(join(dir, 'journal.md'), '# Journal\n\nSee [[notes]].\n', 'utf-8');

    const result = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      {
        kind: 'file',
        fromPath: 'notes',
        toPath: 'renamed-notes',
      },
      { backlinkIndex: buildBacklinkIndex(dir) },
    );

    expect(result.status).toBe(409);
    expect(readFileSync(join(dir, 'notes.md'), 'utf-8')).toBe('# Notes\n');
    expect(readFileSync(join(dir, 'renamed-notes.md'), 'utf-8')).toBe('# Existing\n');
    expect(readFileSync(join(dir, 'journal.md'), 'utf-8')).toBe('# Journal\n\nSee [[notes]].\n');

    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body.type).toBe('urn:ok:error:doc-already-exists');
    expect(body.title).toContain('Destination already exists');
  });

  test('managed rename returns no-op success when source and destination match', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'notes.md'), '# Notes\n', 'utf-8');

    const result = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      {
        kind: 'file',
        fromPath: 'notes',
        toPath: 'notes',
      },
      { backlinkIndex: buildBacklinkIndex(dir) },
    );

    expect(result.status).toBe(200);
    expect(readFileSync(join(dir, 'notes.md'), 'utf-8')).toBe('# Notes\n');
    expect(JSON.parse(result.body)).toEqual({
      renamed: [],
      renamedAssets: [],
      rewrittenDocs: [],
    });
  });

  test('managed rename rejects reserved document names', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'notes.md'), '# Notes\n', 'utf-8');

    const result = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      {
        kind: 'file',
        fromPath: 'notes',
        toPath: '__system__',
      },
      { backlinkIndex: buildBacklinkIndex(dir) },
    );

    expect(result.status).toBe(400);
    const reservedBody = JSON.parse(result.body) as Record<string, unknown>;
    expect(reservedBody.type).toBe('urn:ok:error:reserved-doc-name');
    expect(reservedBody.title).toContain('Reserved document names cannot be renamed');
  });

  test('managed rename with kind:folder on an existing file returns 400 (type mismatch)', async () => {
    // The path is used verbatim for kind:'folder', so passing a `.md` path
    // resolves to the on-disk file. statSync says it's not a directory →
    // ManagedRenameSourceTypeMismatchError → 400.
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'notes.md'), '# Notes\n', 'utf-8');

    const result = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      {
        kind: 'folder',
        fromPath: 'notes.md',
        toPath: 'renamed-notes',
      },
      { backlinkIndex: buildBacklinkIndex(dir) },
    );

    expect(result.status).toBe(400);
    {
      const parsed = JSON.parse(result.body) as Record<string, unknown>;
      expect(parsed.type).toBe('urn:ok:error:invalid-request');
      expect(parsed.title).toContain('Source path is not a folder');
    }
  });

  test('managed rename with kind:file on a .md-named directory returns 400 (type mismatch)', async () => {
    // For kind:'file', the resolver keeps the path verbatim when it already
    // carries a supported extension. A directory named `looks-like.md` then
    // exists but stats as a directory → ManagedRenameSourceTypeMismatchError.
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'looks-like.md'));

    const result = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      {
        kind: 'file',
        fromPath: 'looks-like.md',
        toPath: 'renamed.md',
      },
      { backlinkIndex: buildBacklinkIndex(dir) },
    );

    expect(result.status).toBe(400);
    {
      const parsed = JSON.parse(result.body) as Record<string, unknown>;
      expect(parsed.type).toBe('urn:ok:error:invalid-request');
      expect(parsed.title).toContain('Source path is not a file');
    }
  });

  test('managed rename rejects .ok as a destination (reserved directory)', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'project'));
    writeFileSync(join(dir, 'project', 'index.md'), '# Index\n', 'utf-8');

    const result = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      {
        kind: 'folder',
        fromPath: 'project',
        toPath: '.ok',
      },
      { backlinkIndex: buildBacklinkIndex(dir) },
    );

    expect(result.status).toBe(400);
    {
      const parsed = JSON.parse(result.body) as Record<string, unknown>;
      expect(parsed.type).toBe('urn:ok:error:reserved-doc-name');
      expect(parsed.title).toContain('.ok is a reserved directory');
    }
  });

  test('managed rename rejects .ok subpath as a destination', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'notes.md'), '# Notes\n', 'utf-8');

    const result = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      {
        kind: 'file',
        fromPath: 'notes',
        toPath: '.ok/secret',
      },
      { backlinkIndex: buildBacklinkIndex(dir) },
    );

    expect(result.status).toBe(400);
    {
      const parsed = JSON.parse(result.body) as Record<string, unknown>;
      expect(parsed.type).toBe('urn:ok:error:reserved-doc-name');
      expect(parsed.title).toContain('.ok is a reserved directory');
    }
  });

  test('managed rename returns 404 when the source document is missing', async () => {
    const dir = setupTmpDir();

    const result = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      {
        kind: 'file',
        fromPath: 'notes',
        toPath: 'renamed-notes',
      },
      { backlinkIndex: buildBacklinkIndex(dir) },
    );

    expect(result.status).toBe(404);
    const notFoundBody = JSON.parse(result.body) as Record<string, unknown>;
    expect(notFoundBody.type).toBe('urn:ok:error:doc-not-found');
    // Title wording may vary ("file does not exist" / "Document does not exist")
    // depending on handler-side phrasing; the URN is the load-bearing assertion.
    expect(typeof notFoundBody.title).toBe('string');
    expect(String(notFoundBody.title).toLowerCase()).toContain('does not exist');
  });

  test('managed rename does not register explicit missing source extensions', async () => {
    const dir = setupTmpDir();

    const result = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      {
        kind: 'file',
        fromPath: 'missing.mdx',
        toPath: 'renamed.mdx',
      },
      { backlinkIndex: buildBacklinkIndex(dir) },
    );

    expect(result.status).toBe(404);
    expect(getDocExtension('missing')).toBe('.md');
  });

  test.skipIf(process.platform === 'win32')(
    'managed rename surfaces actionable symlink escape errors',
    async () => {
      const root = setupTmpDir();
      const contentDir = join(root, 'content');
      const outside = join(root, 'outside');
      mkdirSync(contentDir);
      mkdirSync(outside);
      symlinkSync(join('..', 'outside'), join(contentDir, 'evil'), 'dir');
      writeFileSync(join(contentDir, 'safe.md'), '# Safe\n', 'utf-8');

      const result = await callApi(
        contentDir,
        '/api/rename-path',
        'POST',
        {
          kind: 'file',
          fromPath: 'safe',
          toPath: 'evil/captured',
        },
        { backlinkIndex: buildBacklinkIndex(contentDir) },
      );

      expect(result.status).toBe(400);
      const symlinkBody = JSON.parse(result.body) as Record<string, unknown>;
      expect(symlinkBody.type).toBe('urn:ok:error:path-escape');
      expect(symlinkBody.title).toBe('symlink-escape: path resolves outside content directory.');
    },
  );

  test('renames a file and returns the old-to-new mapping', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'notes.md'), '# Notes\n', 'utf-8');

    const result = await callApi(dir, '/api/rename-path', 'POST', {
      kind: 'file',
      fromPath: 'notes',
      toPath: 'renamed-notes',
    });

    expect(result.status).toBe(200);
    expect(existsSync(join(dir, 'notes.md'))).toBe(false);
    expect(readFileSync(join(dir, 'renamed-notes.md'), 'utf-8')).toBe('# Notes\n');

    const body = JSON.parse(result.body) as { ok: boolean; renamed: Array<Record<string, string>> };
    expect(body.ok).toBeUndefined();
    expect(body.renamed).toEqual([{ fromDocName: 'notes', toDocName: 'renamed-notes' }]);
  });

  test('renames a folder and returns descendant mappings', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'docs/nested'), { recursive: true });
    writeFileSync(join(dir, 'docs/index.md'), '# Docs\n', 'utf-8');
    writeFileSync(join(dir, 'docs/nested/page.md'), '# Nested\n', 'utf-8');

    const result = await callApi(dir, '/api/rename-path', 'POST', {
      kind: 'folder',
      fromPath: 'docs',
      toPath: 'guides',
    });

    expect(result.status).toBe(200);
    expect(existsSync(join(dir, 'docs'))).toBe(false);
    expect(readFileSync(join(dir, 'guides/index.md'), 'utf-8')).toBe('# Docs\n');
    expect(readFileSync(join(dir, 'guides/nested/page.md'), 'utf-8')).toBe('# Nested\n');

    const body = JSON.parse(result.body) as {
      ok: boolean;
      renamed: Array<{ fromDocName: string; toDocName: string }>;
    };
    expect(body.ok).toBeUndefined();
    expect(body.renamed).toEqual([
      { fromDocName: 'docs/index', toDocName: 'guides/index' },
      { fromDocName: 'docs/nested/page', toDocName: 'guides/nested/page' },
    ]);
  });

  test('case-only folder rename returns descendant mappings', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'Docs/nested'), { recursive: true });
    writeFileSync(join(dir, 'Docs/index.md'), '# Docs\n', 'utf-8');
    writeFileSync(join(dir, 'Docs/nested/Page.md'), '# Nested\n', 'utf-8');

    const result = await callApi(dir, '/api/rename-path', 'POST', {
      kind: 'folder',
      fromPath: 'Docs',
      toPath: 'docs',
    });

    expect(result.status).toBe(200);
    expect(readdirSync(dir)).toContain('docs');
    expect(readdirSync(dir)).not.toContain('Docs');
    expect(readFileSync(join(dir, 'docs/index.md'), 'utf-8')).toBe('# Docs\n');
    expect(readFileSync(join(dir, 'docs/nested/Page.md'), 'utf-8')).toBe('# Nested\n');

    const body = JSON.parse(result.body) as {
      renamed: Array<{ fromDocName: string; toDocName: string }>;
    };
    expect(body.renamed).toEqual([
      { fromDocName: 'Docs/index', toDocName: 'docs/index' },
      { fromDocName: 'Docs/nested/Page', toDocName: 'docs/nested/Page' },
    ]);
  });

  test('folder rename updates the in-memory index before /api/pages reads it', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'docs/nested'), { recursive: true });
    writeFileSync(join(dir, 'docs/index.md'), '# Docs\n', 'utf-8');
    writeFileSync(join(dir, 'docs/nested/page.md'), '# Nested\n', 'utf-8');

    const fileIndex = new Map(buildFileIndex(dir));
    const signals: string[] = [];

    const renameResult = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      {
        kind: 'folder',
        fromPath: 'docs',
        toPath: 'guides',
      },
      {
        backlinkIndex: buildBacklinkIndex(dir),
        getFileIndex: () => fileIndex,
        signalChannel: (channel) => signals.push(channel),
      },
    );

    expect(renameResult.status).toBe(200);
    expect(fileIndex.has('docs/index')).toBe(false);
    expect(fileIndex.has('docs/nested/page')).toBe(false);
    expect(fileIndex.has('guides/index')).toBe(true);
    expect(fileIndex.has('guides/nested/page')).toBe(true);
    expect(signals).toEqual(expect.arrayContaining(['files', 'backlinks', 'graph']));

    const pagesResult = await callApi(
      dir,
      '/api/pages',
      'GET',
      {},
      {
        backlinkIndex: buildBacklinkIndex(dir),
        getFileIndex: () => fileIndex,
      },
    );

    expect(pagesResult.status).toBe(200);
    const body = JSON.parse(pagesResult.body) as {
      ok: boolean;
      pages: Array<{ docName: string; title: string }>;
    };
    expect(body.ok).toBeUndefined();
    expect(body.pages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ docName: 'guides/index', title: 'Docs' }),
        expect.objectContaining({ docName: 'guides/nested/page', title: 'Nested' }),
      ]),
    );
    expect(body.pages.map((page) => page.docName)).not.toContain('docs/index');
    expect(body.pages.map((page) => page.docName)).not.toContain('docs/nested/page');
  });

  test('folder rename uses git mv for tracked files', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'docs/nested'), { recursive: true });
    writeFileSync(join(dir, 'docs/index.md'), '# Docs\n', 'utf-8');
    writeFileSync(join(dir, 'docs/nested/page.md'), '# Nested\n', 'utf-8');

    const git = simpleGit(dir);
    await git.init();
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@example.com');
    await git.add('.');
    await git.commit('Initial');

    const result = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      {
        kind: 'folder',
        fromPath: 'docs',
        toPath: 'guides',
      },
      {
        backlinkIndex: buildBacklinkIndex(dir),
        projectDir: dir,
      },
    );

    expect(result.status).toBe(200);

    const status = await git.raw('status', '--short');
    expect(status).toContain('R  docs/index.md -> guides/index.md');
    expect(status).toContain('R  docs/nested/page.md -> guides/nested/page.md');
    expect(status).not.toContain(' D docs/index.md');
    expect(status).not.toContain('?? guides/');
  });

  test('case-only folder rename uses git mv for tracked files', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'Docs/nested'), { recursive: true });
    writeFileSync(join(dir, 'Docs/index.md'), '# Docs\n', 'utf-8');
    writeFileSync(join(dir, 'Docs/nested/Page.md'), '# Nested\n', 'utf-8');

    const git = simpleGit(dir);
    await git.init();
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@example.com');
    await git.add('.');
    await git.commit('Initial');

    const result = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      {
        kind: 'folder',
        fromPath: 'Docs',
        toPath: 'docs',
      },
      {
        backlinkIndex: buildBacklinkIndex(dir),
        projectDir: dir,
      },
    );

    expect(result.status).toBe(200);
    expect(readdirSync(dir)).toContain('docs');
    expect(readdirSync(dir)).not.toContain('Docs');
    const body = JSON.parse(result.body) as {
      renamed: Array<{ fromDocName: string; toDocName: string }>;
    };
    expect(body.renamed).toEqual([
      { fromDocName: 'Docs/index', toDocName: 'docs/index' },
      { fromDocName: 'Docs/nested/Page', toDocName: 'docs/nested/Page' },
    ]);

    const status = await git.raw('status', '--short');
    expect(status).toContain('R  Docs/index.md -> docs/index.md');
    expect(status).toContain('R  Docs/nested/Page.md -> docs/nested/Page.md');
    expect(status).not.toContain(' D Docs/index.md');
    expect(status).not.toContain('?? docs/');
  });

  test('file rename uses git mv for tracked files', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'old-name.md'), '# Doc\\n', 'utf-8');

    const git = simpleGit(dir);
    await git.init();
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@example.com');
    await git.add('.');
    await git.commit('Initial');

    const result = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      { kind: 'file', fromPath: 'old-name', toPath: 'new-name' },
      { backlinkIndex: buildBacklinkIndex(dir), projectDir: dir },
    );

    expect(result.status).toBe(200);
    const status = await git.raw('status', '--short');
    expect(status).toContain('old-name.md -> new-name.md');
  });

  test('case-only file rename uses git mv for tracked files', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'CaseName.md'), '# Doc\n', 'utf-8');

    const git = simpleGit(dir);
    await git.init();
    await git.raw('config', 'user.name', 'Test');
    await git.raw('config', 'user.email', 'test@example.com');
    await git.add('.');
    await git.commit('Initial');

    const result = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      { kind: 'file', fromPath: 'CaseName', toPath: 'casename' },
      { backlinkIndex: buildBacklinkIndex(dir), projectDir: dir },
    );

    expect(result.status).toBe(200);
    expect(readdirSync(dir)).toContain('casename.md');
    expect(readdirSync(dir)).not.toContain('CaseName.md');
    const body = JSON.parse(result.body) as {
      renamed: Array<{ fromDocName: string; toDocName: string }>;
    };
    expect(body.renamed).toEqual([{ fromDocName: 'CaseName', toDocName: 'casename' }]);
    const status = await git.raw('status', '--short');
    expect(status).toContain('CaseName.md -> casename.md');
  });

  test.skipIf(process.platform === 'darwin' || process.platform === 'win32')(
    'case-only file rename rejects distinct destination file on case-sensitive filesystems',
    async () => {
      const dir = setupTmpDir();
      writeFileSync(join(dir, 'Notes.md'), '# Upper\n', 'utf-8');
      writeFileSync(join(dir, 'notes.md'), '# Lower\n', 'utf-8');

      const result = await callApi(
        dir,
        '/api/rename-path',
        'POST',
        { kind: 'file', fromPath: 'Notes', toPath: 'notes' },
        { backlinkIndex: buildBacklinkIndex(dir), projectDir: dir },
      );

      expect(result.status).toBe(409);
      expect(readFileSync(join(dir, 'Notes.md'), 'utf-8')).toBe('# Upper\n');
      expect(readFileSync(join(dir, 'notes.md'), 'utf-8')).toBe('# Lower\n');
    },
  );

  test.skipIf(process.platform === 'darwin' || process.platform === 'win32')(
    'case-only folder rename rejects distinct destination folder on case-sensitive filesystems',
    async () => {
      const dir = setupTmpDir();
      mkdirSync(join(dir, 'Docs'), { recursive: true });
      mkdirSync(join(dir, 'docs'), { recursive: true });
      writeFileSync(join(dir, 'Docs/index.md'), '# Upper\n', 'utf-8');
      writeFileSync(join(dir, 'docs/index.md'), '# Lower\n', 'utf-8');

      const result = await callApi(
        dir,
        '/api/rename-path',
        'POST',
        { kind: 'folder', fromPath: 'Docs', toPath: 'docs' },
        { backlinkIndex: buildBacklinkIndex(dir), projectDir: dir },
      );

      expect(result.status).toBe(409);
      expect(readFileSync(join(dir, 'Docs/index.md'), 'utf-8')).toBe('# Upper\n');
      expect(readFileSync(join(dir, 'docs/index.md'), 'utf-8')).toBe('# Lower\n');
    },
  );

  test('deletes a file and reports the removed doc name', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'trash-me.md'), '# Delete me\n', 'utf-8');

    const result = await callApi(dir, '/api/delete-path', 'POST', {
      kind: 'file',
      path: 'trash-me',
    });

    expect(result.status).toBe(200);
    expect(existsSync(join(dir, 'trash-me.md'))).toBe(false);

    const body = JSON.parse(result.body) as { ok: boolean; deletedDocNames: string[] };
    expect(body.ok).toBeUndefined();
    expect(body.deletedDocNames).toEqual(['trash-me']);
  });

  test('delete accepts asset-shaped markdown paths as document deletes', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'trash-me.md'), '# Delete me\n', 'utf-8');

    const result = await callApi(dir, '/api/delete-path', 'POST', {
      kind: 'asset',
      path: 'trash-me.md',
    });

    expect(result.status).toBe(200);
    expect(existsSync(join(dir, 'trash-me.md'))).toBe(false);
    const body = JSON.parse(result.body) as { deletedDocNames: string[] };
    expect(body.deletedDocNames).toEqual(['trash-me']);
  });

  test('renames an asset and rewrites markdown references', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'docs/media'), { recursive: true });
    writeFileSync(join(dir, 'docs/media/diagram.png'), 'fake image bytes', 'utf-8');
    writeFileSync(
      join(dir, 'docs/guide.md'),
      [
        '# Guide',
        '',
        '![diagram](./media/diagram.png "Diagram")',
        '[download](./media/diagram.png?dl=1#hash)',
        '![[media/diagram.png|Diagram]]',
        '[[media/diagram.png#page=2|Diagram]]',
        '![root](/docs/media/diagram.png)',
        '',
        '`![code](./media/diagram.png)`',
        '',
        '```md',
        '![fenced](./media/diagram.png)',
        '```',
        '',
      ].join('\n'),
      'utf-8',
    );
    const contentFilter = createContentFilter({ projectDir: dir, contentDir: dir });

    const result = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      {
        kind: 'asset',
        fromPath: 'docs/media/diagram.png',
        toPath: 'docs/assets/hero.png',
      },
      {
        contentFilter,
      },
    );

    expect(result.status).toBe(200);
    expect(existsSync(join(dir, 'docs/media/diagram.png'))).toBe(false);
    expect(readFileSync(join(dir, 'docs/assets/hero.png'), 'utf-8')).toBe('fake image bytes');
    expect(readFileSync(join(dir, 'docs/guide.md'), 'utf-8')).toBe(
      [
        '# Guide',
        '',
        '![diagram](./assets/hero.png "Diagram")',
        '[download](./assets/hero.png?dl=1#hash)',
        '![[assets/hero.png|Diagram]]',
        '[[assets/hero.png#page=2|Diagram]]',
        '![root](/docs/assets/hero.png)',
        '',
        '`![code](./media/diagram.png)`',
        '',
        '```md',
        '![fenced](./media/diagram.png)',
        '```',
        '',
      ].join('\n'),
    );

    const body = JSON.parse(result.body) as {
      renamedAssets: Array<{ fromPath: string; toPath: string }>;
      renamed: unknown[];
      rewrittenDocs: Array<{ docName: string; rewrites: number }>;
    };
    expect(body.renamed).toEqual([]);
    expect(body.renamedAssets).toEqual([
      { fromPath: 'docs/media/diagram.png', toPath: 'docs/assets/hero.png' },
    ]);
    expect(body.rewrittenDocs).toEqual([{ docName: 'docs/guide', rewrites: 5 }]);
  });

  test('asset rename rejects destinations excluded by content config', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'docs/media'), { recursive: true });
    writeFileSync(join(dir, 'docs/media/diagram.png'), 'fake image bytes', 'utf-8');
    writeFileSync(join(dir, 'docs/guide.md'), '# Guide\n', 'utf-8');
    writeFileSync(join(dir, '.okignore'), 'private-assets/\n', 'utf-8');
    const contentFilter = createContentFilter({ projectDir: dir, contentDir: dir });

    const result = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      {
        kind: 'asset',
        fromPath: 'docs/media/diagram.png',
        toPath: 'private-assets/hero.png',
      },
      { contentFilter },
    );

    expect(result.status).toBe(400);
    expect(existsSync(join(dir, 'docs/media/diagram.png'))).toBe(true);
    expect(existsSync(join(dir, 'private-assets/hero.png'))).toBe(false);
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:invalid-request',
      title: 'Destination asset is excluded by the project content config.',
      status: 400,
    });
  });

  test('asset rename preserves the source extension when the destination omits it', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'docs/media'), { recursive: true });
    writeFileSync(join(dir, 'docs/media/diagram.png'), 'fake image bytes', 'utf-8');
    writeFileSync(join(dir, 'docs/guide.md'), '![diagram](./media/diagram.png)\n', 'utf-8');
    const contentFilter = createContentFilter({ projectDir: dir, contentDir: dir });

    const result = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      {
        kind: 'asset',
        fromPath: 'docs/media/diagram.png',
        toPath: 'docs/media/hero',
      },
      { contentFilter },
    );

    expect(result.status).toBe(200);
    expect(existsSync(join(dir, 'docs/media/diagram.png'))).toBe(false);
    expect(readFileSync(join(dir, 'docs/media/hero.png'), 'utf-8')).toBe('fake image bytes');
    expect(readFileSync(join(dir, 'docs/guide.md'), 'utf-8')).toBe(
      '![diagram](./media/hero.png)\n',
    );

    const body = JSON.parse(result.body) as {
      renamedAssets: Array<{ fromPath: string; toPath: string }>;
      rewrittenDocs: Array<{ docName: string; rewrites: number }>;
    };
    expect(body.renamedAssets).toEqual([
      { fromPath: 'docs/media/diagram.png', toPath: 'docs/media/hero.png' },
    ]);
    expect(body.rewrittenDocs).toEqual([{ docName: 'docs/guide', rewrites: 1 }]);
  });

  test('asset rename allows arbitrary source extensions', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'docs/media'), { recursive: true });
    writeFileSync(join(dir, 'docs/media/archive.xyz'), 'fake bytes', 'utf-8');

    const result = await callApi(dir, '/api/rename-path', 'POST', {
      kind: 'asset',
      fromPath: 'docs/media/archive.xyz',
      toPath: 'docs/media/archive.png',
    });

    expect(result.status).toBe(200);
    expect(existsSync(join(dir, 'docs/media/archive.xyz'))).toBe(false);
    expect(readFileSync(join(dir, 'docs/media/archive.png'), 'utf-8')).toBe('fake bytes');
  });

  test('asset rename allows arbitrary destination extensions', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'docs/media'), { recursive: true });
    writeFileSync(join(dir, 'docs/media/diagram.png'), 'fake image bytes', 'utf-8');

    const result = await callApi(dir, '/api/rename-path', 'POST', {
      kind: 'asset',
      fromPath: 'docs/media/diagram.png',
      toPath: 'docs/media/diagram.pngg',
    });

    expect(result.status).toBe(200);
    expect(existsSync(join(dir, 'docs/media/diagram.png'))).toBe(false);
    expect(readFileSync(join(dir, 'docs/media/diagram.pngg'), 'utf-8')).toBe('fake image bytes');
  });

  test('asset rename allows markdown documents to become arbitrary files', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'docs/media'), { recursive: true });
    writeFileSync(join(dir, 'docs/guide.md'), '# Guide\n', 'utf-8');
    writeFileSync(join(dir, 'docs/index.md'), '[Guide](./guide.md)\n', 'utf-8');

    const result = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      {
        kind: 'asset',
        fromPath: 'docs/guide.md',
        toPath: 'docs/media/guide.custom',
      },
      { backlinkIndex: buildBacklinkIndex(dir) },
    );

    expect(result.status).toBe(200);
    expect(existsSync(join(dir, 'docs/guide.md'))).toBe(false);
    expect(readFileSync(join(dir, 'docs/media/guide.custom'), 'utf-8')).toBe('# Guide\n');
    expect(readFileSync(join(dir, 'docs/index.md'), 'utf-8')).toBe(
      '[Guide](./media/guide.custom)\n',
    );
    const body = JSON.parse(result.body) as {
      renamed: Array<{ fromDocName: string; toDocName: string }>;
      renamedAssets: Array<{ fromPath: string; toPath: string }>;
      rewrittenDocs: Array<{ docName: string; rewrites: number }>;
    };
    expect(body.renamed).toEqual([]);
    expect(body.renamedAssets).toEqual([
      {
        fromPath: 'docs/guide.md',
        toPath: 'docs/media/guide.custom',
      },
    ]);
    expect(body.rewrittenDocs).toEqual([{ docName: 'docs/index', rewrites: 1 }]);
  });

  test('document-to-file rename carries live Y.Doc content to the destination file', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'live.md'), '# Stale\n', 'utf-8');

    const hocuspocus = new Hocuspocus({ quiet: true });
    const conn = await hocuspocus.openDirectConnection('live');
    const document = (conn as unknown as { document: Y.Doc }).document;
    const ytext = document.getText('source');
    document.transact(() => {
      ytext.insert(0, '# Live\n');
    });

    try {
      const result = await callApi(
        dir,
        '/api/rename-path',
        'POST',
        {
          kind: 'asset',
          fromPath: 'live.md',
          toPath: 'live.txt',
        },
        {
          backlinkIndex: buildBacklinkIndex(dir),
          hocuspocus,
        },
      );

      expect(result.status).toBe(200);
      expect(existsSync(join(dir, 'live.md'))).toBe(false);
      expect(readFileSync(join(dir, 'live.txt'), 'utf-8')).toBe('# Live\n');
    } finally {
      await conn.disconnect().catch(() => {});
    }
  });

  test('document-to-file rename returns 404 when the source document is missing', async () => {
    const dir = setupTmpDir();

    const result = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      {
        kind: 'asset',
        fromPath: 'missing.md',
        toPath: 'missing.txt',
      },
      { backlinkIndex: buildBacklinkIndex(dir) },
    );

    expect(result.status).toBe(404);
    expect(existsSync(join(dir, 'missing.txt'))).toBe(false);
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:doc-not-found',
      status: 404,
    });
  });

  test('document-to-file rename returns 409 when the destination file exists', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'guide.md'), '# Guide\n', 'utf-8');
    writeFileSync(join(dir, 'guide.txt'), 'existing\n', 'utf-8');

    const result = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      {
        kind: 'asset',
        fromPath: 'guide.md',
        toPath: 'guide.txt',
      },
      { backlinkIndex: buildBacklinkIndex(dir) },
    );

    expect(result.status).toBe(409);
    expect(readFileSync(join(dir, 'guide.md'), 'utf-8')).toBe('# Guide\n');
    expect(readFileSync(join(dir, 'guide.txt'), 'utf-8')).toBe('existing\n');
  });

  test('document-to-file rename requires a backlink index', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'guide.md'), '# Guide\n', 'utf-8');

    const result = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      {
        kind: 'asset',
        fromPath: 'guide.md',
        toPath: 'guide.txt',
      },
      { backlinkIndex: null },
    );

    expect(result.status).toBe(503);
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:backlink-index-not-configured',
      status: 503,
    });
    expect(readFileSync(join(dir, 'guide.md'), 'utf-8')).toBe('# Guide\n');
  });

  test('asset rename allows arbitrary files to use markdown extensions', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'docs/media'), { recursive: true });
    writeFileSync(join(dir, 'docs/media/guide.custom'), '# Guide\n', 'utf-8');
    writeFileSync(join(dir, 'docs/index.md'), '[Guide](./media/guide.custom)\n', 'utf-8');

    const result = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      {
        kind: 'asset',
        fromPath: 'docs/media/guide.custom',
        toPath: 'docs/guide.md',
      },
      { backlinkIndex: buildBacklinkIndex(dir) },
    );

    expect(result.status).toBe(200);
    expect(existsSync(join(dir, 'docs/media/guide.custom'))).toBe(false);
    expect(readFileSync(join(dir, 'docs/guide.md'), 'utf-8')).toBe('# Guide\n');
    expect(readFileSync(join(dir, 'docs/index.md'), 'utf-8')).toBe('[Guide](./guide.md)\n');
    const body = JSON.parse(result.body) as {
      renamed: Array<{ fromDocName: string; toDocName: string }>;
      renamedAssets: Array<{ fromPath: string; toPath: string }>;
      rewrittenDocs: Array<{ docName: string; rewrites: number }>;
    };
    expect(body.renamed).toEqual([]);
    expect(body.renamedAssets).toEqual([
      {
        fromPath: 'docs/media/guide.custom',
        toPath: 'docs/guide.md',
      },
    ]);
    expect(body.rewrittenDocs).toEqual([{ docName: 'docs/index', rewrites: 1 }]);
  });

  test('asset rename to markdown extension returns 404 when the source file is missing', async () => {
    const dir = setupTmpDir();

    const result = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      {
        kind: 'asset',
        fromPath: 'missing.txt',
        toPath: 'missing.md',
      },
      { backlinkIndex: buildBacklinkIndex(dir) },
    );

    expect(result.status).toBe(404);
    expect(existsSync(join(dir, 'missing.md'))).toBe(false);
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:doc-not-found',
      title: 'Asset does not exist.',
      status: 404,
    });
  });

  test('asset rename to markdown extension returns 409 when the destination exists', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'guide.txt'), '# Guide\n', 'utf-8');
    writeFileSync(join(dir, 'guide.md'), '# Existing\n', 'utf-8');

    const result = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      {
        kind: 'asset',
        fromPath: 'guide.txt',
        toPath: 'guide.md',
      },
      { backlinkIndex: buildBacklinkIndex(dir) },
    );

    expect(result.status).toBe(409);
    expect(readFileSync(join(dir, 'guide.txt'), 'utf-8')).toBe('# Guide\n');
    expect(readFileSync(join(dir, 'guide.md'), 'utf-8')).toBe('# Existing\n');
  });

  test('asset rename to markdown extension requires a backlink index', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'guide.txt'), '# Guide\n', 'utf-8');

    const result = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      {
        kind: 'asset',
        fromPath: 'guide.txt',
        toPath: 'guide.md',
      },
      { backlinkIndex: null },
    );

    expect(result.status).toBe(503);
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:backlink-index-not-configured',
      status: 503,
    });
    expect(readFileSync(join(dir, 'guide.txt'), 'utf-8')).toBe('# Guide\n');
  });

  test('asset rename allows binary input to use a markdown extension', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'binary.bin'), Buffer.from([0x23, 0x00, 0xff]));

    const result = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      {
        kind: 'asset',
        fromPath: 'binary.bin',
        toPath: 'binary.md',
      },
      { backlinkIndex: buildBacklinkIndex(dir) },
    );

    expect(result.status).toBe(200);
    expect(existsSync(join(dir, 'binary.bin'))).toBe(false);
    expect(readFileSync(join(dir, 'binary.md'))).toEqual(Buffer.from([0x23, 0x00, 0xff]));
  });

  test('asset-shaped markdown rename uses the document rename path', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs/guide.md'), '# Guide\n', 'utf-8');

    const result = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      {
        kind: 'asset',
        fromPath: 'docs/guide.md',
        toPath: 'docs/guide.mdx',
      },
      { backlinkIndex: buildBacklinkIndex(dir) },
    );

    expect(result.status).toBe(200);
    expect(existsSync(join(dir, 'docs/guide.md'))).toBe(false);
    expect(readFileSync(join(dir, 'docs/guide.mdx'), 'utf-8')).toBe('# Guide\n');
  });

  test('asset rename returns 404 when the source asset is missing', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'docs/media'), { recursive: true });

    const result = await callApi(dir, '/api/rename-path', 'POST', {
      kind: 'asset',
      fromPath: 'docs/media/missing.png',
      toPath: 'docs/media/hero.png',
    });

    expect(result.status).toBe(404);
    expect(existsSync(join(dir, 'docs/media/hero.png'))).toBe(false);
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:doc-not-found',
      title: 'Asset does not exist.',
      status: 404,
    });
  });

  test('asset rename returns 409 when the destination asset exists', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'docs/media'), { recursive: true });
    writeFileSync(join(dir, 'docs/media/diagram.png'), 'fake image bytes', 'utf-8');
    writeFileSync(join(dir, 'docs/media/hero.png'), 'existing image bytes', 'utf-8');

    const result = await callApi(dir, '/api/rename-path', 'POST', {
      kind: 'asset',
      fromPath: 'docs/media/diagram.png',
      toPath: 'docs/media/hero.png',
    });

    expect(result.status).toBe(409);
    expect(readFileSync(join(dir, 'docs/media/diagram.png'), 'utf-8')).toBe('fake image bytes');
    expect(readFileSync(join(dir, 'docs/media/hero.png'), 'utf-8')).toBe('existing image bytes');
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:doc-already-exists',
      title: 'Destination already exists.',
      status: 409,
    });
  });

  test('asset rename rejects a supported-extension directory as the source', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'docs/media/folder.png'), { recursive: true });

    const result = await callApi(dir, '/api/rename-path', 'POST', {
      kind: 'asset',
      fromPath: 'docs/media/folder.png',
      toPath: 'docs/media/hero.png',
    });

    expect(result.status).toBe(400);
    expect(existsSync(join(dir, 'docs/media/folder.png'))).toBe(true);
    expect(existsSync(join(dir, 'docs/media/hero.png'))).toBe(false);
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:invalid-request',
      title: 'Source path is not an asset file.',
      status: 400,
    });
  });

  test('asset rename rejects case-only renames before touching disk', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'docs/media'), { recursive: true });
    writeFileSync(join(dir, 'docs/media/diagram.png'), 'fake image bytes', 'utf-8');

    const result = await callApi(dir, '/api/rename-path', 'POST', {
      kind: 'asset',
      fromPath: 'docs/media/diagram.png',
      toPath: 'docs/media/Diagram.png',
    });

    expect(result.status).toBe(400);
    expect(readFileSync(join(dir, 'docs/media/diagram.png'), 'utf-8')).toBe('fake image bytes');
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:invalid-request',
      title: 'Case-only renames are not supported.',
      status: 400,
    });
  });

  test.skipIf(process.platform === 'win32')(
    'asset rename rejects destination symlink escapes',
    async () => {
      const root = setupTmpDir();
      const contentDir = join(root, 'content');
      const outside = join(root, 'outside');
      mkdirSync(join(contentDir, 'assets'), { recursive: true });
      mkdirSync(outside);
      symlinkSync(join('..', 'outside'), join(contentDir, 'evil'), 'dir');
      writeFileSync(join(contentDir, 'assets/source.png'), 'fake image bytes', 'utf-8');

      const result = await callApi(contentDir, '/api/rename-path', 'POST', {
        kind: 'asset',
        fromPath: 'assets/source.png',
        toPath: 'evil/captured.png',
      });

      expect(result.status).toBe(400);
      expect(readFileSync(join(contentDir, 'assets/source.png'), 'utf-8')).toBe('fake image bytes');
      expect(existsSync(join(outside, 'captured.png'))).toBe(false);
      expect(JSON.parse(result.body)).toMatchObject({
        type: 'urn:ok:error:path-escape',
        title: 'symlink-escape: path resolves outside content directory.',
        status: 400,
      });
    },
  );

  test('asset rename maps missing backlink index to the managed-rename 503', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'docs/media'), { recursive: true });
    writeFileSync(join(dir, 'docs/media/diagram.png'), 'fake image bytes', 'utf-8');

    const result = await callApi(
      dir,
      '/api/rename-path',
      'POST',
      {
        kind: 'asset',
        fromPath: 'docs/media/diagram.png',
        toPath: 'docs/media/hero.png',
      },
      { backlinkIndex: null },
    );

    expect(result.status).toBe(503);
    const body = JSON.parse(result.body) as { type: string; title: string };
    expect(body.type).toBe('urn:ok:error:backlink-index-not-configured');
    expect(body.title).toBe('Managed rename requires backlink index support.');
  });

  test('renames an asset-only folder and rewrites markdown references', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'media'), { recursive: true });
    writeFileSync(join(dir, 'media/diagram.png'), 'fake image bytes', 'utf-8');
    writeFileSync(
      join(dir, 'index.md'),
      ['# Index', '', '![diagram](./media/diagram.png)', '![[media/diagram.png]]', ''].join('\n'),
      'utf-8',
    );

    const result = await callApi(dir, '/api/rename-path', 'POST', {
      kind: 'folder',
      fromPath: 'media',
      toPath: 'assets',
    });

    expect(result.status).toBe(200);
    expect(existsSync(join(dir, 'media/diagram.png'))).toBe(false);
    expect(readFileSync(join(dir, 'assets/diagram.png'), 'utf-8')).toBe('fake image bytes');
    expect(readFileSync(join(dir, 'index.md'), 'utf-8')).toBe(
      ['# Index', '', '![diagram](./assets/diagram.png)', '![[assets/diagram.png]]', ''].join('\n'),
    );

    const body = JSON.parse(result.body) as {
      renamed: Array<{ fromDocName: string; toDocName: string }>;
      renamedAssets: Array<{ fromPath: string; toPath: string }>;
      rewrittenDocs: Array<{ docName: string; rewrites: number }>;
    };
    expect(body.renamed).toEqual([]);
    expect(body.renamedAssets).toEqual([
      { fromPath: 'media/diagram.png', toPath: 'assets/diagram.png' },
    ]);
    expect(body.rewrittenDocs).toEqual([{ docName: 'index', rewrites: 2 }]);
  });

  test('folder rename rewrites references to assets that move with markdown docs', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'docs/media'), { recursive: true });
    writeFileSync(join(dir, 'docs/media/diagram.png'), 'fake image bytes', 'utf-8');
    writeFileSync(
      join(dir, 'docs/guide.md'),
      ['# Guide', '', '![diagram](./media/diagram.png)', ''].join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(dir, 'index.md'),
      [
        '# Index',
        '',
        '![relative](./docs/media/diagram.png)',
        '![root](/docs/media/diagram.png)',
        '![[docs/media/diagram.png]]',
        '',
      ].join('\n'),
      'utf-8',
    );

    const result = await callApi(dir, '/api/rename-path', 'POST', {
      kind: 'folder',
      fromPath: 'docs',
      toPath: 'guides',
    });

    expect(result.status).toBe(200);
    expect(existsSync(join(dir, 'docs/media/diagram.png'))).toBe(false);
    expect(readFileSync(join(dir, 'guides/media/diagram.png'), 'utf-8')).toBe('fake image bytes');
    expect(readFileSync(join(dir, 'guides/guide.md'), 'utf-8')).toBe(
      ['# Guide', '', '![diagram](media/diagram.png)', ''].join('\n'),
    );
    expect(readFileSync(join(dir, 'index.md'), 'utf-8')).toBe(
      [
        '# Index',
        '',
        '![relative](./guides/media/diagram.png)',
        '![root](/guides/media/diagram.png)',
        '![[guides/media/diagram.png]]',
        '',
      ].join('\n'),
    );

    const body = JSON.parse(result.body) as {
      renamed: Array<{ fromDocName: string; toDocName: string }>;
      renamedAssets: Array<{ fromPath: string; toPath: string }>;
      rewrittenDocs: Array<{ docName: string; rewrites: number }>;
    };
    expect(body.renamed).toEqual([{ fromDocName: 'docs/guide', toDocName: 'guides/guide' }]);
    expect(body.renamedAssets).toEqual([
      { fromPath: 'docs/media/diagram.png', toPath: 'guides/media/diagram.png' },
    ]);
    expect(body.rewrittenDocs).toEqual([
      { docName: 'guides/guide', rewrites: 2 },
      { docName: 'index', rewrites: 3 },
    ]);
  });

  test('deletes an asset and reports no deleted doc names', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'assets/trash-me.png'), 'fake image bytes', 'utf-8');

    const result = await callApi(dir, '/api/delete-path', 'POST', {
      kind: 'asset',
      path: 'assets/trash-me.png',
    });

    expect(result.status).toBe(200);
    expect(existsSync(join(dir, 'assets/trash-me.png'))).toBe(false);
    const body = JSON.parse(result.body) as { deletedDocNames: string[] };
    expect(body.deletedDocNames).toEqual([]);
  });

  test('asset delete invalidates the cached document list asset row', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs/guide.md'), '![foo](./foo.png)\n', 'utf-8');
    writeFileSync(join(dir, 'docs/foo.png'), 'fake image bytes', 'utf-8');

    const fileIndex = new Map(buildFileIndex(dir));
    const api = await createTestApiExtension(dir, {
      getFileIndex: () => fileIndex,
    });

    const before = await callApiExtension(api, '/api/documents', 'GET', undefined);
    expect(before.status).toBe(200);
    expect(assetPathsFromDocumentList(before)).toContain('docs/foo.png');

    const result = await callApiExtension(api, '/api/delete-path', 'POST', {
      kind: 'asset',
      path: 'docs/foo.png',
    });
    expect(result.status).toBe(200);
    expect(existsSync(join(dir, 'docs/foo.png'))).toBe(false);

    const after = await callApiExtension(api, '/api/documents', 'GET', undefined);
    expect(after.status).toBe(200);
    expect(assetPathsFromDocumentList(after)).not.toContain('docs/foo.png');
  });

  test('registered asset cache invalidator refreshes referenced assets after markdown writes', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs/guide.md'), '![foo](./foo.png)\n', 'utf-8');
    writeFileSync(join(dir, 'docs/foo.png'), 'fake image bytes', 'utf-8');
    writeFileSync(join(dir, 'docs/bar.png'), 'new image bytes', 'utf-8');

    const fileIndex = new Map(buildFileIndex(dir));
    let invalidate: (() => void) | null = null;
    const api = await createTestApiExtension(dir, {
      getFileIndex: () => fileIndex,
      onReferencedAssetsCacheInvalidator: (registered) => {
        invalidate = registered;
      },
    });

    const before = await callApiExtension(api, '/api/documents', 'GET', undefined);
    expect(before.status).toBe(200);
    expect(assetPathsFromDocumentList(before)).toContain('docs/foo.png');
    expect(assetPathsFromDocumentList(before)).not.toContain('docs/bar.png');

    writeFileSync(join(dir, 'docs/guide.md'), '![bar](./bar.png)\n', 'utf-8');

    const stale = await callApiExtension(api, '/api/documents', 'GET', undefined);
    expect(stale.status).toBe(200);
    expect(assetPathsFromDocumentList(stale)).toContain('docs/foo.png');
    expect(assetPathsFromDocumentList(stale)).not.toContain('docs/bar.png');

    expect(invalidate).not.toBeNull();
    invalidate?.();

    const after = await callApiExtension(api, '/api/documents', 'GET', undefined);
    expect(after.status).toBe(200);
    expect(assetPathsFromDocumentList(after)).not.toContain('docs/foo.png');
    expect(assetPathsFromDocumentList(after)).toContain('docs/bar.png');
  });

  test('asset trash cleanup invalidates the cached document list asset row', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs/guide.md'), '![foo](./foo.png)\n', 'utf-8');
    writeFileSync(join(dir, 'docs/foo.png'), 'fake image bytes', 'utf-8');

    const fileIndex = new Map(buildFileIndex(dir));
    const api = await createTestApiExtension(dir, {
      getFileIndex: () => fileIndex,
    });

    const before = await callApiExtension(api, '/api/documents', 'GET', undefined);
    expect(before.status).toBe(200);
    expect(assetPathsFromDocumentList(before)).toContain('docs/foo.png');

    rmSync(join(dir, 'docs/foo.png'));
    const result = await callApiExtension(api, '/api/trash/cleanup', 'POST', {
      kind: 'asset',
      path: 'docs/foo.png',
    });
    expect(result.status).toBe(200);

    const after = await callApiExtension(api, '/api/documents', 'GET', undefined);
    expect(after.status).toBe(200);
    expect(assetPathsFromDocumentList(after)).not.toContain('docs/foo.png');
  });

  test('trash cleanup accepts asset-shaped markdown paths as document cleanup', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs/guide.md'), '# Guide\n', 'utf-8');

    const fileIndex = new Map(buildFileIndex(dir));
    const api = await createTestApiExtension(dir, {
      getFileIndex: () => fileIndex,
    });

    rmSync(join(dir, 'docs/guide.md'));
    const result = await callApiExtension(api, '/api/trash/cleanup', 'POST', {
      kind: 'asset',
      path: 'docs/guide.md',
    });

    expect(result.status).toBe(200);
    const body = JSON.parse(result.body) as { deletedDocNames: string[] };
    expect(body.deletedDocNames).toEqual(['docs/guide']);
    expect(fileIndex.has('docs/guide')).toBe(false);
  });

  test('asset-only folder trash cleanup invalidates the cached document list asset row', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'docs/media'), { recursive: true });
    writeFileSync(join(dir, 'docs/guide.md'), '![foo](./media/foo.png)\n', 'utf-8');
    writeFileSync(join(dir, 'docs/media/foo.png'), 'fake image bytes', 'utf-8');

    const fileIndex = new Map(buildFileIndex(dir));
    const api = await createTestApiExtension(dir, {
      getFileIndex: () => fileIndex,
    });

    const before = await callApiExtension(api, '/api/documents', 'GET', undefined);
    expect(before.status).toBe(200);
    expect(assetPathsFromDocumentList(before)).toContain('docs/media/foo.png');

    rmSync(join(dir, 'docs/media'), { recursive: true });
    const result = await callApiExtension(api, '/api/trash/cleanup', 'POST', {
      kind: 'folder',
      path: 'docs/media',
    });
    expect(result.status).toBe(200);

    const after = await callApiExtension(api, '/api/documents', 'GET', undefined);
    expect(after.status).toBe(200);
    expect(assetPathsFromDocumentList(after)).not.toContain('docs/media/foo.png');
  });

  test('deletes an asset when the request path omits the extension', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'assets/trash-me.png'), 'fake image bytes', 'utf-8');

    const result = await callApi(dir, '/api/delete-path', 'POST', {
      kind: 'asset',
      path: 'assets/trash-me',
    });

    expect(result.status).toBe(200);
    expect(existsSync(join(dir, 'assets/trash-me.png'))).toBe(false);
    const body = JSON.parse(result.body) as { deletedDocNames: string[] };
    expect(body.deletedDocNames).toEqual([]);
  });

  test('rejects an extensionless asset delete when multiple supported assets match', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'assets/trash-me.png'), 'fake image bytes', 'utf-8');
    writeFileSync(join(dir, 'assets/trash-me.jpg'), 'fake image bytes', 'utf-8');

    const result = await callApi(dir, '/api/delete-path', 'POST', {
      kind: 'asset',
      path: 'assets/trash-me',
    });

    expect(result.status).toBe(400);
    expect(existsSync(join(dir, 'assets/trash-me.png'))).toBe(true);
    expect(existsSync(join(dir, 'assets/trash-me.jpg'))).toBe(true);
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:invalid-request',
      title: 'Asset path without an extension matches multiple files.',
      status: 400,
    });
  });

  test('deletes a folder recursively and reports descendant doc names', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'archive/old'), { recursive: true });
    writeFileSync(join(dir, 'archive/index.md'), '# Archive\n', 'utf-8');
    writeFileSync(join(dir, 'archive/old/entry.md'), '# Entry\n', 'utf-8');

    const result = await callApi(dir, '/api/delete-path', 'POST', {
      kind: 'folder',
      path: 'archive',
    });

    expect(result.status).toBe(200);
    expect(existsSync(join(dir, 'archive'))).toBe(false);

    const body = JSON.parse(result.body) as { ok: boolean; deletedDocNames: string[] };
    expect(body.ok).toBeUndefined();
    expect(body.deletedDocNames).toEqual(['archive/index', 'archive/old/entry']);
  });

  test('creates an empty folder without materializing index.md', async () => {
    const dir = setupTmpDir();

    const result = await callApi(dir, '/api/create-folder', 'POST', {
      path: 'New Folder',
    });

    expect(result.status).toBe(200);
    expect(existsSync(join(dir, 'New Folder'))).toBe(true);
    expect(existsSync(join(dir, 'New Folder/index.md'))).toBe(false);
    // RFC 9457 success bodies drop the `{ ok: true }` wrapper — body
    // is the success schema's flat shape.
    const body = JSON.parse(result.body) as { path: string };
    expect(body.path).toBe('New Folder');
    expect((body as Record<string, unknown>).ok).toBeUndefined();
  });

  test('indexes intermediate folders created recursively', async () => {
    const dir = setupTmpDir();
    const folderIndex = new Map<string, FolderIndexEntry>();
    const getFolderIndex = () => folderIndex;

    const result = await callApi(
      dir,
      '/api/create-folder',
      'POST',
      {
        path: 'a/b/c',
      },
      { getFolderIndex },
    );

    expect(result.status).toBe(200);
    expect(existsSync(join(dir, 'a/b/c'))).toBe(true);

    const docsResult = await callApi(dir, '/api/documents', 'GET', undefined, { getFolderIndex });
    const body = JSON.parse(docsResult.body) as {
      ok: boolean;
      documents: Array<{ kind: string; path?: string }>;
    };
    const folderPaths = body.documents
      .filter((entry) => entry.kind === 'folder')
      .map((entry) => entry.path);
    expect(folderPaths).toEqual(expect.arrayContaining(['a', 'a/b', 'a/b/c']));
  });

  test('duplicates a file next to the source with a unique copy name', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'notes.md'), '# Notes\n', 'utf-8');
    writeFileSync(join(dir, 'notes copy.md'), '# Existing copy\n', 'utf-8');
    const signals: string[] = [];

    const result = await callApi(
      dir,
      '/api/duplicate-path',
      'POST',
      {
        kind: 'file',
        path: 'notes',
      },
      { signalChannel: (channel) => signals.push(channel) },
    );

    expect(result.status).toBe(200);
    expect(readFileSync(join(dir, 'notes copy 2.md'), 'utf-8')).toBe('# Notes\n');
    expect(signals).toEqual(expect.arrayContaining(['files', 'backlinks', 'graph']));
    const body = JSON.parse(result.body) as {
      kind: string;
      path: string;
      duplicatedDocNames: string[];
    };
    expect(body).toMatchObject({
      kind: 'file',
      path: 'notes copy 2',
      duplicatedDocNames: ['notes copy 2'],
    });
  });

  test('duplicates a folder recursively and reports copied markdown docs', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'archive/old'), { recursive: true });
    writeFileSync(join(dir, 'archive/index.md'), '# Archive\n', 'utf-8');
    writeFileSync(join(dir, 'archive/old/entry.md'), '# Entry\n', 'utf-8');
    writeFileSync(join(dir, 'archive/old/asset.png'), 'png-ish', 'utf-8');
    const signals: string[] = [];

    const result = await callApi(
      dir,
      '/api/duplicate-path',
      'POST',
      {
        kind: 'folder',
        path: 'archive',
      },
      { signalChannel: (channel) => signals.push(channel) },
    );

    expect(result.status).toBe(200);
    expect(readFileSync(join(dir, 'archive copy/index.md'), 'utf-8')).toBe('# Archive\n');
    expect(readFileSync(join(dir, 'archive copy/old/entry.md'), 'utf-8')).toBe('# Entry\n');
    expect(readFileSync(join(dir, 'archive copy/old/asset.png'), 'utf-8')).toBe('png-ish');
    expect(signals).toEqual(expect.arrayContaining(['files', 'backlinks', 'graph']));
    const body = JSON.parse(result.body) as {
      kind: string;
      path: string;
      duplicatedDocNames: string[];
    };
    expect(body.kind).toBe('folder');
    expect(body.path).toBe('archive copy');
    expect(body.duplicatedDocNames).toEqual(['archive copy/index', 'archive copy/old/entry']);
  });

  test('removes a copied folder when duplicate-path post-copy registration fails', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'archive'), { recursive: true });
    writeFileSync(join(dir, 'archive/index.md'), '# Archive\n', 'utf-8');
    const failingBacklinkIndex = {
      updateDocumentFromMarkdown: () => {
        throw new Error('registration failed');
      },
    } as unknown as BacklinkIndex;

    const result = await callApi(
      dir,
      '/api/duplicate-path',
      'POST',
      {
        kind: 'folder',
        path: 'archive',
      },
      { backlinkIndex: failingBacklinkIndex, getFileIndex: () => new Map() },
    );

    expect(result.status).toBe(500);
    expect(existsSync(join(dir, 'archive copy'))).toBe(false);
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:internal-server-error',
      title: 'Failed to duplicate path.',
      status: 500,
    });
  });

  test('removes a copied file when duplicate-path post-copy registration fails', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'notes.md'), '# Notes\n', 'utf-8');
    const failingBacklinkIndex = {
      updateDocumentFromMarkdown: () => {
        throw new Error('registration failed');
      },
    } as unknown as BacklinkIndex;

    const result = await callApi(
      dir,
      '/api/duplicate-path',
      'POST',
      {
        kind: 'file',
        path: 'notes',
      },
      { backlinkIndex: failingBacklinkIndex, getFileIndex: () => new Map() },
    );

    expect(result.status).toBe(500);
    expect(existsSync(join(dir, 'notes copy.md'))).toBe(false);
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:internal-server-error',
      title: 'Failed to duplicate path.',
      status: 500,
    });
  });

  test('forgets a copied file extension when duplicate-path post-copy registration fails', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'notes.mdx'), '# Notes\n', 'utf-8');
    const failingBacklinkIndex = {
      updateDocumentFromMarkdown: () => {
        throw new Error('registration failed');
      },
    } as unknown as BacklinkIndex;

    const result = await callApi(
      dir,
      '/api/duplicate-path',
      'POST',
      {
        kind: 'file',
        path: 'notes',
      },
      { backlinkIndex: failingBacklinkIndex, getFileIndex: () => new Map() },
    );

    expect(result.status).toBe(500);
    expect(existsSync(join(dir, 'notes copy.mdx'))).toBe(false);
    expect(getDocExtension('notes copy')).toBe('.md');
  });

  test('returns 507 when duplicate-path registration hits storage exhaustion', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'archive'), { recursive: true });
    writeFileSync(join(dir, 'archive/index.md'), '# Archive\n', 'utf-8');
    const fullDiskBacklinkIndex = {
      updateDocumentFromMarkdown: () => {
        const err = new Error('no space left on device') as NodeJS.ErrnoException;
        err.code = 'ENOSPC';
        throw err;
      },
    } as unknown as BacklinkIndex;

    const result = await callApi(
      dir,
      '/api/duplicate-path',
      'POST',
      {
        kind: 'folder',
        path: 'archive',
      },
      { backlinkIndex: fullDiskBacklinkIndex, getFileIndex: () => new Map() },
    );

    expect(result.status).toBe(507);
    expect(existsSync(join(dir, 'archive copy'))).toBe(false);
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:storage-full',
      title: 'Could not duplicate path because storage is full.',
      status: 507,
    });
  });

  test('returns 507 when duplicate-path file registration hits storage exhaustion', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'notes.md'), '# Notes\n', 'utf-8');
    const fullDiskBacklinkIndex = {
      updateDocumentFromMarkdown: () => {
        const err = new Error('no space left on device') as NodeJS.ErrnoException;
        err.code = 'ENOSPC';
        throw err;
      },
    } as unknown as BacklinkIndex;

    const result = await callApi(
      dir,
      '/api/duplicate-path',
      'POST',
      {
        kind: 'file',
        path: 'notes',
      },
      { backlinkIndex: fullDiskBacklinkIndex, getFileIndex: () => new Map() },
    );

    expect(result.status).toBe(507);
    expect(existsSync(join(dir, 'notes copy.md'))).toBe(false);
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:storage-full',
      title: 'Could not duplicate path because storage is full.',
      status: 507,
    });
  });

  test('returns actionable storage-readonly when duplicate-path registration hits permissions', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'archive'), { recursive: true });
    writeFileSync(join(dir, 'archive/index.md'), '# Archive\n', 'utf-8');
    const readOnlyBacklinkIndex = {
      updateDocumentFromMarkdown: () => {
        const err = new Error('permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      },
    } as unknown as BacklinkIndex;

    const result = await callApi(
      dir,
      '/api/duplicate-path',
      'POST',
      {
        kind: 'folder',
        path: 'archive',
      },
      { backlinkIndex: readOnlyBacklinkIndex, getFileIndex: () => new Map() },
    );

    expect(result.status).toBe(500);
    expect(existsSync(join(dir, 'archive copy'))).toBe(false);
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:storage-readonly',
      title: 'Could not duplicate path because storage is not writable.',
      status: 500,
    });
  });

  test('returns actionable storage-readonly when duplicate-path file registration hits permissions', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'notes.md'), '# Notes\n', 'utf-8');
    const readOnlyBacklinkIndex = {
      updateDocumentFromMarkdown: () => {
        const err = new Error('permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      },
    } as unknown as BacklinkIndex;

    const result = await callApi(
      dir,
      '/api/duplicate-path',
      'POST',
      {
        kind: 'file',
        path: 'notes',
      },
      { backlinkIndex: readOnlyBacklinkIndex, getFileIndex: () => new Map() },
    );

    expect(result.status).toBe(500);
    expect(existsSync(join(dir, 'notes copy.md'))).toBe(false);
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:storage-readonly',
      title: 'Could not duplicate path because storage is not writable.',
      status: 500,
    });
  });

  test('returns 409 when duplicate-path folder destination appears before copy', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'archive'), { recursive: true });
    writeFileSync(join(dir, 'archive/index.md'), '# Archive\n', 'utf-8');
    const racingContentFilter = {
      isExcluded: () => false,
      isDirExcluded: (relativePath: string) => {
        writeFileSync(join(dir, relativePath), 'occupied', 'utf-8');
        return false;
      },
      isPathIgnored: () => false,
      getWatcherIgnoreGlobs: () => [],
      incrementMdDir: () => {},
      decrementMdDir: () => {},
      getMdDirRefcounts: () => new Map<string, number>(),
    } as ContentFilter;

    const result = await callApi(
      dir,
      '/api/duplicate-path',
      'POST',
      {
        kind: 'folder',
        path: 'archive',
      },
      { contentFilter: racingContentFilter, backlinkIndex: {} as BacklinkIndex },
    );

    expect(result.status).toBe(409);
    expect(existsSync(join(dir, 'archive copy'))).toBe(true);
    expect(existsSync(join(dir, 'archive copy/index.md'))).toBe(false);
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:doc-already-exists',
      title: 'A folder at the duplicate destination already exists.',
      status: 409,
    });
  });

  test('rejects duplicate-path reserved source paths', async () => {
    const dir = setupTmpDir();

    const okResult = await callApi(dir, '/api/duplicate-path', 'POST', {
      kind: 'folder',
      path: '.ok/local',
    });
    const configFolderResult = await callApi(dir, '/api/duplicate-path', 'POST', {
      kind: 'folder',
      path: '__config__',
    });
    const configDocResult = await callApi(dir, '/api/duplicate-path', 'POST', {
      kind: 'file',
      path: '__config__/project',
    });

    for (const result of [okResult, configFolderResult, configDocResult]) {
      expect(result.status).toBe(400);
      expect(JSON.parse(result.body)).toMatchObject({
        type: 'urn:ok:error:reserved-doc-name',
        status: 400,
      });
    }
  });

  test('rejects duplicate-path traversal paths', async () => {
    const dir = setupTmpDir();

    const result = await callApi(dir, '/api/duplicate-path', 'POST', {
      kind: 'file',
      path: '../outside',
    });

    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:invalid-request',
      title: 'path must be a relative content path.',
      status: 400,
    });
  });

  test('returns 404 when duplicate-path source does not exist', async () => {
    const dir = setupTmpDir();

    const result = await callApi(dir, '/api/duplicate-path', 'POST', {
      kind: 'file',
      path: 'ghost',
    });

    expect(result.status).toBe(404);
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:doc-not-found',
      title: 'file does not exist.',
      status: 404,
    });
  });

  test('returns 409 when duplicate-path name slots are exhausted', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'notes.md'), '# Notes\n', 'utf-8');
    for (let attempt = 1; attempt <= 10_000; attempt += 1) {
      const basename = attempt === 1 ? 'notes copy' : `notes copy ${attempt}`;
      writeFileSync(join(dir, `${basename}.md`), '# Occupied\n', 'utf-8');
    }

    const result = await callApi(
      dir,
      '/api/duplicate-path',
      'POST',
      {
        kind: 'file',
        path: 'notes',
      },
      { backlinkIndex: {} as BacklinkIndex, getFileIndex: () => new Map() },
    );

    expect(result.status).toBe(409);
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:doc-already-exists',
      title: 'All available duplicate name slots are occupied for this path.',
      status: 409,
    });
  });

  test('returns 400 when duplicate-path source kind does not match disk', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'myfolder'), { recursive: true });

    const result = await callApi(dir, '/api/duplicate-path', 'POST', {
      kind: 'file',
      path: 'myfolder',
    });

    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:invalid-request',
      title: 'Target path is not a file.',
      status: 400,
    });
  });

  test('rejects duplicate-path requests with non-string summary', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'notes.md'), '# Notes\n', 'utf-8');

    const result = await callApi(dir, '/api/duplicate-path', 'POST', {
      kind: 'file',
      path: 'notes',
      summary: 42,
    });

    expect(result.status).toBe(400);
    expect(existsSync(join(dir, 'notes copy.md'))).toBe(false);
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:invalid-request',
      title: 'Request body is invalid.',
      status: 400,
    });
  });

  test('rejects duplicate-path destinations excluded by content config', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'notes.md'), '# Notes\n', 'utf-8');
    writeFileSync(join(dir, '.okignore'), 'notes copy.md\n', 'utf-8');
    const contentFilter = createContentFilter({ projectDir: dir, contentDir: dir });

    const result = await callApi(
      dir,
      '/api/duplicate-path',
      'POST',
      {
        kind: 'file',
        path: 'notes',
      },
      { contentFilter },
    );

    expect(result.status).toBe(400);
    expect(existsSync(join(dir, 'notes copy.md'))).toBe(false);
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:invalid-request',
      title: 'Duplicated document destination is excluded by the project content config.',
      status: 400,
    });
  });

  test('rejects duplicate-path folder destinations excluded by content config', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'archive'), { recursive: true });
    writeFileSync(join(dir, 'archive/index.md'), '# Archive\n', 'utf-8');
    writeFileSync(join(dir, '.okignore'), 'archive copy/\n', 'utf-8');
    const contentFilter = createContentFilter({ projectDir: dir, contentDir: dir });

    const result = await callApi(
      dir,
      '/api/duplicate-path',
      'POST',
      {
        kind: 'folder',
        path: 'archive',
      },
      { contentFilter },
    );

    expect(result.status).toBe(400);
    expect(existsSync(join(dir, 'archive copy'))).toBe(false);
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:invalid-request',
      title: 'Duplicated folder destination is excluded by the project content config.',
      status: 400,
    });
  });

  test('rejects create-folder without a path', async () => {
    const dir = setupTmpDir();

    const result = await callApi(dir, '/api/create-folder', 'POST', {});

    expect(result.status).toBe(400);
    // RFC 9457 problem+json: missing required field rejected by withValidation
    // surfaces as urn:ok:error:invalid-request with Zod's parse-issue detail.
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:invalid-request',
      status: 400,
    });
  });

  test('rejects create-folder traversal paths', async () => {
    const dir = setupTmpDir();

    const result = await callApi(dir, '/api/create-folder', 'POST', {
      path: '../outside',
    });

    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:invalid-request',
      title: 'path must be a relative content path.',
      status: 400,
    });
  });

  test('rejects create-folder destinations inside .ok even without content filter', async () => {
    const dir = setupTmpDir();

    const result = await callApi(dir, '/api/create-folder', 'POST', {
      path: '.ok/local/cache',
    });

    expect(result.status).toBe(400);
    expect(existsSync(join(dir, '.ok/local/cache'))).toBe(false);
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:reserved-doc-name',
      title: "'.ok' is a reserved directory.",
      status: 400,
    });
  });

  test('rejects create-folder requests with non-string summary', async () => {
    const dir = setupTmpDir();

    const result = await callApi(dir, '/api/create-folder', 'POST', {
      path: 'notes',
      summary: 42,
    });

    expect(result.status).toBe(400);
    expect(existsSync(join(dir, 'notes'))).toBe(false);
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:invalid-request',
      status: 400,
    });
  });

  test('rejects create-folder destinations excluded by content config', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, '.okignore'), 'ignored/\n', 'utf-8');
    const contentFilter = createContentFilter({ projectDir: dir, contentDir: dir });

    const result = await callApi(
      dir,
      '/api/create-folder',
      'POST',
      {
        path: 'ignored/new',
      },
      { contentFilter },
    );

    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:invalid-request',
      title: 'Destination folder is excluded by the workspace content config.',
      status: 400,
    });
  });

  test('rejects create-folder collisions', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'existing'), { recursive: true });

    const result = await callApi(dir, '/api/create-folder', 'POST', {
      path: 'existing',
    });

    expect(result.status).toBe(409);
    expect(JSON.parse(result.body)).toMatchObject({
      type: 'urn:ok:error:doc-already-exists',
      title: 'Folder already exists.',
      status: 409,
    });
  });

  test('lists empty folders from /api/documents', async () => {
    const dir = setupTmpDir();
    const folderIndex = new Map<string, FolderIndexEntry>([
      [
        'empty',
        {
          size: 0,
          modified: '2026-01-01T00:00:00.000Z',
          canonicalPath: join(dir, 'empty'),
          inode: 1,
        },
      ],
    ]);

    const result = await callApi(dir, '/api/documents', 'GET', undefined, {
      getFolderIndex: () => folderIndex,
    });

    expect(result.status).toBe(200);
    // RFC 9457 success body — no `ok` discriminator.
    const body = JSON.parse(result.body) as {
      documents: Array<{ kind: string; path?: string }>;
    };
    expect((body as Record<string, unknown>).ok).toBeUndefined();
    expect(body.documents).toContainEqual(
      expect.objectContaining({ kind: 'folder', path: 'empty' }),
    );
  });

  test('renames an empty folder on disk', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'empty'), { recursive: true });

    const result = await callApi(dir, '/api/rename-path', 'POST', {
      kind: 'folder',
      fromPath: 'empty',
      toPath: 'renamed',
    });

    expect(result.status).toBe(200);
    expect(existsSync(join(dir, 'empty'))).toBe(false);
    expect(existsSync(join(dir, 'renamed'))).toBe(true);
    const body = JSON.parse(result.body) as { renamed: unknown[] };
    expect((body as Record<string, unknown>).ok).toBeUndefined();
    expect(body.renamed).toEqual([]);
  });

  test('deletes an empty folder and reports no deleted docs', async () => {
    const dir = setupTmpDir();
    mkdirSync(join(dir, 'empty'), { recursive: true });

    const result = await callApi(dir, '/api/delete-path', 'POST', {
      kind: 'folder',
      path: 'empty',
    });

    expect(result.status).toBe(200);
    expect(existsSync(join(dir, 'empty'))).toBe(false);
    const body = JSON.parse(result.body) as { deletedDocNames: string[] };
    expect((body as Record<string, unknown>).ok).toBeUndefined();
    expect(body.deletedDocNames).toEqual([]);
  });

  test('rejects traversal attempts', async () => {
    const dir = setupTmpDir();
    writeFileSync(join(dir, 'notes.md'), '# Notes\n', 'utf-8');

    const result = await callApi(dir, '/api/rename-path', 'POST', {
      kind: 'file',
      fromPath: 'notes',
      toPath: '../escape',
    });

    expect(result.status).toBe(400);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body.type).toBe('urn:ok:error:invalid-request');
    expect(body.title).toContain('relative content paths');
  });

  test.skipIf(process.platform === 'win32')(
    'rejects delete when path resolves outside content via symlink',
    async () => {
      const root = setupTmpDir();
      const contentDir = join(root, 'content');
      const outside = join(root, 'outside');
      mkdirSync(contentDir);
      mkdirSync(outside);
      const victim = join(outside, 'victim.md');
      writeFileSync(victim, '# Victim\n', 'utf-8');
      symlinkSync(join('..', 'outside'), join(contentDir, 'evil'), 'dir');

      const result = await callApi(contentDir, '/api/delete-path', 'POST', {
        kind: 'file',
        path: 'evil/victim',
      });

      expect(result.status).toBe(500);
      expect(existsSync(victim)).toBe(true);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'rejects rename into destination that resolves outside content via symlink',
    async () => {
      const root = setupTmpDir();
      const contentDir = join(root, 'content');
      const outside = join(root, 'outside');
      mkdirSync(contentDir);
      mkdirSync(outside);
      symlinkSync(join('..', 'outside'), join(contentDir, 'evil'), 'dir');
      writeFileSync(join(contentDir, 'safe.md'), '# Safe\n', 'utf-8');

      const result = await callApi(contentDir, '/api/rename-path', 'POST', {
        kind: 'file',
        fromPath: 'safe',
        toPath: 'evil/captured',
      });

      expect(result.status).toBe(400);
      expect(readFileSync(join(contentDir, 'safe.md'), 'utf-8')).toBe('# Safe\n');
      expect(existsSync(join(outside, 'captured.md'))).toBe(false);
    },
  );
});
