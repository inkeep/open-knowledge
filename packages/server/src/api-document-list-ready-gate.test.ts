/**
 * Regression test for the cold-start "No files yet" / "Welcome to your LLM
 * brain" flash on the desktop app.
 *
 * The desktop utility posts `ready` to the main process the moment
 * `bootServer()` resolves (port bound), but `bootServer.ready` (= the
 * `initAsync()` promise that completes the file-watcher seed walk) is NOT
 * awaited before the BrowserWindow loads its URL. Without a gate, the
 * renderer's first `/api/documents` fetch raced the seed walk, the handler
 * read an empty `getFileIndex()`, and the client rendered the false empty
 * sidebar + welcome message even though the project had files.
 *
 * `handleDocumentList` now awaits the `ready` option before reading the
 * file/folder index. This test pins that contract: a request that arrives
 * before `ready` resolves does not return until after, and reflects the
 * file index that becomes visible at the moment `ready` settles.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Hocuspocus } from '@hocuspocus/server';
import { createApiExtension } from './api-extension.ts';
import type { FileIndexEntry } from './file-watcher.ts';

function makeReq(url: string): IncomingMessage {
  const readable = Readable.from(Buffer.from('')) as unknown as IncomingMessage;
  readable.method = 'GET';
  readable.url = url;
  readable.headers = { host: 'localhost' };
  return readable;
}

interface CapturedResponse {
  status: number;
  body: string;
  finishedAt: number | null;
}

function makeRes(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: '', finishedAt: null };
  const res = {
    writeHead(status: number) {
      captured.status = status;
    },
    end(body?: string) {
      captured.body = body ?? '';
      captured.finishedAt = Date.now();
    },
  } as unknown as ServerResponse;
  return { res, captured };
}

describe('handleDocumentList ready gating', () => {
  test('parks the response until the ready promise resolves', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ok-ready-gate-'));
    try {
      // Two markdown files on disk; the file index starts empty (mimicking
      // the cold-start race) and is "populated" at the same moment we
      // resolve `ready` further down.
      mkdirSync(tmp, { recursive: true });
      writeFileSync(join(tmp, 'log.md'), '# Log\n', 'utf-8');
      writeFileSync(join(tmp, 'notes.md'), '# Notes\n', 'utf-8');

      const fileIndex = new Map<string, FileIndexEntry>();
      let resolveReady!: () => void;
      const ready = new Promise<void>((res) => {
        resolveReady = res;
      });

      const hocuspocus = new Hocuspocus({ quiet: true });
      const ext = createApiExtension({
        hocuspocus,
        sessionManager: {
          closeSession: async () => {},
          closeAllForDoc: async () => {},
        } as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
        contentDir: tmp,
        getFileIndex: () => fileIndex,
        getFolderIndex: () => new Map(),
        serverInstanceId: 'test-instance',
        ready,
      });

      const req = makeReq('/api/documents');
      const { res, captured } = makeRes();

      // Fire the request without awaiting. It must NOT settle until `ready`
      // resolves — otherwise the renderer would see `documents: []` and
      // render the false empty state.
      const requestPromise = (
        ext as {
          onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
        }
      ).onRequest({ request: req, response: res });

      // Give the handler a tick to enter the await — if it returned without
      // awaiting `ready` we would already see `finishedAt` set here.
      await new Promise((r) => setTimeout(r, 50));
      expect(captured.finishedAt).toBeNull();

      // Populate the index "as initAsync would" and unblock the gate.
      fileIndex.set('log', {
        size: 7,
        modified: new Date().toISOString(),
        canonicalPath: join(tmp, 'log.md'),
        inode: 0,
        aliases: [],
        kind: 'markdown',
      });
      fileIndex.set('notes', {
        size: 9,
        modified: new Date().toISOString(),
        canonicalPath: join(tmp, 'notes.md'),
        inode: 0,
        aliases: [],
        kind: 'markdown',
      });
      resolveReady();

      await requestPromise;

      expect(captured.status).toBe(200);
      const body = JSON.parse(captured.body) as {
        documents: Array<{ kind: string; docName?: string }>;
      };
      const docNames = body.documents
        .filter((d) => d.kind === 'document')
        .map((d) => d.docName)
        .sort();
      expect(docNames).toEqual(['log', 'notes']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // `/api/documents` is the omnibar + tree data source and
  // must surface every ContentFilter-passing file via `getAllFilesIndex()` —
  // not just the markdown subset. Pin: a non-markdown index entry shows up as
  // a `kind:'file'` row, not as a missing entry or coerced into 'document'.
  test('emits kind:file rows for non-markdown index entries via getAllFilesIndex', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ok-document-list-file-kind-'));
    try {
      mkdirSync(tmp, { recursive: true });
      const now = new Date().toISOString();
      const fileIndex = new Map<string, FileIndexEntry>([
        [
          'notes/page',
          {
            size: 9,
            modified: now,
            canonicalPath: join(tmp, 'notes/page.md'),
            inode: 0,
            aliases: [],
            kind: 'markdown',
          },
        ],
        [
          'data/example.csv',
          {
            size: 64,
            modified: now,
            canonicalPath: join(tmp, 'data/example.csv'),
            inode: 1,
            aliases: [],
            kind: 'file',
          },
        ],
      ]);

      const hocuspocus = new Hocuspocus({ quiet: true });
      const ext = createApiExtension({
        hocuspocus,
        sessionManager: {
          closeSession: async () => {},
          closeAllForDoc: async () => {},
        } as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
        contentDir: tmp,
        // markdown-only view: drops the kind:'file' row, matching the
        // production `markdownIndexView` filter.
        getFileIndex: () => {
          const view = new Map<string, FileIndexEntry>();
          for (const [k, v] of fileIndex) if (v.kind === 'markdown') view.set(k, v);
          return view;
        },
        // all-files view: returns BOTH kinds — this is the allowlisted opt-in
        // `handleDocumentList` now consumes (keystone).
        getAllFilesIndex: () => fileIndex,
        getFolderIndex: () => new Map(),
        serverInstanceId: 'test-instance',
      });

      const req = makeReq('/api/documents');
      const { res, captured } = makeRes();
      await (
        ext as {
          onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
        }
      ).onRequest({ request: req, response: res });

      expect(captured.status).toBe(200);
      const body = JSON.parse(captured.body) as {
        documents: Array<{
          kind: string;
          docName?: string;
          path?: string;
          assetExt?: string;
        }>;
      };
      const documents = body.documents;
      expect(documents.filter((d) => d.kind === 'document').map((d) => d.docName)).toEqual([
        'notes/page',
      ]);
      const fileRows = documents.filter((d) => d.kind === 'file');
      expect(fileRows).toEqual([
        expect.objectContaining({
          kind: 'file',
          docName: 'data/example.csv',
          path: 'data/example.csv',
          assetExt: 'csv',
        }),
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('responds normally when ready is omitted (test-construction path)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ok-ready-gate-'));
    try {
      mkdirSync(tmp, { recursive: true });
      const fileIndex = new Map<string, FileIndexEntry>([
        [
          'only',
          {
            size: 4,
            modified: new Date().toISOString(),
            canonicalPath: join(tmp, 'only.md'),
            inode: 0,
            aliases: [],
            kind: 'markdown',
          },
        ],
      ]);

      const hocuspocus = new Hocuspocus({ quiet: true });
      const ext = createApiExtension({
        hocuspocus,
        sessionManager: {
          closeSession: async () => {},
          closeAllForDoc: async () => {},
        } as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
        contentDir: tmp,
        getFileIndex: () => fileIndex,
        getFolderIndex: () => new Map(),
        serverInstanceId: 'test-instance',
      });

      const req = makeReq('/api/documents');
      const { res, captured } = makeRes();
      await (
        ext as {
          onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
        }
      ).onRequest({ request: req, response: res });

      expect(captured.status).toBe(200);
      const body = JSON.parse(captured.body) as {
        documents: Array<{ kind: string; docName?: string }>;
      };
      expect(body.documents.filter((d) => d.kind === 'document').map((d) => d.docName)).toEqual([
        'only',
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
