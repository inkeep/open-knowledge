import { describe, expect, test } from 'bun:test';
import {
  __resetEmbeddingsTelemetryForTesting,
  recordEmbeddingProviderError,
  recordEmbeddingRequestDuration,
  recordEmbeddingTokens,
  recordSemanticQuery,
} from './embeddings-telemetry.ts';

/**
 * The instruments are no-ops under the default (disabled) OTel provider. These
 * assert the record paths never throw — the per-query retrieval event must never
 * be able to break a search — and that every label is a bounded enum (no content
 * / key / free-form string reaches a span). Bounded-cardinality is enforced by
 * the function signatures: there is no overload that accepts an arbitrary value.
 */
describe('embeddings telemetry', () => {
  test('all record paths are no-throw under the default provider', () => {
    expect(() => {
      recordEmbeddingTokens('query', 12);
      recordEmbeddingTokens('document', 0); // zero tokens → skipped, still no throw
      recordEmbeddingProviderError('rate_limit');
      recordEmbeddingProviderError('dims_mismatch');
      recordEmbeddingRequestDuration('document', 123.4);
      recordSemanticQuery({
        outcome: 'applied',
        source: 'mcp',
        capable: true,
        embedded: 5,
        total: 40,
        queryEmbedMs: 87.2,
        vectorContributors: 3,
      });
      recordSemanticQuery({
        outcome: 'incapable',
        source: 'omnibar',
        capable: false,
        embedded: 0,
        total: 0,
        queryEmbedMs: null,
        vectorContributors: 0,
      });
      recordSemanticQuery({
        outcome: 'no_match',
        source: 'http',
        capable: true,
        embedded: 3,
        total: 9,
        queryEmbedMs: 12,
        vectorContributors: 0,
      });
      __resetEmbeddingsTelemetryForTesting();
    }).not.toThrow();
  });
});
