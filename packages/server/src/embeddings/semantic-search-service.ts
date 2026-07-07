/**
 * Semantic-search service — the server-side orchestration that turns a corpus
 * of documents into query-time cosine scores against a remote embeddings API.
 *
 * Owns the lifecycle the api-extension drives:
 *  - `applyConfig({enabled, providerFingerprint})` — the config gate. Disabled
 *    is fully inert: no key read, no embedding, zero egress — the precondition
 *    for the flag-OFF byte-identity contract. A changed provider/model/dims
 *    fingerprint resets the warm state so the next search re-loads cleanly.
 *  - `ensureWarm()` — lazy, single-flight key resolution + client construction +
 *    cache hydration. Makes NO network call (capability = "is there a key"), so
 *    it is free to run off the request path.
 *  - `embedCorpus(docs)` — incremental, coalesced, background embed pass. The
 *    FIRST opt-in search triggers it (lazy — no proactive egress when idle);
 *    coverage grows progressively as it runs. Doc-aligned batching isolates a
 *    failed provider request to the docs in that batch (partial failure reduces
 *    coverage, never errors a search).
 *  - `queryScores(query, docs)` — embeds ONLY the query and rolls each doc up to
 *    its max chunk cosine, over already-embedded docs only. Returns `null`
 *    (→ caller uses pure BM25) whenever the feature is off / incapable / not yet
 *    warm / the provider errors — it NEVER triggers a corpus embed and NEVER
 *    throws on the query path.
 *
 * One embedder + cache per server process (one server per contentDir via the
 * server lock).
 */

import type { WorkspaceSearchDocument } from '@inkeep/open-knowledge-core';
import { getLogger } from '../logger.ts';
import { CHUNK_CONFIG_ID, chunkDocument } from './chunking.ts';
import { cosineSimilarity, type Embedder } from './embedder.ts';
import { hashContent, VectorCache } from './vector-cache.ts';

const log = getLogger('embeddings');

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Minimum query length (trimmed) for the vector signal to apply. Below this a
 * search stays pure-lexical — a 1–2 char query is navigational, not conceptual,
 * and embedding it is noise + spend with no recall benefit. Far below the old
 * local-model gate: the agent surface explicitly opts in, so only the most
 * trivial prefixes are skipped.
 */
export const SEMANTIC_MIN_QUERY_LENGTH = 3;

/** How many chunks one embed pass groups per provider call (throughput). */
const EMBED_BATCH_CHUNK_LIMIT = 96;

/**
 * Consecutive per-doc embed failures that abort the rest of a pass. A handful of
 * isolated bad inputs are skipped individually (coverage just dips); a run of
 * failures means the provider is down / the key is bad, so we stop rather than
 * hammer the API doc-by-doc. The next search re-drives the pass.
 */
const MAX_CONSECUTIVE_EMBED_FAILURES = 5;

export interface SemanticSearchStatus {
  /** Config flag. */
  enabled: boolean;
  /** Embedder loaded (key present + client constructed). False → degrade to BM25. */
  capable: boolean;
  /** Warm attempt has settled (capability known, client + cache ready if capable). */
  ready: boolean;
  /** Documents with at least one cached chunk vector (coverage numerator). */
  embeddedCount: number;
}

export interface SemanticSearchServiceOptions {
  /**
   * Load the embedder, or resolve `null` when no key is configured (→ degrade to
   * BM25). Reads config fresh each call so a provider/model/dims change re-warms
   * cleanly. Injected so tests use a deterministic embedder instead of a network
   * call.
   */
  loadEmbedder: () => Promise<Embedder | null>;
  /** Vector cache home, or `null` for memory-only (tests). */
  cacheDir: string | null;
  /** Initial flag state (default false). */
  enabled?: boolean;
  /** Initial provider fingerprint (provider|model|dims) for cache identity. */
  providerFingerprint?: string;
}

export class SemanticSearchService {
  private readonly loadEmbedder: () => Promise<Embedder | null>;
  private readonly cacheDir: string | null;

  private enabled: boolean;
  private providerFingerprint: string;
  private capable = false;
  private ready = false;
  private embedder: Embedder | null = null;
  private cache: VectorCache | null = null;

  private warmPromise: Promise<void> | null = null;
  private embedChain: Promise<void> = Promise.resolve();
  private queuedDocs: readonly WorkspaceSearchDocument[] | null = null;

  constructor(options: SemanticSearchServiceOptions) {
    this.loadEmbedder = options.loadEmbedder;
    this.cacheDir = options.cacheDir;
    this.enabled = options.enabled ?? false;
    this.providerFingerprint = options.providerFingerprint ?? '';
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

  /**
   * Apply the resolved config. Toggling `enabled` flips the gate (disable frees
   * in-memory vectors; the on-disk cache survives so a re-enable re-hydrates
   * without re-paying the API). A changed provider/model/dims fingerprint resets
   * the warm state so the next embed re-loads the embedder and the cache's own
   * identity check invalidates stale vectors. Idempotent; never embeds eagerly
   * (lazy — the first opt-in search drives the corpus embed).
   */
  applyConfig(input: { enabled: boolean; providerFingerprint: string }): void {
    if (input.providerFingerprint !== this.providerFingerprint) {
      this.providerFingerprint = input.providerFingerprint;
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

  /** Lazy, single-flight key resolution + client construction + cache hydration. */
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
      this.cache = new VectorCache({
        cacheDir: this.cacheDir,
        providerId: embedder.providerId,
        modelId: embedder.modelId,
        dims: embedder.dims,
        chunkConfigId: CHUNK_CONFIG_ID,
      });
      await this.cache.init();
      this.capable = true;
      this.ready = true;
    } catch (err) {
      this.capable = false;
      this.ready = true;
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '[embeddings] warm failed',
      );
    }
  }

  /**
   * Incrementally embed the corpus. Coalesces concurrent calls (latest doc set
   * wins) so prewarm bursts and rapid corpus rebuilds collapse to one pass. The
   * returned promise settles when this request's pass has run. Never throws.
   */
  embedCorpus(documents: readonly WorkspaceSearchDocument[]): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    this.queuedDocs = documents;
    this.embedChain = this.embedChain.then(async () => {
      const next = this.queuedDocs;
      if (!next) return; // a later call already coalesced this work
      this.queuedDocs = null;
      try {
        await this.runEmbedPass(next);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          '[embeddings] embed pass failed',
        );
      }
    });
    return this.embedChain;
  }

  private async runEmbedPass(documents: readonly WorkspaceSearchDocument[]): Promise<void> {
    await this.ensureWarm();
    if (!this.enabled || !this.embedder || !this.cache) return;
    const cache = this.cache;
    const embedder = this.embedder;
    const pageDocs = documents.filter((d) => d.kind === 'page');
    const activeIds = new Set(pageDocs.map((d) => d.id));

    // Phase 1: cheap reconciliation (mtime / content-hash). Collect only the
    // docs that genuinely need new vectors.
    interface Pending {
      doc: WorkspaceSearchDocument;
      contentHash: string;
      chunks: string[];
    }
    const pending: Pending[] = [];
    for (const doc of pageDocs) {
      if (!this.enabled) return; // bail if disabled mid-pass
      const mtimeMs = doc.modifiedTs;
      if (cache.isFresh(doc.id, mtimeMs)) continue;
      const contentHash = hashContent(doc.content);
      if (cache.link(doc.id, contentHash, mtimeMs)) continue;
      pending.push({ doc, contentHash, chunks: chunkDocument(doc.content) });
    }

    // Phase 2: doc-aligned batches for throughput; on a batch failure, isolate
    // per-doc so one pathological input doesn't sink its batch-mates. A run of
    // failures (provider down / bad key) aborts the pass instead of hammering
    // the API. Empty-chunk docs store an empty vector set. Never rethrows.
    let consecutiveFailures = 0;

    const storeDoc = (p: Pending, vectors: Float32Array[]): void => {
      cache.store(p.doc.id, p.contentHash, p.doc.modifiedTs, vectors);
    };

    /** Embed a group as one request; fall back to per-doc on failure. Returns */
    /** false to signal the pass should abort (consecutive-failure ceiling hit). */
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
        if (group.length === 1) {
          log.warn(
            { docId: group[0].doc.id, err: errMsg(batchErr) },
            '[embeddings] failed to embed document',
          );
          consecutiveFailures += 1;
          return consecutiveFailures < MAX_CONSECUTIVE_EMBED_FAILURES;
        }
        // Re-attempt each doc alone so a single bad input is the only casualty.
        for (const p of group) {
          if (!this.enabled) return false;
          try {
            const v = p.chunks.length ? await embedder.embed(p.chunks, { role: 'document' }) : [];
            storeDoc(p, v);
            consecutiveFailures = 0;
          } catch (docErr) {
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

    // If the feature was disabled (or the provider fingerprint changed) while a
    // batch was in flight, `applyConfig`/`resetWarm` cleared + nulled `this.cache`
    // out from under us. The captured `cache` still points at the now-emptied
    // store; running retain + persist on it would write a zero-entry manifest and
    // GC every on-disk blob — forcing a full paid re-embed on the next enable.
    // Bail so the persisted cache survives for re-hydration.
    if (!this.enabled || this.cache !== cache) return;
    cache.retain(activeIds);
    await cache.persist();
  }

  /**
   * Per-doc max chunk cosine for `query`, over already-embedded docs only.
   * Returns `null` when semantic search can't contribute (off / incapable / not
   * warm / nothing embedded / provider error) so the caller falls back to pure
   * BM25. Embeds only the query — never the corpus, never blocks on a cold load —
   * and never throws.
   */
  async queryScores(
    query: string,
    documents: readonly WorkspaceSearchDocument[],
  ): Promise<Map<string, number> | null> {
    if (!this.enabled || !this.capable || !this.ready) return null;
    if (!this.embedder || !this.cache) return null;
    if (this.cache.embeddedCount === 0) return null;
    const trimmed = query.trim();
    if (!trimmed) return null;

    let queryVec: Float32Array | undefined;
    try {
      [queryVec] = await this.embedder.embed([trimmed], { role: 'query' });
    } catch (err) {
      // Provider error / timeout on the query path is non-fatal: degrade to BM25.
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '[embeddings] query embed failed — degrading to lexical',
      );
      return null;
    }
    if (!queryVec) return null;

    const scores = new Map<string, number>();
    for (const doc of documents) {
      const vectors = this.cache.getVectors(doc.id);
      if (!vectors || vectors.length === 0) continue;
      let best = Number.NEGATIVE_INFINITY;
      for (const chunk of vectors) {
        const cos = cosineSimilarity(queryVec, chunk);
        if (cos > best) best = cos;
      }
      if (best > Number.NEGATIVE_INFINITY) scores.set(doc.id, best);
    }
    return scores;
  }
}
