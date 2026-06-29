
import {
  DEFAULT_EMBEDDINGS_DIMENSIONS,
  type Embedder,
  type EmbeddingRole,
  normalizeInPlace,
} from './embedder.ts';

interface ConceptDefinition {
  id: string;
  terms: string[];
}

export interface ConceptEmbedderOptions {
  concepts?: ConceptDefinition[];
  dims?: number;
  modelId?: string;
  providerId?: string;
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

function basisDirection(key: string, dims: number): Float32Array {
  const vec = new Float32Array(dims);
  let state = hash32(key) || 1;
  for (let i = 0; i < dims; i++) {
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
