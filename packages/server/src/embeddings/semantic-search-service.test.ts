import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorkspaceSearchDocument,
  type WorkspaceSearchDocument,
} from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { CHUNK_CONFIG_ID } from './chunking.ts';
import { createConceptEmbedder } from './concept-embedder.ts';
import type { Embedder } from './embedder.ts';
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
    expect(svc.getStatus().embeddedCount).toBe(2);
    const scores = await svc.queryScores('authentication login session', mixed);
    expect(scores?.has('page:good-1')).toBe(true);
    expect(scores?.has('page:bad')).toBe(false);
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
    failQueries = true;
    expect(await svc.queryScores('auth retries', corpus)).toBeNull();
  });

  test('applyConfig disable frees in-memory vectors; re-enable re-warms', async () => {
    const svc = makeService({ enabled: true });
    await svc.embedCorpus(corpus);
    expect(svc.getStatus().embeddedCount).toBe(2);
    svc.applyConfig({ enabled: false, providerFingerprint: '' });
    expect(svc.getStatus().embeddedCount).toBe(0);
    expect(await svc.queryScores('auth retries', corpus)).toBeNull();
    svc.applyConfig({ enabled: true, providerFingerprint: '' });
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

  test('disable racing an in-flight embed pass does NOT wipe the on-disk cache', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-vec-race-'));
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
      svc.applyConfig({ enabled: false, providerFingerprint: '' });
      release?.();
      await pending;

      const reopened = new VectorCache({
        cacheDir: dir,
        providerId: gated.providerId,
        modelId: gated.modelId,
        dims: gated.dims,
        chunkConfigId: CHUNK_CONFIG_ID,
      });
      await reopened.init();
      expect(reopened.embeddedCount).toBe(2);
    } finally {
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
    svc.applyConfig({ enabled: true, providerFingerprint: 'openai|text-embedding-3-small|1536' });
    await svc.embedCorpus(corpus);
    expect(loads).toBe(1);
    svc.applyConfig({ enabled: true, providerFingerprint: 'openai|text-embedding-3-large|3072' });
    await svc.embedCorpus(corpus);
    expect(loads).toBe(2);
  });

  test('applyConfig transport-fingerprint change re-loads only the embedder and reuses vectors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ok-sem-transport-reload-'));
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
      });
      await svc.embedCorpus(corpus);

      expect(loads).toBe(2);
      expect(documentInputs).toBe(firstDocumentInputs);
    } finally {
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
