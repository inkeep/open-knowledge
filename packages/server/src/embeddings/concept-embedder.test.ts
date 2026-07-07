import { describe, expect, test } from 'bun:test';
import { createConceptEmbedder } from './concept-embedder.ts';
import { cosineSimilarity, DEFAULT_EMBEDDINGS_DIMENSIONS } from './embedder.ts';

const concepts = [
  { id: 'auth', terms: ['auth', 'authentication', 'session token', 'credential', 'login'] },
  { id: 'retry', terms: ['retry', 'retries', 'backoff', 're-issue', 'refresh'] },
  { id: 'bread', terms: ['bread', 'sourdough', 'ferment', 'dough'] },
];

describe('createConceptEmbedder', () => {
  test('produces normalized vectors of the configured dimensionality', async () => {
    const embedder = createConceptEmbedder({ concepts });
    const [v] = await embedder.embed(['anything at all'], { role: 'document' });
    expect(v.length).toBe(DEFAULT_EMBEDDINGS_DIMENSIONS);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  test('zero-token-overlap pair sharing a concept scores high cosine (the G1 case)', async () => {
    const embedder = createConceptEmbedder({ concepts });
    // No shared tokens, but both are about auth + refresh/re-issue.
    const [query] = await embedder.embed(['auth retries'], { role: 'query' });
    const [doc] = await embedder.embed(['session token refresh re-issues credentials'], {
      role: 'document',
    });
    const [unrelated] = await embedder.embed(['sourdough bread cold ferment recipe'], {
      role: 'document',
    });
    const relevant = cosineSimilarity(query, doc);
    const noise = cosineSimilarity(query, unrelated);
    expect(relevant).toBeGreaterThan(0.5);
    expect(relevant).toBeGreaterThan(noise + 0.3);
  });

  test('is deterministic across calls', async () => {
    const a = createConceptEmbedder({ concepts });
    const b = createConceptEmbedder({ concepts });
    const [va] = await a.embed(['session token login'], { role: 'document' });
    const [vb] = await b.embed(['session token login'], { role: 'document' });
    expect(cosineSimilarity(va, vb)).toBeCloseTo(1, 6);
  });
});
