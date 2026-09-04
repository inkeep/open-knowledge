import type {
  ContentDivergenceCurrentState,
  ContentDivergenceWarning,
} from '@inkeep/open-knowledge-core';

export const CONTENT_DIVERGENCE_CAP_BYTES = 50 * 1024;

const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

export type ContentDivergenceLabel = 'replace' | 'append' | 'prepend' | 'patch' | 'rollback';

export interface AgentWriteContentDivergence {
  intendedBytes: number;
  actualBytes: number;
  byteDelta: number;
  divergenceType: string;
  currentState: ContentDivergenceCurrentState;
}

export function capContent(content: string): ContentDivergenceCurrentState {
  const bytes = byteLength(content);
  if (bytes <= CONTENT_DIVERGENCE_CAP_BYTES) {
    return { kind: 'inline', content };
  }
  return {
    kind: 'truncated',
    byteLength: bytes,
    hint: 'Converged content exceeds the inline cap — re-read via exec("cat <doc>") for the full document.',
  };
}

export function evaluateContentDivergence(
  actualContent: string,
  intendedContent: string,
  label: ContentDivergenceLabel,
): AgentWriteContentDivergence | undefined {
  if (actualContent === intendedContent) return undefined;
  const intendedBytes = byteLength(intendedContent);
  const actualBytes = byteLength(actualContent);
  return {
    intendedBytes,
    actualBytes,
    byteDelta: actualBytes - intendedBytes,
    divergenceType: `${label}-content-mismatch`,
    currentState: capContent(actualContent),
  };
}

const DEFAULT_DIVERGENCE_HINT =
  'The converged document differs from the bytes you composed. The write landed; `currentState` carries what is in the document now — re-read only if it is truncated.';

export function toContentDivergenceWarning(
  d: AgentWriteContentDivergence,
  hint: string = DEFAULT_DIVERGENCE_HINT,
): ContentDivergenceWarning {
  return {
    kind: 'content-divergence',
    intendedBytes: d.intendedBytes,
    actualBytes: d.actualBytes,
    byteDelta: d.byteDelta,
    divergenceType: d.divergenceType,
    currentState: d.currentState,
    hint,
  };
}
