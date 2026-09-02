import type { SearchSource } from '@inkeep/open-knowledge-core';
import type { Counter, Histogram } from '@opentelemetry/api';
import { getLogger } from '../logger.ts';
import { getMeter } from '../telemetry.ts';

const log = getLogger('embeddings');

export type EmbeddingRoleLabel = 'query' | 'document';

export type EmbeddingErrorReason =
  | 'rate_limit'
  | 'timeout'
  | 'http_error'
  | 'network'
  | 'dims_mismatch'
  | 'malformed_response';

export type SemanticQueryOutcome =
  | 'applied'
  | 'no_match'
  | 'warming'
  | 'incapable'
  | 'provider_error';

let _tokens: Counter | null = null;
let _errors: Counter | null = null;
let _requestDuration: Histogram | null = null;
let _queryTotal: Counter | null = null;
let _queryEmbedDuration: Histogram | null = null;

function tokensCounter(): Counter {
  _tokens ||= getMeter().createCounter('ok.embeddings.tokens_total', {
    description:
      'Embeddings tokens billed, by role. Bounded label: role ∈ {query, document}. Makes spend legible; never includes content.',
  });
  return _tokens;
}

function errorsCounter(): Counter {
  _errors ||= getMeter().createCounter('ok.embeddings.provider_errors_total', {
    description:
      'Embeddings provider failures, by reason. Bounded label: reason ∈ {rate_limit, timeout, http_error, network, dims_mismatch, malformed_response}.',
  });
  return _errors;
}

function requestDurationHist(): Histogram {
  _requestDuration ||= getMeter().createHistogram('ok.embeddings.request_duration_ms', {
    description: 'Wall-clock duration of one embeddings API request. Bounded label: role.',
    unit: 'ms',
  });
  return _requestDuration;
}

function queryTotalCounter(): Counter {
  _queryTotal ||= getMeter().createCounter('ok.search.semantic_query_total', {
    description:
      'Semantic-requested searches, by outcome and caller surface. Bounded labels: outcome ∈ {applied, no_match, warming, incapable, provider_error}, source ∈ {omnibar, mcp, http}. The omnibar/mcp split separates interactive cost from agent cost.',
  });
  return _queryTotal;
}

function queryEmbedDurationHist(): Histogram {
  _queryEmbedDuration ||= getMeter().createHistogram('ok.search.semantic_query_embed_ms', {
    description: 'Wall-clock latency of the per-query embed on the semantic search path.',
    unit: 'ms',
  });
  return _queryEmbedDuration;
}

export function recordEmbeddingTokens(role: EmbeddingRoleLabel, tokens: number): void {
  if (tokens > 0) tokensCounter().add(tokens, { role });
}

export function recordEmbeddingProviderError(reason: EmbeddingErrorReason): void {
  errorsCounter().add(1, { reason });
}

export function recordEmbeddingRequestDuration(role: EmbeddingRoleLabel, ms: number): void {
  requestDurationHist().record(Math.max(0, ms), { role });
}

export function recordSemanticQuery(event: {
  outcome: SemanticQueryOutcome;
  source: SearchSource;
  capable: boolean;
  embedded: number;
  total: number;
  queryEmbedMs: number | null;
  vectorContributors: number;
}): void {
  queryTotalCounter().add(1, { outcome: event.outcome, source: event.source });
  if (event.queryEmbedMs !== null) queryEmbedDurationHist().record(Math.max(0, event.queryEmbedMs));
  log.debug(
    {
      outcome: event.outcome,
      source: event.source,
      capable: event.capable,
      embedded: event.embedded,
      total: event.total,
      coverage: event.total > 0 ? event.embedded / event.total : 0,
      queryEmbedMs: event.queryEmbedMs,
      vectorContributors: event.vectorContributors,
    },
    '[search] semantic query',
  );
}

export function __resetEmbeddingsTelemetryForTesting(): void {
  _tokens = null;
  _errors = null;
  _requestDuration = null;
  _queryTotal = null;
  _queryEmbedDuration = null;
}
