
import { DEFAULT_EMBEDDINGS_BASE_URL, DEFAULT_EMBEDDINGS_MODEL } from '@inkeep/open-knowledge-core';
import { readConfigSafely, resolveConfigPath } from '@inkeep/open-knowledge-core/server';

export interface ResolvedSemanticConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  dimensions?: number;
  similarityFloor?: number;
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
  };
}
