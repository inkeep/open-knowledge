import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createApiExtension } from './api-extension.test-helper.ts';
import { BacklinkIndex } from './backlink-index.ts';
import { swapContributors } from './contributor-tracker.ts';
import { _resetDocExtensionsForTests } from './doc-extensions.ts';
import type { FileIndexEntry } from './file-watcher.ts';
import { resetMetrics } from './metrics.ts';

interface CapturedResponse {
  status: number;
  body: string;
}

function makeReq(url: string, body: unknown): IncomingMessage {
  const raw = JSON.stringify(body);
  const readable = Readable.from(Buffer.from(raw)) as unknown as IncomingMessage;
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

async function buildBacklinkIndex(contentDir: string): Promise<BacklinkIndex> {
  const index = new BacklinkIndex({ projectDir: contentDir, contentDir });
  await index.rebuildFromDisk();
  return index;
}

function walkFileIndex(contentDir: string, dir: string, index: Map<string, FileIndexEntry>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      walkFileIndex(contentDir, fullPath, index);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md') && !entry.name.endsWith('.mdx')) continue;
    const stat = statSync(fullPath);
    const docName = fullPath.slice(contentDir.length + 1).replace(/\.mdx?$/, '');
    index.set(docName, { size: stat.size, modified: stat.mtime.toISOString() });
  }
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ok-rename-race-'));
  swapContributors();
  resetMetrics();
  _resetDocExtensionsForTests();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Finding 1 — folder-rename enumeration races concurrent index updates', () => {
  test('a doc added to the file index between handler entry and lock entry is included in the rename', async () => {
    mkdirSync(join(tmpDir, 'articles'), { recursive: true });
    writeFileSync(join(tmpDir, 'articles', 'a.md'), '# A\n', 'utf-8');
    writeFileSync(join(tmpDir, 'articles', 'b.md'), '# B\n', 'utf-8');
    writeFileSync(join(tmpDir, 'articles', 'c.md'), '# C\n', 'utf-8');

    const liveIndex = new Map<string, FileIndexEntry>();
    liveIndex.set('articles/a', { size: 4, modified: '2026-01-01' });
    liveIndex.set('articles/b', { size: 4, modified: '2026-01-01' });

    let mutationScheduled = false;
    const scheduleIndexMutation = () => {
      if (mutationScheduled) return;
      mutationScheduled = true;
      queueMicrotask(() => {
        liveIndex.set('articles/c', { size: 4, modified: '2026-01-01' });
      });
    };

    const stubContentFilter = {
      isExcluded: (_p: string) => {
        scheduleIndexMutation();
        return false;
      },
      isDirExcluded: (_p: string) => {
        scheduleIndexMutation();
        return false;
      },
      getWatcherIgnoreGlobs: () => [],
      incrementMdDir: () => {},
      decrementMdDir: () => {},
      getMdDirRefcounts: () => new Map(),
    } as Parameters<typeof createApiExtension>[0]['contentFilter'];

    const ext = createApiExtension({
      hocuspocus: {
        documents: new Map(),
        closeConnections() {},
        unloadDocument: async () => {},
        debouncer: {
          isDebounced: () => false,
          executeNow: async () => undefined,
        },
      } as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
      sessionManager: {
        closeSession: async () => {},
        closeAllForDoc: async () => {},
      } as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
      contentDir: tmpDir,
      getFileIndex: () => liveIndex,
      backlinkIndex: await buildBacklinkIndex(tmpDir),
      contentFilter: stubContentFilter,
    });

    const req = makeReq('/api/rename-path', {
      kind: 'folder',
      fromPath: 'articles',
      toPath: 'essays',
    });
    const { res, captured } = makeRes();
    await (
      ext as {
        onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
      }
    ).onRequest({ request: req, response: res });

    expect(captured.status).toBe(200);
    const body = JSON.parse(captured.body) as {
      renamed: Array<{ fromDocName: string; toDocName: string }>;
    };
    expect(body.renamed.map((r) => r.fromDocName).sort()).toEqual([
      'articles/a',
      'articles/b',
      'articles/c',
    ]);
  });
});

describe('Finding 2 — admission check uses on-disk source extension', () => {
  test('rename of an .mdx file blocked by .mdx-specific exclusion when index is empty', async () => {
    mkdirSync(join(tmpDir, 'articles'), { recursive: true });
    writeFileSync(join(tmpDir, 'articles', 'foo.mdx'), '# Foo\n', 'utf-8');

    const emptyIndex = new Map<string, FileIndexEntry>();

    const stubContentFilter = {
      isExcluded: (path: string) => path.endsWith('.mdx'),
      isDirExcluded: (_p: string) => false,
      getWatcherIgnoreGlobs: () => [],
      incrementMdDir: () => {},
      decrementMdDir: () => {},
      getMdDirRefcounts: () => new Map(),
    } as Parameters<typeof createApiExtension>[0]['contentFilter'];

    const ext = createApiExtension({
      hocuspocus: {
        documents: new Map(),
        closeConnections() {},
        unloadDocument: async () => {},
        debouncer: {
          isDebounced: () => false,
          executeNow: async () => undefined,
        },
      } as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
      sessionManager: {
        closeSession: async () => {},
        closeAllForDoc: async () => {},
      } as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
      contentDir: tmpDir,
      getFileIndex: () => emptyIndex,
      backlinkIndex: await buildBacklinkIndex(tmpDir),
      contentFilter: stubContentFilter,
    });

    const req = makeReq('/api/rename-path', {
      kind: 'file',
      fromPath: 'articles/foo',
      toPath: 'articles/bar',
    });
    const { res, captured } = makeRes();
    await (
      ext as {
        onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
      }
    ).onRequest({ request: req, response: res });

    expect(captured.status).toBe(400);
    const body = JSON.parse(captured.body) as Record<string, unknown>;
    expect(body.type).toBe('urn:ok:error:invalid-request');
    expect(String(body.title)).toContain('excluded');
  });
});

export function _walkFileIndexForTest(
  contentDir: string,
  index: Map<string, FileIndexEntry>,
): void {
  walkFileIndex(contentDir, contentDir, index);
}
