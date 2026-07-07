/**
 * Deterministic, network-free {@link Embedder}.
 *
 * Two uses:
 *  - The injection seam for tests: integration/unit tests boot the real server
 *    and search engine but swap the remote provider for this, so a suite never
 *    touches the network or needs an API key.
 *  - A genuinely *semantic* test double. A hash embedder would make every
 *    zero-token-overlap query/doc pair ~orthogonal — and the entire point of
 *    semantic search is retrieving a doc that shares a *concept* but no
 *    *tokens*. So this maps text onto caller-declared concepts: a query
 *    and a passage that trigger the same concept get a high cosine even with no
 *    shared words, letting the candidate-source path be exercised and
 *    *fail* when broken.
 *
 * Embedding model: each declared concept owns one near-orthogonal basis
 * direction; a text's vector is the sum of the basis directions of the concepts
 * it triggers, plus a small token-hash baseline so concept-less text still gets
 * a stable, mostly-orthogonal vector. The result is L2-normalized, so cosine is
 * a dot product — identical contract to the remote embedder.
 */

import {
  DEFAULT_EMBEDDINGS_DIMENSIONS,
  type Embedder,
  type EmbeddingRole,
  normalizeInPlace,
} from './embedder.ts';

interface ConceptDefinition {
  /** Stable concept id — owns one basis direction. */
  id: string;
  /** Lowercased substrings; any match activates the concept for a text. */
  terms: string[];
}

export interface ConceptEmbedderOptions {
  concepts?: ConceptDefinition[];
  dims?: number;
  modelId?: string;
  providerId?: string;
  /** Relative weight of the token-hash baseline vs concept activation. */
  baselineWeight?: number;
}

function hash32(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * Build a deterministic pseudo-random unit direction for a key, spread across
 * the full vector so distinct concepts are near-orthogonal.
 */
function basisDirection(key: string, dims: number): Float32Array {
  const vec = new Float32Array(dims);
  let state = hash32(key) || 1;
  for (let i = 0; i < dims; i++) {
    // xorshift32 — deterministic, decent spread.
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    vec[i] = (state / 0xffffffff) * 2 - 1;
  }
  return normalizeInPlace(vec);
}

export function createConceptEmbedder(options: ConceptEmbedderOptions = {}): Embedder {
  const dims = options.dims ?? DEFAULT_EMBEDDINGS_DIMENSIONS;
  const modelId = options.modelId ?? 'concept-test-embedder';
  const providerId = options.providerId ?? 'concept-test';
  const baselineWeight = options.baselineWeight ?? 0.15;
  const concepts = (options.concepts ?? []).map((c) => ({
    ...c,
    direction: basisDirection(`concept:${c.id}`, dims),
    terms: c.terms.map((t) => t.toLowerCase()),
  }));

  function embedOne(text: string): Float32Array {
    const lower = text.toLowerCase();
    const vec = new Float32Array(dims);
    for (const concept of concepts) {
      if (concept.terms.some((term) => term.length > 0 && lower.includes(term))) {
        for (let i = 0; i < dims; i++) vec[i] += concept.direction[i];
      }
    }
    // Token-hash baseline: stable, mostly-orthogonal signal for any text, so a
    // concept-less doc is embeddable (non-zero) but never dominates a concept.
    for (const token of lower.split(/[^a-z0-9]+/)) {
      if (!token) continue;
      vec[hash32(token) % dims] += baselineWeight;
    }
    return normalizeInPlace(vec);
  }

  return {
    providerId,
    modelId,
    dims,
    embed(texts: readonly string[], _opts: { role: EmbeddingRole }): Promise<Float32Array[]> {
      return Promise.resolve(texts.map((t) => embedOne(t)));
    },
  };
}
