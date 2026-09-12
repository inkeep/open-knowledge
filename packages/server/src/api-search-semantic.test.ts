import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  createWorkspaceSearchDocument,
  type SemanticProviderErrorReason,
  type SemanticQueryOutcome,
} from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { createApiExtension } from './api-extension.test-helper.ts';
import { createConceptEmbedder, type Embedder, SemanticSearchService } from './embeddings/index.ts';
import type { FileIndexEntry } from './file-watcher.ts';

const CONCEPTS = [
  { id: 'auth', terms: ['auth', 'credential', 'session token', 'login', 'secret', 'sign-in'] },
  { id: 'retry', terms: ['retry', 'retries', 'refresh', 're-issue', 'rotation', 'backoff'] },
  { id: 'bread', terms: ['bread', 'sourdough', 'ferment', 'dough'] },
];

const FILES: Record<string, string> = {
  'guides/credential-rotation.md':
    '# Credential Rotation\n\nThe credential rotation flow re-issues secrets when they expire.\n',
  'recipes/sourdough.md': '# Sourdough\n\nA recipe for sourdough bread with a long cold ferment.\n',
  'auth/login.md': '# Login\n\nThe login page authenticates a user and starts a session.\n',
};

interface CapturedResponse {
  status: number;
  body: string;
}
interface SearchRow {
  kind: string;
  path: string;
  signals: { lexical: number; fullText: number; recency: number; vector?: number };
}
interface SearchBody {
  results?: SearchRow[];
  semantic?: {
    capable: boolean;
    applied: boolean;
    outcome: SemanticQueryOutcome;
    providerErrorReason?: SemanticProviderErrorReason | null;
    coverage: { embedded: number; total: number };
  };
}

function makeReq(method: string, url: string, body = ''): IncomingMessage {
  const readable = Readable.from(Buffer.from(body)) as unknown as IncomingMessage;
  readable.method = method;
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

function buildFileIndex(dir: string, base = ''): ReadonlyMap<string, FileIndexEntry> {
  const index = new Map<string, FileIndexEntry>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const [k, v] of buildFileIndex(join(dir, entry.name), rel)) index.set(k, v);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const stat = statSync(join(dir, entry.name));
      index.set(rel.slice(0, -3), {
        size: stat.size,
        modified: stat.mtime.toISOString(),
        canonicalPath: join(dir, entry.name),
        inode: stat.ino,
        aliases: [],
      });
    }
  }
  return index;
}

function seed(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ok-sem-search-'));
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }
  return dir;
}

async function makeService(
  fileIndex: ReadonlyMap<string, FileIndexEntry>,
  opts: { enabled: boolean; embedder?: Embedder | null },
): Promise<SemanticSearchService> {
  const embedder =
    opts.embedder === undefined ? createConceptEmbedder({ concepts: CONCEPTS }) : opts.embedder;
  const service = new SemanticSearchService({
    loadEmbedder: () => Promise.resolve(embedder),
    cacheDir: null,
    enabled: opts.enabled,
  });
  const docs = [...fileIndex].map(([docName, entry]) =>
    createWorkspaceSearchDocument({
      kind: 'page',
      path: docName,
      content: readFileSync(entry.canonicalPath, 'utf-8'),
      modifiedTs: Date.parse(entry.modified),
    }),
  );
  await service.embedCorpus(docs);
  return service;
}

async function searchPost(
  contentDir: string,
  fileIndex: ReadonlyMap<string, FileIndexEntry>,
  bodyObj: Record<string, unknown>,
  service?: SemanticSearchService,
): Promise<SearchBody> {
  const ext = createApiExtension({
    hocuspocus: {} as unknown as Parameters<typeof createApiExtension>[0]['hocuspocus'],
    sessionManager: {} as unknown as Parameters<typeof createApiExtension>[0]['sessionManager'],
    contentDir,
    serverInstanceId: 'test-server',
    getFileIndex: () => fileIndex,
    semanticSearch: service,
  });
  const req = makeReq('POST', '/api/search', JSON.stringify(bodyObj));
  const { res, captured } = makeRes();
  await (
    ext as {
      onRequest: (c: { request: IncomingMessage; response: ServerResponse }) => Promise<void>;
    }
  ).onRequest({ request: req, response: res });
  expect(captured.status).toBe(200);
  return JSON.parse(captured.body) as SearchBody;
}

describe('POST /api/search — semantic (opt-in)', () => {
  test('semantic:true surfaces a zero-token-overlap doc via vector + carries signals.vector', async () => {
    const dir = seed();
    try {
      const fileIndex = buildFileIndex(dir);
      const service = await makeService(fileIndex, { enabled: true });
      const { results, semantic } = await searchPost(
        dir,
        fileIndex,
        { query: 'auth retries', intent: 'full_text', semantic: true },
        service,
      );
      const rotation = results?.find((r) => r.path === 'guides/credential-rotation');
      expect(
        rotation,
        'zero-overlap doc must be retrieved via the vector candidate source',
      ).toBeDefined();
      expect(typeof rotation?.signals.vector).toBe('number');
      expect(rotation?.signals.vector ?? 0).toBeGreaterThan(0.3);
      expect(semantic?.capable).toBe(true);
      expect(semantic?.applied).toBe(true);
      expect(semantic?.outcome).toBe('applied');
      expect(semantic?.coverage.total).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the omnibar deliberate "by meaning" submit (semantic + source) fuses vector', async () => {
    const dir = seed();
    try {
      const fileIndex = buildFileIndex(dir);
      const service = await makeService(fileIndex, { enabled: true });
      const { results, semantic } = await searchPost(
        dir,
        fileIndex,
        { query: 'auth retries', intent: 'full_text', semantic: true, source: 'omnibar' },
        service,
      );
      expect(results?.find((r) => r.path === 'guides/credential-rotation')).toBeDefined();
      expect(semantic?.applied).toBe(true);
      expect(semantic?.outcome).toBe('applied');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the omnibar per-keystroke call (no semantic field) stays lexical and byte-identical', async () => {
    const dir = seed();
    try {
      const fileIndex = buildFileIndex(dir);
      const service = await makeService(fileIndex, { enabled: true });
      const { results, semantic } = await searchPost(
        dir,
        fileIndex,
        { query: 'auth retries', intent: 'full_text', source: 'omnibar' },
        service,
      );
      expect(results?.find((r) => r.path === 'guides/credential-rotation')).toBeUndefined();
      for (const r of results ?? []) expect('vector' in r.signals).toBe(false);
      expect(semantic).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('semantic:false forces lexical — the zero-overlap doc disappears, no block', async () => {
    const dir = seed();
    try {
      const fileIndex = buildFileIndex(dir);
      const service = await makeService(fileIndex, { enabled: true });
      const { results, semantic } = await searchPost(
        dir,
        fileIndex,
        { query: 'auth retries', intent: 'full_text', semantic: false },
        service,
      );
      expect(results?.find((r) => r.path === 'guides/credential-rotation')).toBeUndefined();
      for (const r of results ?? []) expect('vector' in r.signals).toBe(false);
      expect(semantic).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('with no semantic service the response is pure lexical (no vector, no block)', async () => {
    const dir = seed();
    try {
      const fileIndex = buildFileIndex(dir);
      const { results, semantic } = await searchPost(dir, fileIndex, {
        query: 'auth retries',
        intent: 'full_text',
        semantic: true,
      });
      for (const r of results ?? []) expect('vector' in r.signals).toBe(false);
      expect(results?.find((r) => r.path === 'guides/credential-rotation')).toBeUndefined();
      expect(semantic).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a first semantic search reports warming while the provider initializes', async () => {
    const dir = seed();
    const loader = Promise.withResolvers<Embedder | null>();
    try {
      const fileIndex = buildFileIndex(dir);
      const service = new SemanticSearchService({
        loadEmbedder: () => loader.promise,
        cacheDir: null,
        enabled: true,
      });
      const { results, semantic } = await searchPost(
        dir,
        fileIndex,
        { query: 'auth retries', intent: 'full_text', semantic: true },
        service,
      );
      expect((results ?? []).length).toBeGreaterThan(0);
      expect(semantic).toMatchObject({
        capable: false,
        applied: false,
        outcome: 'warming',
        coverage: { embedded: 0, total: 3 },
      });
    } finally {
      loader.resolve(null);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a sub-min-length query stays lexical even when opted in (gated, block still present)', async () => {
    const dir = seed();
    try {
      const fileIndex = buildFileIndex(dir);
      const service = await makeService(fileIndex, { enabled: true });
      const { results, semantic } = await searchPost(
        dir,
        fileIndex,
        { query: 'au', intent: 'full_text', semantic: true },
        service,
      );
      for (const r of results ?? []) expect('vector' in r.signals).toBe(false);
      expect(semantic?.applied).toBe(false);
      expect(semantic?.outcome).toBe('query_too_short');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an incapable backend degrades to lexical without error (block reports not capable)', async () => {
    const dir = seed();
    try {
      const fileIndex = buildFileIndex(dir);
      const service = await makeService(fileIndex, { enabled: true, embedder: null });
      const { results, semantic } = await searchPost(
        dir,
        fileIndex,
        { query: 'auth retries', intent: 'full_text', semantic: true },
        service,
      );
      expect((results ?? []).length).toBeGreaterThan(0);
      for (const r of results ?? []) expect('vector' in r.signals).toBe(false);
      expect(semantic?.capable).toBe(false);
      expect(semantic?.applied).toBe(false);
      expect(semantic?.outcome).toBe('incapable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a query provider failure is distinct from no semantic match', async () => {
    const dir = seed();
    try {
      const fileIndex = buildFileIndex(dir);
      const inner = createConceptEmbedder({ concepts: CONCEPTS });
      const failingQueries: Embedder = {
        ...inner,
        embed: (texts, opts) =>
          opts.role === 'query'
            ? Promise.reject(new Error('provider down'))
            : inner.embed(texts, opts),
      };
      const service = await makeService(fileIndex, {
        enabled: true,
        embedder: failingQueries,
      });
      const { results, semantic } = await searchPost(
        dir,
        fileIndex,
        { query: 'auth retries', intent: 'full_text', semantic: true },
        service,
      );
      expect((results ?? []).length).toBeGreaterThan(0);
      expect(semantic).toMatchObject({
        capable: true,
        applied: false,
        outcome: 'provider_error',
        providerErrorReason: 'query',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a partial corpus failure does not replace a no-match query outcome', async () => {
    const dir = seed();
    try {
      let failDocuments = false;
      const inner = createConceptEmbedder({ concepts: CONCEPTS });
      const failingCorpus: Embedder = {
        ...inner,
        embed: (texts, opts) => {
          if (opts.role === 'document' && failDocuments) {
            return Promise.reject(new Error('corpus provider down'));
          }
          if (opts.role === 'query' && failDocuments) {
            return Promise.resolve([]);
          }
          return inner.embed(texts, opts);
        },
      };
      let fileIndex = buildFileIndex(dir);
      const service = await makeService(fileIndex, { enabled: true, embedder: failingCorpus });

      failDocuments = true;
      const updatedAt = new Date(Date.now() + 1000);
      for (const [rel, content] of Object.entries(FILES)) {
        const path = join(dir, rel);
        writeFileSync(path, `${content}\nUpdated.\n`, 'utf-8');
        utimesSync(path, updatedAt, updatedAt);
      }
      fileIndex = buildFileIndex(dir);
      const changedDocs = [...fileIndex].map(([docName, entry]) =>
        createWorkspaceSearchDocument({
          kind: 'page',
          path: docName,
          content: readFileSync(entry.canonicalPath, 'utf-8'),
          modifiedTs: Date.parse(entry.modified),
        }),
      );
      await service.embedCorpus(changedDocs);
      expect(service.getStatus().providerErrorReason).toBe('corpus');

      const { semantic } = await searchPost(
        dir,
        fileIndex,
        { query: 'zzzxxyy unique', intent: 'full_text', semantic: true },
        service,
      );

      expect(semantic).toMatchObject({
        capable: true,
        applied: false,
        outcome: 'no_match',
        providerErrorReason: 'corpus',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('semantic does not apply to omnibar intent even when opted in', async () => {
    const dir = seed();
    try {
      const fileIndex = buildFileIndex(dir);
      const service = await makeService(fileIndex, { enabled: true });
      const { results } = await searchPost(
        dir,
        fileIndex,
        { query: 'auth retries', intent: 'omnibar', semantic: true },
        service,
      );
      for (const r of results ?? []) expect('vector' in r.signals).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
