import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorkspaceSearchDocument,
  type WorkspaceSearchDocument,
} from '@inkeep/open-knowledge-core';
import { describe, expect, test, vi } from 'vitest';
import { getLogger } from '../logger.ts';
import { CHUNK_CONFIG_ID } from './chunking.ts';
import { createConceptEmbedder } from './concept-embedder.ts';
import { createOpenAiEmbedder, type Embedder, EmbeddingDimsMismatchError } from './embedder.ts';
import { SemanticSearchService } from './semantic-search-service.ts';
import { VectorCache } from './vector-cache.ts';

const concepts = [
  { id: 'auth', terms: ['auth', 'authentication', 'session token', 'credential', 'login'] },
  { id: 'retry', terms: ['retry', 'retries', 'backoff', 're-issue', 'refresh'] },
  { id: 'bread', terms: ['bread', 'sourdough', 'ferment'] },
];

function doc(path: string, content: string, modifiedTs = 1): WorkspaceSearchDocument {
  return createWorkspaceSearchDocument({ kind: 'page', path, title: path, content, modifiedTs });
}

function makeService(over: Partial<{ embedder: Embedder | null; enabled: boolean }> = {}) {
  const embedder =
    over.embedder === undefined ? createConceptEmbedder({ concepts }) : over.embedder;
  return new SemanticSearchService({
    loadEmbedder: () => Promise.resolve(embedder),
    cacheDir: null,
    enabled: over.enabled ?? false,
  });
}

const corpus = [
  doc('session-tokens', 'The session token refresh flow re-issues credentials when they expire.'),
  doc('sourdough', 'A recipe for sourdough bread with a long cold ferment.'),
];

describe('SemanticSearchService', () => {
  test('disabled service is inert: queryScores returns null, no warm, no key read', async () => {
    let loaded = false;
    const svc = new SemanticSearchService({
      loadEmbedder: () => {
        loaded = true;
        return Promise.resolve(createConceptEmbedder({ concepts }));
      },
      cacheDir: null,
      enabled: false,
    });
    await svc.embedCorpus(corpus);
    expect(await svc.queryScores('auth retries', corpus)).toBeNull();
    expect(svc.getStatus().ready).toBe(false);
    expect(loaded).toBe(false);
  });

  test('queryScores returns null before any corpus is embedded (cold)', async () => {
    const svc = makeService({ enabled: true });
    await svc.ensureWarm();
    expect(await svc.queryScores('auth retries', corpus)).toBeNull();
  });

  test('embedded corpus yields a high cosine for a zero-token-overlap concept match', async () => {
    const svc = makeService({ enabled: true });
    await svc.embedCorpus(corpus);
    const scores = await svc.queryScores('auth retries', corpus);
    expect(scores).not.toBeNull();
    const tokenDoc = scores?.get('page:session-tokens') ?? -1;
    const breadDoc = scores?.get('page:sourdough') ?? -1;
    expect(tokenDoc).toBeGreaterThan(0.4);
    expect(tokenDoc).toBeGreaterThan(breadDoc + 0.2);
  });

  test('no key (loadEmbedder → null) degrades: capable=false, queryScores null', async () => {
    const svc = makeService({ embedder: null, enabled: true });
    await svc.embedCorpus(corpus);
    expect(svc.getStatus().capable).toBe(false);
    expect(svc.getStatus().ready).toBe(true);
    expect(await svc.queryScores('auth retries', corpus)).toBeNull();
  });

  test('incremental: unchanged docs are not re-embedded (mtime pre-filter)', async () => {
    let embedCalls = 0;
    const inner = createConceptEmbedder({ concepts });
    const counting: Embedder = {
      providerId: inner.providerId,
      modelId: inner.modelId,
      dims: inner.dims,
      embed: (texts, opts) => {
        if (opts.role === 'document') embedCalls += texts.length;
        return inner.embed(texts, opts);
      },
    };
    const svc = new SemanticSearchService({
      loadEmbedder: () => Promise.resolve(counting),
      cacheDir: null,
      enabled: true,
    });
    await svc.embedCorpus(corpus);
    const firstPass = embedCalls;
    expect(firstPass).toBeGreaterThan(0);
    await svc.embedCorpus(corpus);
    expect(embedCalls).toBe(firstPass);
    const changed = [
      doc('session-tokens', 'Completely different text about login flows.', 2),
      corpus[1],
    ];
    await svc.embedCorpus(changed);
    expect(embedCalls).toBeGreaterThan(firstPass);
  });

  test('coverage grows as docs embed (status.embeddedCount)', async () => {
    const svc = makeService({ enabled: true });
    expect(svc.getStatus().embeddedCount).toBe(0);
    await svc.embedCorpus(corpus);
    expect(svc.getStatus().embeddedCount).toBe(2);
  });

  test('partial failure: a bad doc is isolated; its batch-mates still embed', async () => {
    const inner = createConceptEmbedder({ concepts });
    const flaky: Embedder = {
      providerId: inner.providerId,
      modelId: inner.modelId,
      dims: inner.dims,
      embed: (texts, opts) => {
        if (texts.some((t) => t.includes('POISON'))) {
          return Promise.reject(new Error('provider rejected input'));
        }
        return inner.embed(texts, opts);
      },
    };
    const svc = new SemanticSearchService({
      loadEmbedder: () => Promise.resolve(flaky),
      cacheDir: null,
      enabled: true,
    });
    const mixed = [
      doc('good-1', 'session token authentication credential'),
      doc('bad', 'POISON content the provider chokes on'),
      doc('good-2', 'sourdough bread cold ferment'),
    ];
    await svc.embedCorpus(mixed);
    expect(svc.getStatus()).toMatchObject({ embeddedCount: 2, providerError: false });
    const scores = await svc.queryScores('authentication login session', mixed);
    expect(scores?.has('page:good-1')).toBe(true);
    expect(scores?.has('page:bad')).toBe(false);
  });

  test('one failed incremental document does not report a provider outage', async () => {
    const inner = createConceptEmbedder({ concepts });
    let failDocuments = false;
    const flaky: Embedder = {
      ...inner,
      embed: (texts, opts) => {
        if (opts.role === 'document' && failDocuments) {
          return Promise.reject(new Error('transient failure'));
        }
        return inner.embed(texts, opts);
      },
    };
    const svc = new SemanticSearchService({
      loadEmbedder: () => Promise.resolve(flaky),
      cacheDir: null,
      enabled: true,
    });

    await svc.embedCorpus(corpus);
    failDocuments = true;
    await svc.embedCorpus([doc('session-tokens', 'Updated session token handling.', 2), corpus[1]]);

    expect(svc.getStatus()).toMatchObject({ embeddedCount: 2, providerError: false });
  });

  test('query-path provider error degrades to lexical (queryScores → null, no throw)', async () => {
    const inner = createConceptEmbedder({ concepts });
    let failQueries = false;
    const flaky: Embedder = {
      providerId: inner.providerId,
      modelId: inner.modelId,
      dims: inner.dims,
      embed: (texts, opts) => {
        if (opts.role === 'query' && failQueries) return Promise.reject(new Error('provider down'));
        return inner.embed(texts, opts);
      },
    };
    const svc = new SemanticSearchService({
      loadEmbedder: () => Promise.resolve(flaky),
      cacheDir: null,
      enabled: true,
    });
    await svc.embedCorpus(corpus);
    expect(await svc.queryScores('auth retries', corpus)).not.toBeNull();
    expect(svc.getStatus().providerError).toBe(false);
    failQueries = true;
    expect(await svc.queryScores('auth retries', corpus)).toBeNull();
    expect(svc.getStatus()).toMatchObject({
      providerError: true,
      providerErrorReason: 'query',
    });
    failQueries = false;
    expect(await svc.queryScores('auth retries', corpus)).not.toBeNull();
    expect(svc.getStatus().providerError).toBe(false);
  });

  test('two independently batched corpus failures report an outage and a query failure supersedes it', async () => {
    const inner = createConceptEmbedder({ concepts });
    let failDocuments = false;
    let failQueries = false;
    let failedDocumentRequests = 0;
    const flaky: Embedder = {
      ...inner,
      embed: (texts, opts) => {
        if (opts.role === 'document' && failDocuments) {
          failedDocumentRequests += 1;
          return Promise.reject(new Error('provider down'));
        }
        if (opts.role === 'query' && failQueries) return Promise.reject(new Error('query down'));
        return inner.embed(texts, opts);
      },
    };
    const svc = new SemanticSearchService({
      loadEmbedder: () => Promise.resolve(flaky),
      cacheDir: null,
      enabled: true,
      maxBatchSize: 1,
    });

    await svc.embedCorpus(corpus);
    failDocuments = true;
    const updated = corpus.map((item) => doc(item.path, `${item.content} updated`, 2));
    await svc.embedCorpus(updated);
    expect(failedDocumentRequests).toBe(2);
    expect(svc.getStatus()).toMatchObject({
      embeddedCount: corpus.length,
      providerError: true,
      providerErrorReason: 'corpus',
    });

    failQueries = true;
    expect(await svc.queryScores('auth retries', updated)).toBeNull();
    expect(svc.getStatus()).toMatchObject({
      providerError: true,
      providerErrorReason: 'query',
    });

    failDocuments = false;
    failQueries = false;
    await svc.embedCorpus(updated);
    expect(await svc.queryScores('auth retries', updated)).not.toBeNull();
    expect(svc.getStatus()).toMatchObject({
      embeddedCount: corpus.length,
      providerError: false,
    });
  });

  test('a concurrent query failure cannot overwrite a terminal configured-dimensions failure', async () => {
    const inner = createConceptEmbedder({ concepts });
    let fail = false;
    const queryStarted = Promise.withResolvers<void>();
    const releaseQuery = Promise.withResolvers<void>();
    const heterogeneous: Embedder = {
      ...inner,
      embed: async (texts, opts) => {
        if (!fail) return inner.embed(texts, opts);
        if (opts.role === 'document') {
          throw new EmbeddingDimsMismatchError(inner.dims ?? 1536, (inner.dims ?? 1536) + 1);
        }
        queryStarted.resolve();
        await releaseQuery.promise;
        throw new Error('query provider down');
      },
    };
    const svc = new SemanticSearchService({
      loadEmbedder: () => Promise.resolve(heterogeneous),
      cacheDir: null,
      enabled: true,
    });
    await svc.embedCorpus(corpus);

    fail = true;
    const query = svc.queryScores('auth retries', corpus);
    await queryStarted.promise;
    await svc.embedCorpus(corpus.map((item) => doc(item.path, `${item.content} updated`, 2)));
    expect(svc.getStatus()).toMatchObject({
      capable: false,
      providerErrorReason: 'configured_dimensions',
    });

    releaseQuery.resolve();
    await expect(query).resolves.toBeNull();
    expect(svc.getStatus()).toMatchObject({
      capable: false,
      providerErrorReason: 'configured_dimensions',
    });
  });

  test('a warm provider failure reloads the provider on retry', async () => {
    const inner = createConceptEmbedder({ concepts });
    let failWarm = true;
    const loadEmbedder = vi.fn(() => {
      if (failWarm) return Promise.reject(new Error('provider down'));
      return Promise.resolve(inner);
    });
    const svc = new SemanticSearchService({ loadEmbedder, cacheDir: null, enabled: true });

    await svc.embedCorpus(corpus);
    expect(svc.getStatus()).toMatchObject({
      ready: true,
      capable: false,
      providerError: true,
      providerErrorReason: 'warm',
    });

    failWarm = false;
    await svc.embedCorpus(corpus);
    expect(loadEmbedder).toHaveBeenCalledTimes(2);
    expect(svc.getStatus()).toMatchObject({
      ready: true,
      capable: true,
      embeddedCount: corpus.length,
      providerError: false,
    });
  });

  test('applyConfig disable frees in-memory vectors; re-enable re-warms', async () => {
    const svc = makeService({ enabled: true });
    await svc.embedCorpus(corpus);
    expect(svc.getStatus().embeddedCount).toBe(2);
    svc.applyConfig({
      enabled: false,
      providerFingerprint: '',
      transportFingerprint: '',
      maxBatchSize: 96,
    });
    expect(svc.getStatus().embeddedCount).toBe(0);
    expect(await svc.queryScores('auth retries', corpus)).toBeNull();
    svc.applyConfig({
      enabled: true,
      providerFingerprint: '',
      transportFingerprint: '',
      maxBatchSize: 96,
    });
    await svc.embedCorpus(corpus);
    expect(svc.getStatus().embeddedCount).toBe(2);
  });

  test('reloadCredential re-warms so a key set after warming takes effect', async () => {
    let loads = 0;
    const svc = new SemanticSearchService({
      loadEmbedder: () => {
        loads += 1;
        return Promise.resolve(createConceptEmbedder({ concepts }));
      },
      cacheDir: null,
      enabled: true,
    });
    await svc.ensureWarm();
    expect(loads).toBe(1);
    expect(svc.getStatus().capable).toBe(true);

    svc.reloadCredential();
    expect(svc.getStatus().capable).toBe(false);
    await svc.ensureWarm();
    expect(loads).toBe(2);
    expect(svc.getStatus().capable).toBe(true);
  });

  test('credential rotation reuses vectors and key removal prevents semantic queries', async () => {
    let apiKey: string | null = 'first-key';
    const requests: Array<{ authorization: string | null; input: string[] }> = [];
    const svc = new SemanticSearchService({
      loadEmbedder: async () =>
        apiKey
          ? createOpenAiEmbedder(
              { baseUrl: 'https://embeddings.example/v1', model: 'test', apiKey },
              {
                fetchImpl: async (_url, init) => {
                  const { input } = JSON.parse(String(init?.body)) as { input: string[] };
                  requests.push({
                    authorization: new Headers(init?.headers).get('authorization'),
                    input,
                  });
                  return new Response(
                    JSON.stringify({
                      data: input.map((_, index) => ({ index, embedding: [1, 0, 0] })),
                    }),
                  );
                },
              },
            )
          : null,
      cacheDir: null,
      enabled: true,
    });
    await svc.embedCorpus(corpus);
    expect(requests).toHaveLength(1);
    apiKey = 'rotated-key';
    svc.reloadCredential();
    expect(svc.getStatus()).toMatchObject({
      ready: false,
      capable: false,
      embeddedCount: corpus.length,
    });
    await svc.embedCorpus(corpus);
    expect(requests).toHaveLength(1);
    expect(await svc.queryScores('authentication', corpus)).not.toBeNull();
    expect(requests[1]).toEqual({ authorization: 'Bearer rotated-key', input: ['authentication'] });

    apiKey = null;
    svc.reloadCredential();
    expect(await svc.queryScores('authentication', corpus)).toBeNull();
    await svc.embedCorpus(corpus);
    expect(svc.getStatus()).toMatchObject({
      ready: true,
      capable: false,
      embeddedCount: corpus.length,
    });
    expect(await svc.queryScores('authentication', corpus)).toBeNull();
    expect(requests).toHaveLength(2);
  });

  test('a changed identity replaces a cache retained during credential reload', async () => {
    let modelId = 'first-model';
    let documentInputs = 0;
    const svc = new SemanticSearchService({
      loadEmbedder: async () => {
        const inner = createConceptEmbedder({ concepts });
        return {
          ...inner,
          modelId,
          embed: (texts, options) => {
            if (options.role === 'document') documentInputs += texts.length;
            return inner.embed(texts, options);
          },
        };
      },
      cacheDir: null,
      enabled: true,
    });
    await svc.embedCorpus(corpus);
    expect(documentInputs).toBe(corpus.length);
    modelId = 'next-model';
    svc.reloadCredential();
    await svc.ensureWarm();
    expect(svc.getStatus().embeddedCount).toBe(0);
    await svc.embedCorpus(corpus);
    expect(documentInputs).toBe(corpus.length * 2);
  });

  test('disable racing an in-flight embed pass does NOT wipe the on-disk cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-vec-race-'));
    const info = vi.spyOn(getLogger('embeddings'), 'info');
    try {
      const inner = createConceptEmbedder({ concepts });
      let release: (() => void) | null = null;
      let signalEntered: (() => void) | null = null;
      const enteredEmbed = new Promise<void>((r) => {
        signalEntered = r;
      });
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let blockNextDocEmbed = false;
      const gated: Embedder = {
        providerId: inner.providerId,
        modelId: inner.modelId,
        dims: inner.dims,
        async embed(texts, opts) {
          if (opts.role === 'document' && blockNextDocEmbed) {
            blockNextDocEmbed = false;
            signalEntered?.();
            await gate;
          }
          return inner.embed(texts, opts);
        },
      };
      const svc = new SemanticSearchService({
        loadEmbedder: () => Promise.resolve(gated),
        cacheDir: dir,
        enabled: true,
      });

      await svc.embedCorpus(corpus);
      expect(svc.getStatus().embeddedCount).toBe(2);

      blockNextDocEmbed = true;
      const pending = svc.embedCorpus([
        ...corpus,
        doc('new-topic', 'a fresh note about backoff and retries', 5),
      ]);
      await enteredEmbed;
      svc.applyConfig({
        enabled: false,
        providerFingerprint: '',
        transportFingerprint: '',
        maxBatchSize: 96,
      });
      expect(info).toHaveBeenCalledWith(
        {
          reason: 'disabled',
          retainedInMemoryDocumentCount: 0,
          unloadedInMemoryDocumentCount: corpus.length,
        },
        '[embeddings] resetting embedder',
      );
      release?.();
      await pending;
      expect(info).toHaveBeenCalledWith(
        {
          reason: 'disabled',
          completedDocumentCount: 1,
          scheduledDocumentCount: 1,
          corpusDocumentCount: 3,
        },
        '[embeddings] abandoning embed pass before persistence',
      );

      const reopened = new VectorCache({
        cacheDir: dir,
        providerId: gated.providerId,
        modelId: gated.modelId,
        identityDims: gated.dims ?? 'auto',
        chunkConfigId: CHUNK_CONFIG_ID,
      });
      await reopened.init();
      expect(reopened.embeddedCount).toBe(2);
    } finally {
      info.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('applyConfig provider-fingerprint change re-loads the embedder', async () => {
    let loads = 0;
    const svc = new SemanticSearchService({
      loadEmbedder: () => {
        loads += 1;
        return Promise.resolve(createConceptEmbedder({ concepts }));
      },
      cacheDir: null,
      enabled: true,
      providerFingerprint: 'openai|text-embedding-3-small|1536',
    });
    await svc.embedCorpus(corpus);
    expect(loads).toBe(1);
    svc.applyConfig({
      enabled: true,
      providerFingerprint: 'openai|text-embedding-3-small|1536',
      transportFingerprint: '',
      maxBatchSize: 96,
    });
    await svc.embedCorpus(corpus);
    expect(loads).toBe(1);
    svc.applyConfig({
      enabled: true,
      providerFingerprint: 'openai|text-embedding-3-large|3072',
      transportFingerprint: '',
      maxBatchSize: 96,
    });
    await svc.embedCorpus(corpus);
    expect(loads).toBe(2);
  });

  test('applyConfig transport-fingerprint change re-loads only the embedder and reuses vectors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-sem-transport-reload-'));
    const info = vi.spyOn(getLogger('embeddings'), 'info');
    let loads = 0;
    let documentInputs = 0;
    try {
      const svc = new SemanticSearchService({
        loadEmbedder: () => {
          loads += 1;
          const inner = createConceptEmbedder({ concepts });
          return Promise.resolve({
            ...inner,
            embed: (texts, options) => {
              if (options.role === 'document') documentInputs += texts.length;
              return inner.embed(texts, options);
            },
          });
        },
        cacheDir: dir,
        enabled: true,
        providerFingerprint: 'openai|model|auto',
        transportFingerprint: '96|96000|30000',
      });
      await svc.embedCorpus(corpus);
      const firstDocumentInputs = documentInputs;
      expect(loads).toBe(1);
      expect(firstDocumentInputs).toBeGreaterThan(0);

      svc.applyConfig({
        enabled: true,
        providerFingerprint: 'openai|model|auto',
        transportFingerprint: '2|16000|120000',
        maxBatchSize: 2,
      });
      expect(svc.getStatus().embeddedCount).toBe(corpus.length);
      expect(info).toHaveBeenCalledWith(
        {
          reason: 'transport',
          retainedInMemoryDocumentCount: corpus.length,
          unloadedInMemoryDocumentCount: 0,
        },
        '[embeddings] resetting embedder',
      );
      await svc.embedCorpus(corpus);

      expect(loads).toBe(2);
      expect(documentInputs).toBe(firstDocumentInputs);
    } finally {
      info.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('corpus request batches honor configured limits above 96 and after live tuning', async () => {
    const requests: string[][] = [];
    let maxBatchSize = 128;
    const svc = new SemanticSearchService({
      loadEmbedder: () =>
        Promise.resolve(
          createOpenAiEmbedder(
            { baseUrl: 'https://embeddings.example/v1', model: 'test', dimensions: 3 },
            {
              maxBatchSize,
              fetchImpl: async (_input, init) => {
                const { input } = JSON.parse(String(init?.body)) as { input: string[] };
                requests.push(input);
                return new Response(
                  JSON.stringify({
                    data: input.map((_, index) => ({ index, embedding: [1, 0, 0] })),
                  }),
                );
              },
            },
          ),
        ),
      cacheDir: null,
      enabled: true,
      maxBatchSize,
      transportFingerprint: '128',
    });
    const pages = Array.from({ length: 260 }, (_, i) => doc(`page-${i}`, `Unique page ${i}`));
    await svc.embedCorpus(pages.slice(0, 200));
    expect(requests.map((inputs) => inputs.length)).toEqual([128, 72]);

    maxBatchSize = 2;
    svc.applyConfig({
      enabled: true,
      providerFingerprint: '',
      transportFingerprint: '2',
      maxBatchSize,
    });
    requests.length = 0;
    await svc.embedCorpus(pages);
    expect(requests).toHaveLength(30);
    expect(requests.every((inputs) => inputs.length === 2)).toBe(true);
    expect(requests.flat()).toEqual(pages.slice(200).map((page) => page.content));
  });

  test('transport changes preserve a pending pass and its persisted progress across restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-sem-transport-pending-'));
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const calls: number[] = [];
    let pauseNext = false;
    const loadEmbedder = async (): Promise<Embedder> => {
      const inner = createConceptEmbedder({ concepts });
      return {
        ...inner,
        async embed(texts, opts) {
          if (opts.role === 'document') {
            calls.push(texts.length);
            if (pauseNext) {
              pauseNext = false;
              started.resolve();
              await release.promise;
            }
          }
          return inner.embed(texts, opts);
        },
      };
    };
    try {
      const svc = new SemanticSearchService({
        loadEmbedder,
        cacheDir: dir,
        enabled: true,
        maxBatchSize: 2,
        transportFingerprint: '2',
      });
      await svc.embedCorpus(corpus);
      calls.length = 0;
      const extended = [
        ...corpus,
        ...Array.from({ length: 5 }, (_, i) => doc(`new-${i}`, `auth ${i}`)),
      ];
      pauseNext = true;
      const pending = svc.embedCorpus(extended);
      await started.promise;
      svc.applyConfig({
        enabled: true,
        providerFingerprint: '',
        transportFingerprint: '1',
        maxBatchSize: 1,
      });
      expect(svc.getStatus().embeddedCount).toBe(corpus.length);
      await svc.ensureWarm();
      expect(svc.getStatus().embeddedCount).toBe(corpus.length);
      release.resolve();
      await pending;
      expect(calls).toEqual([2, 2, 1]);
      expect(svc.getStatus().embeddedCount).toBe(extended.length);

      const restarted = new SemanticSearchService({ loadEmbedder, cacheDir: dir, enabled: true });
      calls.length = 0;
      await restarted.embedCorpus(extended);
      expect(calls).toEqual([]);
      expect(restarted.getStatus().embeddedCount).toBe(extended.length);
      expect(await restarted.queryScores('authentication', extended)).not.toBeNull();
    } finally {
      release.resolve();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a pending corpus pass waits for the current transport loader after its old loader settles', async () => {
    const initial = Promise.withResolvers<Embedder | null>();
    const current = Promise.withResolvers<Embedder | null>();
    const loadEmbedder = vi
      .fn<() => Promise<Embedder | null>>()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(current.promise);
    const svc = new SemanticSearchService({ loadEmbedder, cacheDir: null, enabled: true });
    const pending = svc.embedCorpus(corpus);
    await vi.waitFor(() => expect(loadEmbedder).toHaveBeenCalledTimes(1));
    svc.applyConfig({
      enabled: true,
      providerFingerprint: '',
      transportFingerprint: '2',
      maxBatchSize: 2,
    });
    initial.resolve(null);
    await vi.waitFor(() => expect(loadEmbedder).toHaveBeenCalledTimes(2));
    expect(svc.getStatus()).toMatchObject({ ready: false, embeddedCount: 0 });
    current.resolve(createConceptEmbedder({ concepts }));
    await pending;
    expect(svc.getStatus()).toMatchObject({
      ready: true,
      capable: true,
      embeddedCount: corpus.length,
    });
  });

  test('a corpus pass re-warms when config changes after ensureWarm resolves but before the pass resumes', async () => {
    const loadEmbedder = vi.fn(async () => createConceptEmbedder({ concepts }));
    const svc = new SemanticSearchService({ loadEmbedder, cacheDir: null, enabled: true });
    const warming = svc.ensureWarm();
    const pending = svc.embedCorpus(corpus);
    const changed = warming.then(() => {
      expect(svc.getStatus().ready).toBe(true);
      svc.applyConfig({
        enabled: true,
        providerFingerprint: '',
        transportFingerprint: '2',
        maxBatchSize: 2,
      });
    });
    await Promise.all([pending, changed]);
    expect(loadEmbedder).toHaveBeenCalledTimes(2);
    expect(svc.getStatus()).toMatchObject({
      ready: true,
      capable: true,
      embeddedCount: corpus.length,
    });
  });

  test('successive transport loaders settling in reverse order keep the newest embedder', async () => {
    const loaders = Array.from({ length: 3 }, () => Promise.withResolvers<Embedder | null>());
    const loadEmbedder = vi
      .fn<() => Promise<Embedder | null>>()
      .mockReturnValueOnce(loaders[0].promise)
      .mockReturnValueOnce(loaders[1].promise)
      .mockReturnValueOnce(loaders[2].promise);
    const svc = new SemanticSearchService({ loadEmbedder, cacheDir: null, enabled: true });
    const pending = svc.embedCorpus(corpus);
    await vi.waitFor(() => expect(loadEmbedder).toHaveBeenCalledTimes(1));
    svc.applyConfig({
      enabled: true,
      providerFingerprint: '',
      transportFingerprint: '2',
      maxBatchSize: 2,
    });
    const middleWarm = svc.ensureWarm();
    svc.applyConfig({
      enabled: true,
      providerFingerprint: '',
      transportFingerprint: '1',
      maxBatchSize: 1,
    });
    const latestWarm = svc.ensureWarm();
    const inner = createConceptEmbedder({ concepts });
    const embed = vi.fn(inner.embed);
    loaders[2].resolve({ ...inner, embed });
    await latestWarm;
    loaders[1].resolve(null);
    await middleWarm;
    loaders[0].resolve(null);
    await pending;
    expect(embed.mock.calls.map(([texts]) => texts.length)).toEqual([1, 1]);
    expect(svc.getStatus()).toMatchObject({
      ready: true,
      capable: true,
      embeddedCount: corpus.length,
    });
    expect(await svc.queryScores('authentication', corpus)).not.toBeNull();
    expect(loadEmbedder).toHaveBeenCalledTimes(3);
  });

  test('a superseded cache initialization finishes before the new provider initializes its cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-sem-cache-init-'));
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const init = VectorCache.prototype.init;
    const initialize = vi
      .spyOn(VectorCache.prototype, 'init')
      .mockImplementationOnce(async function () {
        started.resolve();
        await release.promise;
        await init.call(this);
      });
    let modelId = 'old';
    const loadEmbedder = async (): Promise<Embedder> => ({
      ...createConceptEmbedder({ concepts }),
      modelId,
    });
    try {
      const svc = new SemanticSearchService({ loadEmbedder, cacheDir: dir, enabled: true });
      const pending = svc.embedCorpus(corpus);
      await started.promise;
      modelId = 'new';
      svc.applyConfig({
        enabled: true,
        providerFingerprint: 'new',
        transportFingerprint: '',
        maxBatchSize: 96,
      });
      const currentWarm = svc.ensureWarm();
      await Promise.resolve();
      await Promise.resolve();
      expect(initialize).toHaveBeenCalledTimes(1);
      release.resolve();
      await Promise.all([pending, currentWarm]);
      expect(initialize).toHaveBeenCalledTimes(2);
      const restarted = new SemanticSearchService({ loadEmbedder, cacheDir: dir, enabled: true });
      await restarted.ensureWarm();
      expect(restarted.getStatus().embeddedCount).toBe(corpus.length);
    } finally {
      release.resolve();
      initialize.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('max chunk cosine roll-up: a buried passage still surfaces the doc', async () => {
    const svc = makeService({ enabled: true });
    const breadBlock = 'sourdough bread cold ferment dough recipe loaf crust. '.repeat(90);
    const authBlock =
      'session token authentication credential login refresh re-issue access. '.repeat(90);
    const mixed = doc('mixed', `${breadBlock}\n\n${authBlock}`);
    expect(mixed.content.length).toBeGreaterThan(8000);
    const breadOnly = doc('bread-only', breadBlock);
    await svc.embedCorpus([mixed, breadOnly]);
    const scores = await svc.queryScores('authentication credential login session', [
      mixed,
      breadOnly,
    ]);
    const mixedScore = scores?.get('page:mixed') ?? -1;
    const breadScore = scores?.get('page:bread-only') ?? -1;
    expect(mixedScore).toBeGreaterThan(breadScore + 0.15);
  });
});
