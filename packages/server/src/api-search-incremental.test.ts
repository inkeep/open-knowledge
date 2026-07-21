import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApiExtension } from './api-extension.ts';
import type { FileIndexEntry } from './file-watcher.ts';

// Count how the server maintains the search corpus: `create` = from-scratch
// builds requested directly by the server (cold start), `update` = incremental
// maintenance. `updateWorkspaceSearchCorpus`'s internal fallback rebuild calls
// the module-local `createWorkspaceSearchCorpus`, which this mock does NOT
// intercept — so `create` counts exactly the server's own cold builds.
const corpusCalls = vi.hoisted(() => ({ create: 0, update: 0 }));
vi.mock('@inkeep/open-knowledge-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@inkeep/open-knowledge-core')>();
  return {
    ...actual,
    createWorkspaceSearchCorpus: (
      ...args: Parameters<typeof actual.createWorkspaceSearchCorpus>
    ) => {
      corpusCalls.create += 1;
      return actual.createWorkspaceSearchCorpus(...args);
    },
    updateWorkspaceSearchCorpus: (
      ...args: Parameters<typeof actual.updateWorkspaceSearchCorpus>
    ) => {
      corpusCalls.update += 1;
      return actual.updateWorkspaceSearchCorpus(...args);
    },
  };
});

interface CapturedResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface SearchResultEntry {
  kind: string;
  path: string;
  title: string;
  score: number;
  signals: Record<string, number>;
  snippet?: string;
}

function makeReq(method: string, url: string): IncomingMessage {
  const readable = Readable.from(Buffer.from('')) as unknown as IncomingMessage;
  readable.method = method;
  readable.url = url;
  readable.headers = { host: 'localhost' };
  return readable;
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

/**
 * A persistent extension over a mutable in-memory file index — the shape the
 * production server has (one long-lived extension whose index the file watcher
 * mutates), unlike the per-call throwaway extension in `api-search.test.ts`.
 * `modified` stamps are assigned from a deterministic sequence so every content
 * change also changes the entry fingerprint, mirroring the watcher's behavior.
 */
function createHarness(contentDir: string, options: { withGeneration: boolean }) {
  const index = new Map<string, FileIndexEntry>();
  let generation = 0;
  let stampSeq = 0;
  const nextStamp = () => new Date(1700000000000 + ++stampSeq * 1000).toISOString();

  const ext = createApiExtension({
    hocuspocus: {} as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
    sessionManager: {} as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
    contentDir,
    serverInstanceId: 'test-server',
    getFileIndex: () => index,
    getAllFilesIndex: () => index,
    ...(options.withGeneration ? { getFileIndexGeneration: () => generation } : {}),
  });

  const setDoc = (docName: string, content: string, modified = nextStamp()) => {
    const abs = join(contentDir, `${docName}.md`);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
    index.set(docName, {
      size: Buffer.byteLength(content),
      modified,
      canonicalPath: abs,
      inode: ++stampSeq,
      aliases: [],
      kind: 'markdown',
    });
    generation += 1;
    return modified;
  };

  const setRawEntry = (docName: string, entry: Partial<FileIndexEntry>) => {
    index.set(docName, {
      size: 0,
      modified: nextStamp(),
      canonicalPath: join(contentDir, docName),
      inode: ++stampSeq,
      aliases: [],
      kind: 'markdown',
      ...entry,
    });
    generation += 1;
  };

  const removeDoc = (docName: string) => {
    index.delete(docName);
    generation += 1;
  };

  const search = async (query: string, intent = 'full_text') => {
    const req = makeReq('GET', `/api/search?query=${encodeURIComponent(query)}&intent=${intent}`);
    const { res, captured } = makeRes();
    await (
      ext as {
        onRequest: (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
      }
    ).onRequest({ request: req, response: res });
    expect(captured.status).toBe(200);
    return JSON.parse(captured.body) as { results: SearchResultEntry[]; ready: boolean };
  };

  return { setDoc, setRawEntry, removeDoc, search };
}

describe('incremental workspace search corpus maintenance', () => {
  let contentDir: string;

  beforeEach(() => {
    contentDir = mkdtempSync(join(tmpdir(), 'ok-search-incr-'));
    corpusCalls.create = 0;
    corpusCalls.update = 0;
  });

  afterEach(() => {
    rmSync(contentDir, { recursive: true, force: true });
  });

  test('one cold build, then per-write incremental updates (generation fingerprint)', async () => {
    const harness = createHarness(contentDir, { withGeneration: true });
    harness.setDoc('docs/api', '# API Reference\n\nHTTP endpoint contracts\n');
    harness.setDoc('notes/graphing', '# Graphing Notes\n\nVisual explorer notes\n');

    const cold = await harness.search('endpoint');
    expect(cold.results.map((r) => r.path)).toContain('docs/api');
    expect(corpusCalls).toEqual({ create: 1, update: 0 });

    // Insert: a new doc is searchable without another from-scratch build.
    harness.setDoc('guides/tutorial', '# Tutorial\n\nZebra migration walkthrough\n');
    const afterInsert = await harness.search('zebra');
    expect(afterInsert.results.map((r) => r.path)).toContain('guides/tutorial');
    expect(corpusCalls).toEqual({ create: 1, update: 1 });

    // Update: changed body content is re-indexed; the old tokens are gone.
    harness.setDoc('notes/graphing', '# Graphing Notes\n\nQuokka habitat research\n');
    const afterUpdate = await harness.search('quokka');
    expect(afterUpdate.results.map((r) => r.path)).toContain('notes/graphing');
    // The second search after the same write hits the fingerprint cache — no
    // further corpus work of either kind.
    const oldTokens = await harness.search('explorer');
    expect(oldTokens.results.map((r) => r.path)).not.toContain('notes/graphing');
    expect(corpusCalls).toEqual({ create: 1, update: 2 });

    // Remove: the doc disappears from name and body tiers.
    harness.removeDoc('docs/api');
    const afterRemove = await harness.search('endpoint');
    expect(afterRemove.results.map((r) => r.path)).not.toContain('docs/api');
    expect(corpusCalls).toEqual({ create: 1, update: 3 });
  });

  test('incremental maintenance also runs on the fallback (no-generation) fingerprint', async () => {
    const harness = createHarness(contentDir, { withGeneration: false });
    harness.setDoc('docs/api', '# API\n\nendpoint contracts\n');

    await harness.search('endpoint');
    expect(corpusCalls).toEqual({ create: 1, update: 0 });

    harness.setDoc('guides/new-page', '# New Page\n\nxylophone content\n');
    const results = await harness.search('xylophone');
    expect(results.results.map((r) => r.path)).toContain('guides/new-page');
    expect(corpusCalls).toEqual({ create: 1, update: 1 });
  });

  test('system and config docs added after the cold build never enter the corpus', async () => {
    const harness = createHarness(contentDir, { withGeneration: true });
    harness.setDoc('docs/real-page', '# Real\n\nsystem architecture content\n');
    await harness.search('system');

    // The build-time predicate skips these before any disk read, so the raw
    // entries need no backing file.
    harness.setRawEntry('__system__', {});
    harness.setRawEntry('__config__/project', {});
    // full_text searches name AND body, so this asserts the synthetic names are
    // absent from every tier while the real page still matches on content.
    const results = await harness.search('system', 'full_text');
    const paths = results.results.map((r) => r.path);
    expect(paths).not.toContain('__system__');
    expect(paths).not.toContain('__config__/project');
    expect(paths).toContain('docs/real-page');
  });

  test('after a mixed write burst, results match a from-scratch build of the same workspace', async () => {
    const harness = createHarness(contentDir, { withGeneration: true });
    const stamps = new Map<string, string>();
    stamps.set('docs/api', harness.setDoc('docs/api', '# API\n\nendpoint contracts\n'));
    stamps.set('notes/one', harness.setDoc('notes/one', '# One\n\nalpha bravo crdt\n'));
    stamps.set('notes/two', harness.setDoc('notes/two', '# Two\n\ndelta editor fjord\n'));
    await harness.search('alpha');

    // Burst: update, insert, remove, insert — each interleaved with a search so
    // every step goes through the incremental path rather than one big diff.
    stamps.set('notes/one', harness.setDoc('notes/one', '# One\n\nalpha graph hocus\n'));
    await harness.search('graph');
    stamps.set('guides/four', harness.setDoc('guides/four', '# Four\n\nbravo delta alpha\n'));
    await harness.search('bravo');
    harness.removeDoc('notes/two');
    stamps.delete('notes/two');
    await harness.search('delta');
    stamps.set('guides/five', harness.setDoc('guides/five', '# Five\n\nhocus fjord\n'));
    expect(corpusCalls.create).toBe(1);

    // Reference: an identical workspace (same docNames, contents, and modified
    // stamps) in a fresh contentDir, indexed from scratch by its own harness.
    const referenceDir = mkdtempSync(join(tmpdir(), 'ok-search-ref-'));
    try {
      const reference = createHarness(referenceDir, { withGeneration: true });
      const finalDocs: Array<[string, string]> = [
        ['docs/api', '# API\n\nendpoint contracts\n'],
        ['notes/one', '# One\n\nalpha graph hocus\n'],
        ['guides/four', '# Four\n\nbravo delta alpha\n'],
        ['guides/five', '# Five\n\nhocus fjord\n'],
      ];
      for (const [docName, content] of finalDocs) {
        const stamp = stamps.get(docName);
        if (!stamp) throw new Error(`missing stamp for ${docName}`);
        reference.setDoc(docName, content, stamp);
      }
      for (const query of ['alpha', 'bravo', 'delta', 'fjord', 'graph', 'hocus', 'guides']) {
        for (const intent of ['full_text', 'omnibar'] as const) {
          const incremental = await harness.search(query, intent);
          const fresh = await reference.search(query, intent);
          expect(incremental.results).toEqual(fresh.results);
        }
      }
    } finally {
      rmSync(referenceDir, { recursive: true, force: true });
    }
  });
});
