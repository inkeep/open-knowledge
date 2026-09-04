import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createApiExtension } from './api-extension.test-helper.ts';
import { _resetDocExtensionsForTests } from './doc-extensions.ts';
import { RecentlyRemovedDocs } from './recently-removed-docs.ts';

type Options = Parameters<typeof createApiExtension>[0];

interface CapturedResponse {
  status: number;
  body: string;
}

function makeReq(url: string, body: unknown): IncomingMessage {
  const readable = Readable.from(Buffer.from(JSON.stringify(body))) as unknown as IncomingMessage;
  readable.method = 'POST';
  readable.url = url;
  readable.headers = { host: 'localhost' };
  return readable;
}

function makeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: '' };
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

function seed(contentDir: string, relPath: string, content: string): void {
  const full = join(contentDir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf-8');
}

function countDocFiles(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) count += countDocFiles(full);
    else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.mdx'))) {
      count += 1;
    }
  }
  return count;
}

async function post(
  ext: ReturnType<typeof createApiExtension>,
  url: string,
  body: unknown,
): Promise<{ status: number; structured: Record<string, unknown> }> {
  const { res, captured } = makeRes();
  await (
    ext as {
      onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request: makeReq(url, body), response: res });
  return { status: captured.status, structured: captured.body ? JSON.parse(captured.body) : {} };
}

const baseHocuspocus = () =>
  ({
    documents: new Map(),
    closeConnections() {},
    unloadDocument: async () => {},
    debouncer: { isDebounced: () => false, executeNow: async () => undefined },
  }) as unknown as Options['hocuspocus'];

let contentDir: string;

beforeEach(() => {
  contentDir = mkdtempSync(join(tmpdir(), 'ok-folder-del-dup-disk-'));
  _resetDocExtensionsForTests();
});

afterEach(() => {
  rmSync(contentDir, { recursive: true, force: true });
});

describe('folder delete enumerates descendant docs from disk', () => {
  test('captures + closes docs and marks them recently-removed despite an empty file index', async () => {
    seed(contentDir, 'del-folder/note.md', '# Note\n\nDirect child.\n');
    seed(contentDir, 'del-folder/deep/leaf.md', '# Leaf\n\nNested child.\n');

    const closedDocs: string[] = [];
    const recentlyRemovedDocs = new RecentlyRemovedDocs();

    const ext = createApiExtension({
      hocuspocus: baseHocuspocus(),
      sessionManager: {
        closeSession: async () => {},
        closeAllForDoc: async (docName: string) => {
          closedDocs.push(docName);
        },
      } as unknown as Options['sessionManager'],
      contentDir,
      getFileIndex: () => new Map(),
      recentlyRemovedDocs,
    });

    const { status, structured } = await post(ext, '/api/delete-path', {
      kind: 'folder',
      path: 'del-folder',
    });

    expect(status).toBe(200);

    expect((structured.deletedDocNames as string[]).slice().sort()).toEqual([
      'del-folder/deep/leaf',
      'del-folder/note',
    ]);

    expect(existsSync(join(contentDir, 'del-folder'))).toBe(false);

    expect(closedDocs.slice().sort()).toEqual(['del-folder/deep/leaf', 'del-folder/note']);
    expect(recentlyRemovedDocs.has('del-folder/note')).toBe(true);
    expect(recentlyRemovedDocs.get('del-folder/note')?.kind).toBe('deleted');
    expect(recentlyRemovedDocs.has('del-folder/deep/leaf')).toBe(true);
    expect(recentlyRemovedDocs.get('del-folder/deep/leaf')?.kind).toBe('deleted');
  });

  test('refuses with 409 when a folder child is in conflict — and resolves a .mdx descendant extension', async () => {
    const conflictBody = [
      '# Page',
      '',
      '<<<<<<< HEAD',
      'ours',
      '=======',
      'theirs',
      '>>>>>>> branch',
      '',
    ].join('\n');
    seed(contentDir, 'del-folder/page.mdx', conflictBody);

    const closedDocs: string[] = [];

    const ext = createApiExtension({
      hocuspocus: baseHocuspocus(),
      sessionManager: {
        closeSession: async () => {},
        closeAllForDoc: async (docName: string) => {
          closedDocs.push(docName);
        },
      } as unknown as Options['sessionManager'],
      contentDir,
      getFileIndex: () => new Map(),
      getSyncEngine: (() => ({
        getConflicts: () => [{ file: 'del-folder/page.mdx' }],
      })) as unknown as Options['getSyncEngine'],
    });

    const { status, structured } = await post(ext, '/api/delete-path', {
      kind: 'folder',
      path: 'del-folder',
    });

    expect(status).toBe(409);
    expect(structured.type).toBe('urn:ok:error:doc-in-conflict');

    expect(existsSync(join(contentDir, 'del-folder/page.mdx'))).toBe(true);
    expect(closedDocs).toEqual([]);
  });
});

describe('folder duplicate conflict gate enumerates from disk', () => {
  test('refuses with 409 when a freshly-created child is in conflict despite an empty file index', async () => {
    const conflictBody = [
      '# Child',
      '',
      '<<<<<<< HEAD',
      'ours',
      '=======',
      'theirs',
      '>>>>>>> branch',
      '',
    ].join('\n');
    seed(contentDir, 'dup-folder/child.md', conflictBody);

    expect(countDocFiles(contentDir)).toBe(1);

    const ext = createApiExtension({
      hocuspocus: baseHocuspocus(),
      sessionManager: {
        closeSession: async () => {},
        closeAllForDoc: async () => {},
      } as unknown as Options['sessionManager'],
      contentDir,
      getFileIndex: () => new Map(),
      getSyncEngine: (() => ({
        getConflicts: () => [{ file: 'dup-folder/child.md' }],
      })) as unknown as Options['getSyncEngine'],
    });

    const { status, structured } = await post(ext, '/api/duplicate-path', {
      kind: 'folder',
      path: 'dup-folder',
    });

    expect(status).toBe(409);
    expect(structured.type).toBe('urn:ok:error:doc-in-conflict');

    expect(countDocFiles(contentDir)).toBe(1);
  });

  test('refuses with 409 for a conflicted .mdx child, resolving its extension via the disk walk', async () => {
    const conflictBody = [
      '# Page',
      '',
      '<<<<<<< HEAD',
      'ours',
      '=======',
      'theirs',
      '>>>>>>> branch',
      '',
    ].join('\n');
    seed(contentDir, 'dup-mdx/page.mdx', conflictBody);

    expect(countDocFiles(contentDir)).toBe(1);

    const ext = createApiExtension({
      hocuspocus: baseHocuspocus(),
      sessionManager: {
        closeSession: async () => {},
        closeAllForDoc: async () => {},
      } as unknown as Options['sessionManager'],
      contentDir,
      getFileIndex: () => new Map(),
      getSyncEngine: (() => ({
        getConflicts: () => [{ file: 'dup-mdx/page.mdx' }],
      })) as unknown as Options['getSyncEngine'],
    });

    const { status, structured } = await post(ext, '/api/duplicate-path', {
      kind: 'folder',
      path: 'dup-mdx',
    });

    expect(status).toBe(409);
    expect(structured.type).toBe('urn:ok:error:doc-in-conflict');
    expect(countDocFiles(contentDir)).toBe(1);
  });
});
