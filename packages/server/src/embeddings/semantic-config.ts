import {
  DEFAULT_EMBEDDINGS_BASE_URL,
  DEFAULT_EMBEDDINGS_DOC_TIMEOUT_MS,
  DEFAULT_EMBEDDINGS_MAX_BATCH_CHARS,
  DEFAULT_EMBEDDINGS_MAX_BATCH_SIZE,
  DEFAULT_EMBEDDINGS_MODEL,
} from '@inkeep/open-knowledge-core';
import { readConfigSafely, resolveConfigPath } from '@inkeep/open-knowledge-core/server';

export interface ResolvedSemanticConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  dimensions?: number;
  similarityFloor?: number;
  maxBatchSize: number;
  maxBatchChars: number;
  docTimeoutMs: number;
}

export function readProjectLocalSemanticConfig(
  projectDir: string,
  opts?: { configHomedirOverride?: string; onWarn?: (message: string) => void },
): ResolvedSemanticConfig {
  const semantic = readConfigSafely({
    absPath: resolveConfigPath('project-local', projectDir, opts?.configHomedirOverride),
    sideline: false,
    warn: opts?.onWarn ?? (() => {}),
  }).value.search?.semantic;
  return {
    enabled: semantic?.enabled === true,
    baseUrl: semantic?.baseUrl ?? DEFAULT_EMBEDDINGS_BASE_URL,
    model: semantic?.model ?? DEFAULT_EMBEDDINGS_MODEL,
    dimensions: semantic?.dimensions ?? undefined,
    similarityFloor: semantic?.similarityFloor ?? undefined,
    maxBatchSize: semantic?.maxBatchSize ?? DEFAULT_EMBEDDINGS_MAX_BATCH_SIZE,
    maxBatchChars: semantic?.maxBatchChars ?? DEFAULT_EMBEDDINGS_MAX_BATCH_CHARS,
    docTimeoutMs: semantic?.docTimeoutMs ?? DEFAULT_EMBEDDINGS_DOC_TIMEOUT_MS,
  };
}
