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

/**
 * How many times one process will throw away the cached corpus because the
 * provider's vector length changed. Rebuilding is paid egress, so a gateway
 * flapping between two models must not be able to bill for it in a loop; after
 * the budget is spent the mismatch is logged loudly and search degrades to
 * lexical until a restart.
 */
export const MAX_DIMS_DRIFT_RESETS = 2;

/**
 * Raised inside an embed pass when a provider call reported a vector length
 * that doesn't match the one in force. Caught by the pass itself — never
 * propagated to a caller.
 */
class DimsMismatchSignal extends Error {
  readonly name = 'DimsMismatchSignal';
  constructor(readonly cause: EmbeddingDimsMismatchError) {
    super(cause.message);
  }
}

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
  /** Process-lifetime budget spent on {@link MAX_DIMS_DRIFT_RESETS}. */
  private dimsDriftResets = 0;

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
      // A different provider deserves its own drift budget — the previous one
      // having flapped says nothing about this one. Reset it HERE and not in
      // `resetWarm`, which drift recovery itself calls: refunding the budget on
      // every recovery would leave the bound doing nothing at all.
      this.dimsDriftResets = 0;
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

  /**
   * Re-resolve the embeddings credential on the next search. The key is read at
   * warm time, NOT part of the provider fingerprint, so a live warm won't pick
   * up a key that was set / cleared after it — leaving "I added a key but search
   * stays lexical". The set/clear-key handlers call this so the change takes
   * effect on the next search with no restart. Cheap: the cache re-hydrates from
   * disk on re-warm (same fingerprint → no re-embed).
   */
  reloadCredential(): void {
    this.resetWarm();
  }

  /**
   * Respond to the provider returning a different vector length than the cached
   * corpus was built at — a model swapped behind an alias, or a size detected
   * before a restart that no longer holds.
   *
   * Only meaningful when the size was auto-detected. With `dimensions`
   * explicitly configured a mismatch means the server is ignoring the request
   * param; rebuilding would burn the same egress and land in the same place, so
   * that case stays a plain (surfaced) failure.
   *
   * Recovery is: throw the corpus away and drop the warm state. The next opt-in
   * search re-warms against a cold cache, the embedder re-detects, and coverage
   * refills — the same one-search-later recovery a run of embed failures gets.
   * Returns whether it acted.
   */
  private recoverFromDimsDrift(cache: VectorCache, err: EmbeddingDimsMismatchError): boolean {
    if (cache.identityDims !== 'auto') return false;
    if (this.cache !== cache) return false; // already replaced under us
    if (this.dimsDriftResets >= MAX_DIMS_DRIFT_RESETS) {
      // Give up for the rest of the process rather than pay for another
      // rebuild. Dropping `capable` is what makes that stick: every later
      // search short-circuits at the top of `queryScores`/`runEmbedPass`
      // instead of re-reaching the provider and re-logging this same line.
      log.error(
        { expected: err.expected, got: err.got },
        '[embeddings] provider vector length keeps changing — disabling semantic search until restart',
      );
      this.capable = false;
      // Nothing will read these vectors again this process, and they can be
      // a large resident allocation. Memory only — the disk store survives for
      // a re-hydrate after a restart or a provider change.
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
      const cache = new VectorCache({
        cacheDir: this.cacheDir,
        providerId: embedder.providerId,
        modelId: embedder.modelId,
        dims: embedder.dims,
        chunkConfigId: CHUNK_CONFIG_ID,
      });
      await cache.init();
      // Manifest-first: with `dimensions` unset, the length that matters is the
      // one the stored vectors were written at. Handing it to the embedder now
      // means the first response of this run is CHECKED against it — a provider
      // that changed shape while we were down surfaces as a mismatch instead of
      // quietly re-pinning and scoring two sizes against each other.
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
        log.warn({ err }, '[embeddings] embed pass failed');
      }
    });
    return this.embedChain;
  }

  private async runEmbedPass(documents: readonly WorkspaceSearchDocument[]): Promise<void> {
    await this.ensureWarm();
    // `capable` also carries the give-up state drift recovery sets once its
    // budget is spent, so this stops the pass re-paying the provider for a
    // mismatch already ruled unrecoverable.
    if (!this.enabled || !this.capable || !this.embedder || !this.cache) return;
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
      // A cold auto cache learns its length here — the embedder has already
      // held every vector in the call to one size, so the first is definitive.
      // (A blank doc stores zero vectors and teaches us nothing.)
      const observed = vectors[0]?.length;
      if (observed !== undefined) cache.pinDims(observed);
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
        // A length mismatch isn't one bad document — it says everything cached
        // is the wrong size. Let it out to the pass rather than spending the
        // per-doc failure budget re-asking the provider the same question.
        if (batchErr instanceof EmbeddingDimsMismatchError) throw new DimsMismatchSignal(batchErr);
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
      // The mismatched vectors were never stored (the embedder threw before
      // returning them), so what is cached is self-consistent — just the wrong
      // size now. Recovery discards it; a configured-dimensions mismatch has
      // nothing to recover and is only logged.
      if (!this.recoverFromDimsDrift(cache, err.cause)) {
        log.warn(
          { err: err.cause },
          '[embeddings] provider returned an unexpected vector length — stopping this embed pass',
        );
      }
      return;
    }

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
    // Capture both before the await: a config change or a drift recovery can
    // swap them mid-flight, and this path must never throw.
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
      // A length mismatch on the query path is how an alias swap surfaces when
      // the corpus itself hasn't changed: every embed pass is a no-op
      // reconcile, so nothing else would ever notice, and semantic search would
      // stay silently dead. Recovery rebuilds; anything else just degrades.
      if (err instanceof EmbeddingDimsMismatchError) {
        // Recovery declines when the size was explicitly configured (nothing to
        // rebuild) or the budget is spent. Log it either way — otherwise a
        // query-first mismatch degrades to lexical leaving no trail at all,
        // while the same mismatch on the embed path is logged.
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
        // `cosineSimilarity` truncates to the shorter vector, so a length
        // mismatch would score as a plausible number rather than an error.
        if (chunk.length !== queryVec.length) continue;
        const cos = cosineSimilarity(queryVec, chunk);
        if (cos > best) best = cos;
      }
      if (best > Number.NEGATIVE_INFINITY) scores.set(doc.id, best);
    }
    return scores;
  }
}
