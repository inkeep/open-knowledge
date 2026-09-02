import type { WorkspaceSearchDocument } from '@inkeep/open-knowledge-core';
import { getLogger } from '../logger.ts';
import { CHUNK_CONFIG_ID, chunkDocument } from './chunking.ts';
import {
  cosineSimilarity,
  type Embedder,
  EmbeddingDimsMismatchError,
  EmbeddingProviderError,
} from './embedder.ts';
import { hashContent, VectorCache } from './vector-cache.ts';

const log = getLogger('embeddings');

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const SEMANTIC_MIN_QUERY_LENGTH = 3;

const EMBED_BATCH_CHUNK_LIMIT = 96;

const MAX_CONSECUTIVE_EMBED_FAILURES = 5;

export const MAX_DIMS_DRIFT_RESETS = 2;

class DimsMismatchSignal extends Error {
  readonly name = 'DimsMismatchSignal';
  constructor(readonly cause: EmbeddingDimsMismatchError) {
    super(cause.message);
  }
}

export interface SemanticSearchStatus {
  enabled: boolean;
  capable: boolean;
  ready: boolean;
  embeddedCount: number;
}

export interface SemanticSearchServiceOptions {
  loadEmbedder: () => Promise<Embedder | null>;
  cacheDir: string | null;
  enabled?: boolean;
  providerFingerprint?: string;
  transportFingerprint?: string;
}

export class SemanticSearchService {
  private readonly loadEmbedder: () => Promise<Embedder | null>;
  private readonly cacheDir: string | null;

  private enabled: boolean;
  private providerFingerprint: string;
  private transportFingerprint: string;
  private capable = false;
  private ready = false;
  private embedder: Embedder | null = null;
  private cache: VectorCache | null = null;

  private warmPromise: Promise<void> | null = null;
  private embedChain: Promise<void> = Promise.resolve();
  private queuedDocs: readonly WorkspaceSearchDocument[] | null = null;
  private dimsDriftResets = 0;

  constructor(options: SemanticSearchServiceOptions) {
    this.loadEmbedder = options.loadEmbedder;
    this.cacheDir = options.cacheDir;
    this.enabled = options.enabled ?? false;
    this.providerFingerprint = options.providerFingerprint ?? '';
    this.transportFingerprint = options.transportFingerprint ?? '';
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getStatus(): SemanticSearchStatus {
    return {
      enabled: this.enabled,
      capable: this.capable,
      ready: this.ready,
      embeddedCount: this.cache?.embeddedCount ?? 0,
    };
  }

  applyConfig(input: {
    enabled: boolean;
    providerFingerprint: string;
    transportFingerprint?: string;
  }): void {
    if (input.providerFingerprint !== this.providerFingerprint) {
      this.providerFingerprint = input.providerFingerprint;
      this.dimsDriftResets = 0;
      this.resetWarm();
    }
    if (
      input.transportFingerprint !== undefined &&
      input.transportFingerprint !== this.transportFingerprint
    ) {
      this.transportFingerprint = input.transportFingerprint;
      this.resetWarm();
    }
    if (input.enabled === this.enabled) return;
    this.enabled = input.enabled;
    if (!input.enabled) {
      this.cache?.clearMemory();
      this.resetWarm();
    }
  }

  private resetWarm(): void {
    this.warmPromise = null;
    this.ready = false;
    this.capable = false;
    this.embedder = null;
    this.cache = null;
  }

  reloadCredential(): void {
    this.resetWarm();
  }

  private recoverFromDimsDrift(cache: VectorCache, err: EmbeddingDimsMismatchError): boolean {
    if (cache.identityDims !== 'auto') return false;
    if (this.cache !== cache) return false;
    if (this.dimsDriftResets >= MAX_DIMS_DRIFT_RESETS) {
      log.error(
        { expected: err.expected, got: err.got },
        '[embeddings] provider vector length keeps changing — disabling semantic search until restart',
      );
      this.capable = false;
      cache.clearMemory();
      return false;
    }
    this.dimsDriftResets += 1;
    log.warn(
      { expected: err.expected, got: err.got },
      '[embeddings] provider vector length changed — discarding cached vectors and re-embedding',
    );
    cache.discard();
    this.resetWarm();
    return true;
  }

  ensureWarm(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.ready) return Promise.resolve();
    this.warmPromise ||= this.warm();
    return this.warmPromise;
  }

  private async warm(): Promise<void> {
    try {
      const embedder = await this.loadEmbedder();
      if (!embedder) {
        this.capable = false;
        this.ready = true;
        log.info(
          {},
          '[embeddings] no embeddings key configured — semantic search degrades to lexical',
        );
        return;
      }
      this.embedder = embedder;
      const cache = new VectorCache({
        cacheDir: this.cacheDir,
        providerId: embedder.providerId,
        modelId: embedder.modelId,
        dims: embedder.dims,
        chunkConfigId: CHUNK_CONFIG_ID,
      });
      await cache.init();
      if (cache.dims !== null) embedder.pinDims?.(cache.dims);
      this.cache = cache;
      this.capable = true;
      this.ready = true;
    } catch (err) {
      this.capable = false;
      this.ready = true;
      log.warn({ err }, '[embeddings] warm failed');
    }
  }

  embedCorpus(documents: readonly WorkspaceSearchDocument[]): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    this.queuedDocs = documents;
    this.embedChain = this.embedChain.then(async () => {
      const next = this.queuedDocs;
      if (!next) return;
      this.queuedDocs = null;
      try {
        await this.runEmbedPass(next);
      } catch (err) {
        log.warn({ err }, '[embeddings] embed pass failed');
      }
    });
    return this.embedChain;
  }

  private async runEmbedPass(documents: readonly WorkspaceSearchDocument[]): Promise<void> {
    await this.ensureWarm();
    if (!this.enabled || !this.capable || !this.embedder || !this.cache) return;
    const cache = this.cache;
    const embedder = this.embedder;
    const pageDocs = documents.filter((d) => d.kind === 'page');
    const activeIds = new Set(pageDocs.map((d) => d.id));

    interface Pending {
      doc: WorkspaceSearchDocument;
      contentHash: string;
      chunks: string[];
    }
    const pending: Pending[] = [];
    for (const doc of pageDocs) {
      if (!this.enabled) return;
      const mtimeMs = doc.modifiedTs;
      if (cache.isFresh(doc.id, mtimeMs)) continue;
      const contentHash = hashContent(doc.content);
      if (cache.link(doc.id, contentHash, mtimeMs)) continue;
      pending.push({ doc, contentHash, chunks: chunkDocument(doc.content) });
    }

    let consecutiveFailures = 0;

    const storeDoc = (p: Pending, vectors: Float32Array[]): void => {
      const observed = vectors[0]?.length;
      if (observed !== undefined) cache.pinDims(observed);
      cache.store(p.doc.id, p.contentHash, p.doc.modifiedTs, vectors);
    };

    const embedGroup = async (group: Pending[]): Promise<boolean> => {
      const flat = group.flatMap((p) => p.chunks);
      try {
        const vectors = flat.length ? await embedder.embed(flat, { role: 'document' }) : [];
        let offset = 0;
        for (const p of group) {
          storeDoc(p, vectors.slice(offset, offset + p.chunks.length));
          offset += p.chunks.length;
        }
        consecutiveFailures = 0;
        return true;
      } catch (batchErr) {
        if (batchErr instanceof EmbeddingDimsMismatchError) throw new DimsMismatchSignal(batchErr);
        if (group.length === 1) {
          log.warn(
            { docId: group[0].doc.id, err: errMsg(batchErr) },
            '[embeddings] failed to embed document',
          );
          consecutiveFailures += 1;
          return consecutiveFailures < MAX_CONSECUTIVE_EMBED_FAILURES;
        }
        for (const p of group) {
          if (!this.enabled) return false;
          try {
            const v = p.chunks.length ? await embedder.embed(p.chunks, { role: 'document' }) : [];
            storeDoc(p, v);
            consecutiveFailures = 0;
          } catch (docErr) {
            if (docErr instanceof EmbeddingDimsMismatchError) throw new DimsMismatchSignal(docErr);
            log.warn(
              { docId: p.doc.id, err: errMsg(docErr) },
              '[embeddings] failed to embed document',
            );
            consecutiveFailures += 1;
            if (consecutiveFailures >= MAX_CONSECUTIVE_EMBED_FAILURES) return false;
          }
        }
        return true;
      }
    };

    let batch: Pending[] = [];
    let batchChunks = 0;
    try {
      for (const p of pending) {
        if (!this.enabled) break;
        batch.push(p);
        batchChunks += Math.max(1, p.chunks.length);
        if (batchChunks >= EMBED_BATCH_CHUNK_LIMIT) {
          const carryOn = await embedGroup(batch);
          batch = [];
          batchChunks = 0;
          if (!carryOn) break;
        }
      }
      if (batch.length > 0 && this.enabled) await embedGroup(batch);
    } catch (err) {
      if (!(err instanceof DimsMismatchSignal)) throw err;
      if (!this.recoverFromDimsDrift(cache, err.cause)) {
        log.warn(
          { err: err.cause },
          '[embeddings] provider returned an unexpected vector length — stopping this embed pass',
        );
      }
      return;
    }

    if (!this.enabled || this.cache !== cache) return;
    cache.retain(activeIds);
    await cache.persist();
  }

  async queryScores(
    query: string,
    documents: readonly WorkspaceSearchDocument[],
  ): Promise<Map<string, number> | null> {
    if (!this.enabled || !this.capable || !this.ready) return null;
    const cache = this.cache;
    const embedder = this.embedder;
    if (!embedder || !cache) return null;
    if (cache.embeddedCount === 0) return null;
    const trimmed = query.trim();
    if (!trimmed) return null;

    let queryVec: Float32Array | undefined;
    try {
      [queryVec] = await embedder.embed([trimmed], { role: 'query' });
    } catch (err) {
      if (err instanceof EmbeddingDimsMismatchError) {
        if (!this.recoverFromDimsDrift(cache, err)) {
          log.warn(
            { err, expected: err.expected, got: err.got },
            '[embeddings] query vector length does not match the cached corpus — degrading to lexical',
          );
        }
      } else {
        log.warn(
          { err, reason: err instanceof EmbeddingProviderError ? err.reason : undefined },
          '[embeddings] query embed failed — degrading to lexical',
        );
      }
      return null;
    }
    if (!queryVec) return null;

    const scores = new Map<string, number>();
    for (const doc of documents) {
      const vectors = cache.getVectors(doc.id);
      if (!vectors || vectors.length === 0) continue;
      let best = Number.NEGATIVE_INFINITY;
      for (const chunk of vectors) {
        if (chunk.length !== queryVec.length) continue;
        const cos = cosineSimilarity(queryVec, chunk);
        if (cos > best) best = cos;
      }
      if (best > Number.NEGATIVE_INFINITY) scores.set(doc.id, best);
    }
    return scores;
  }
}
