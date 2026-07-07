/**
 * Site A content-divergence gate — shared predicate.
 *
 * After an agent-write primitive runs (inside the caller's transact, before it
 * closes), the converged `Y.Text('source')` bytes should byte-equal the bytes
 * the handler composed. When they don't, this gate produces an observational
 * `AgentWriteContentDivergence` that the handler surfaces as a `warning` on its
 * 200 success envelope — NOT a hard error; the write still landed.
 *
 * Scope: in-transact, single-writer. Post-transact concurrent-peer residue is
 * out of scope (a separate post-transact concern). In the single-writer case
 * the primitive's byte-faithful contract guarantees equality, so a fire here
 * signals a primitive regression or an observer-side canonicalization leak —
 * and the gate hands the agent the converged content inline so it can recover
 * without a second read.
 *
 * Shared by `applyAgentMarkdownWrite` (write / edit) and
 * `handleRollback`: one predicate, three call sites.
 */
import type {
  ContentDivergenceCurrentState,
  ContentDivergenceWarning,
} from '@inkeep/open-knowledge-core';

/**
 * Soft cap for the inline `currentState` payload. Matches the `exec` tool's
 * 50 KB soft cap (the established read-surface convention — OK has no dedicated
 * read_document tool; reads go through `exec("cat …")`). Over the cap,
 * `currentState` degrades to a `truncated` marker and the agent re-reads.
 *
 * Measured in UTF-8 bytes (see {@link byteLength}), so the cap is a true 50 KB
 * wire/disk bound rather than a UTF-16 code-unit count.
 */
export const CONTENT_DIVERGENCE_CAP_BYTES = 50 * 1024;

/** UTF-8 byte length — the unit the `*Bytes` fields and the cap report. */
const byteLength = (s: string): number => Buffer.byteLength(s, 'utf8');

/**
 * The write surface a divergence is attributed to. Bounded so `divergenceType`
 * (and any span attribute derived from it) stays low-cardinality per the OTel
 * STOP rule.
 */
export type ContentDivergenceLabel = 'replace' | 'append' | 'prepend' | 'patch' | 'rollback';

/**
 * Post-write content-divergence signal (server-internal). Mapped to the wire
 * `ContentDivergenceWarning` via {@link toContentDivergenceWarning}.
 *
 * `byteDelta = actualBytes - intendedBytes` (signed).
 */
export interface AgentWriteContentDivergence {
  intendedBytes: number;
  actualBytes: number;
  byteDelta: number;
  /** `<label>-content-mismatch`, e.g. `replace-content-mismatch`. */
  divergenceType: string;
  /** Converged content inline, or a truncation marker over the soft cap. */
  currentState: ContentDivergenceCurrentState;
}

/**
 * Cap the converged content for inline delivery: full bytes under the soft
 * cap, else a truncation marker pointing the agent at `exec("cat …")`.
 */
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

/**
 * Compare the converged bytes against the bytes the handler composed. Returns
 * `undefined` when they match (the common, no-warning path), else a populated
 * divergence carrying the inline converged content + a coarse type label.
 *
 * @param actualContent post-primitive `ytext.toString()`.
 * @param intendedContent the bytes the handler composed.
 * @param label the write surface — used to build `divergenceType` (the agent
 *   position `replace` / `patch` / `append` / `prepend`, or `rollback`).
 */
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

/**
 * Map the server-internal divergence to the wire `warning`. The single
 * construction site for all three handlers.
 */
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
