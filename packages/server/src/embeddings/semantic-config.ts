/**
 * Single source of truth for resolving `search.semantic.*` from config.
 *
 * Shared by the server boot path (`server-factory.ts`) and the `ok embeddings
 * status` CLI so the two surfaces can NEVER disagree about whether the feature
 * is on. They used to diverge: the server read the project-local layer only,
 * while the CLI read a user+project merge — so `status` could report the
 * opposite of what the server actually ran.
 */

import { DEFAULT_EMBEDDINGS_BASE_URL, DEFAULT_EMBEDDINGS_MODEL } from '@inkeep/open-knowledge-core';
import { readConfigSafely, resolveConfigPath } from '@inkeep/open-knowledge-core/server';

export interface ResolvedSemanticConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  dimensions?: number;
  /** Cosine noise gate for retrieval; omitted → core's default for the model. */
  similarityFloor?: number;
}

/**
 * Resolve `search.semantic.*` from the PROJECT-LOCAL config layer ONLY
 * (`<projectDir>/.ok/local/config.yml`) — never the committed `project` config
 * or the `user` config. Enabling semantic search opts into content egress on
 * this machine using this machine's API key; honoring the value from a
 * shared/committed config would let one collaborator silently turn on egress for
 * everyone who clones (the exact thing project-local scope exists to prevent),
 * and matches the write-side scope guard. Read fresh (not from a boot snapshot)
 * so a runtime config edit is picked up.
 */
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
