/**
 * Race-window regressions for `/api/rename-path`:
 *
 *  `affectedDocs` enumeration must run inside the same
 *  `runSerialized` critical section that owns the existence/stat checks.
 *  Otherwise a doc that arrives in the source folder between handler entry
 *  and lock acquisition is moved by the directory-level `tracedRenameSync`
 *  but not journaled — leaving a "ghost" file at the destination on
 *  crash-mid-rename + recovery.
 *
 *  admission check must use the source file's actual on-disk
 *  extension. If the file watcher hasn't yet observed the source, the
 *  in-memory extension map returns the `.md` default, which silently
 *  defeats `.mdx`-specific exclusion patterns when both extensions are
 *  present on disk.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { createApiExtension } from './api-extension.ts';
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
    // Pre-rename disk state: articles/ has a, b, AND c — but the in-memory
    // file index initially knows only a and b. The third file simulates a
    // doc the file watcher just registered (e.g. external mv add, MCP
    // write_document landing in the same folder).
    mkdirSync(join(tmpDir, 'articles'), { recursive: true });
    writeFileSync(join(tmpDir, 'articles', 'a.md'), '# A\n', 'utf-8');
    writeFileSync(join(tmpDir, 'articles', 'b.md'), '# B\n', 'utf-8');
    writeFileSync(join(tmpDir, 'articles', 'c.md'), '# C\n', 'utf-8');

    const liveIndex = new Map<string, FileIndexEntry>();
    liveIndex.set('articles/a', { size: 4, modified: '2026-01-01' });
    liveIndex.set('articles/b', { size: 4, modified: '2026-01-01' });

    // Inject a microtask via the contentFilter hook. The handler calls
    // contentFilter.isDirExcluded synchronously between its first await
    // (readBody) and its second await (await runSerialized). The microtask
    // it queues there fires when the second await yields — i.e. AFTER any
    // pre-lock enumeration but BEFORE the in-lock task body runs.
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
    // enumeration ran outside the lock with stale index → only
    // 2 entries. The directory-level mv still moves c.md to essays/, so the
    // journal becomes inconsistent with disk.
    // enumeration runs inside the lock; the just-mutated index
    // is observed; c is journaled and contributes to the response.
    expect(body.renamed.map((r) => r.fromDocName).sort()).toEqual([
      'articles/a',
      'articles/b',
      'articles/c',
    ]);
  });
});

describe('Finding 2 — admission check uses on-disk source extension', () => {
  test('rename of an .mdx file blocked by .mdx-specific exclusion when index is empty', async () => {
    // Reset the doc-extensions map (already done in beforeEach). The file
    // exists on disk as .mdx, but the file watcher has not yet run, so
    // getDocExtension() would return the .md default. Without the disk
    // probe, an .mdx-specific exclusion pattern is silently bypassed.
    mkdirSync(join(tmpDir, 'articles'), { recursive: true });
    writeFileSync(join(tmpDir, 'articles', 'foo.mdx'), '# Foo\n', 'utf-8');

    // Empty file index — simulates the boot/watcher race where the rename
    // handler runs before the watcher has registered foo.
    const emptyIndex = new Map<string, FileIndexEntry>();

    // contentFilter that excludes everything ending in .mdx — exercises
    // the same shape as a real `content.exclude: ['**/private/**.mdx']`
    // pattern.
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

    // getDocExtension('articles/foo') returns '.md' (default),
    // so admission checks 'articles/bar.md' which is admitted. The
    // existsSync inside _performManagedRenameForDocs then probes the same
    // .md path which doesn't exist on disk → 404.
    // probe-and-register sees foo.mdx, admission then checks
    // 'articles/bar.mdx' which is excluded → 400.
    expect(captured.status).toBe(400);
    const body = JSON.parse(captured.body) as Record<string, unknown>;
    expect(body.type).toBe('urn:ok:error:invalid-request');
    expect(String(body.title)).toContain('excluded');
  });
});

// Helper kept alongside in case future tests need it.
export function _walkFileIndexForTest(
  contentDir: string,
  index: Map<string, FileIndexEntry>,
): void {
  walkFileIndex(contentDir, contentDir, index);
}
