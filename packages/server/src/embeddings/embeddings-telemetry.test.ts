import { describe, expect, test } from 'vitest';
import {
  __resetEmbeddingsTelemetryForTesting,
  recordEmbeddingProviderError,
  recordEmbeddingRequestDuration,
  recordEmbeddingTokens,
  recordSemanticQuery,
} from './embeddings-telemetry.ts';

describe('embeddings telemetry', () => {
  test('all record paths are no-throw under the default provider', () => {
    expect(() => {
      recordEmbeddingTokens('query', 12);
      recordEmbeddingTokens('document', 0);
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
