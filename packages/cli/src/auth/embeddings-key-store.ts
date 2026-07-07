/**
 * Embeddings provider API-key storage — re-exported from `@inkeep/open-knowledge-server`.
 *
 * The implementation lives in `packages/server/src/embeddings/secrets-store.ts`
 * so the server's loopback-gated set/clear HTTP handlers and the CLI
 * (`ok embeddings set-key`) share one source with no package cycle (cli depends
 * on server). This module stays so existing CLI import paths keep resolving.
 */

export {
  clearEmbeddingsKeyFromAllBackends,
  createEmbeddingsSecretStore,
  describeStoredEmbeddingsKey,
  makeLazyEmbeddingsKeyStore,
} from '@inkeep/open-knowledge-server';
