/**
 * Semantic-search subsystem — public surface.
 *
 * Server-side, capability-gated, additive on top of the BM25 engine, sourced
 * from a remote OpenAI-compatible embeddings API. This barrel re-exports only
 * what the rest of the server package consumes; siblings within the subsystem
 * import each other directly. See the module docstrings: `embedder` (interface +
 * OpenAI HTTP client + key seam), `concept-embedder` (deterministic test/offline
 * embedder), `chunking`, `vector-cache`, `semantic-search-service`.
 */

export { createConceptEmbedder } from './concept-embedder.ts';
export {
  DEFAULT_EMBEDDINGS_DIMENSIONS,
  EMBEDDINGS_API_KEY_ENV,
  type Embedder,
  type EmbeddingsKeyStore,
  loadOpenAiEmbedder,
  normalizeProviderId,
} from './embedder.ts';
export {
  clearEmbeddingsKeyFromAllBackends,
  createEmbeddingsSecretStore,
  describeStoredEmbeddingsKey,
  type EmbeddingsKeyReader,
  type EmbeddingsSecretStore,
  FileEmbeddingsBackend,
  makeLazyEmbeddingsKeyStore,
  secretsFilePath,
} from './secrets-store.ts';
export {
  type ResolvedSemanticConfig,
  readProjectLocalSemanticConfig,
} from './semantic-config.ts';
export { SEMANTIC_MIN_QUERY_LENGTH, SemanticSearchService } from './semantic-search-service.ts';
