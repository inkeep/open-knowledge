/**
 * Shared validation-results store: per-doc problem counts read by BOTH the
 * Problems panel and the file tree (the tree tints/badges rows from it).
 * Module store + subscribe (the codebase's module-event idiom;
 * `useSyncExternalStore`-compatible) rather than React context — the file
 * tree consumes it from a MutationObserver callback outside React.
 *
 * Counts are tracked per validator source so the three freshness triggers can
 * write independently without clobbering each other:
 *  1. a project audit replaces the WHOLE store (both sources, every doc);
 *  2. the open doc's lint entry is written live off the `useDocDiagnostics`
 *     debounce, and its links entry off the doc-scoped audit fetch;
 *  3. a persisted doc (CC1 `disk-ack`, the one per-doc channel) is re-validated
 *     alone and patched (both sources).
 * Never a background whole-project walk.
 */

import { filePathToDocName } from '@/lib/doc-hash';

export interface DocProblemCounts {
  errorCount: number;
  warningCount: number;
}

export type ValidationSourceKey = 'lint' | 'links';

interface DiagnosticShape {
  severity: string;
  source: string;
}

interface SourceCounts {
  lint: DocProblemCounts;
  links: DocProblemCounts;
}

const ZERO: DocProblemCounts = { errorCount: 0, warningCount: 0 };

/** Keyed by extension-less docName. */
const entries = new Map<string, SourceCounts>();
const listeners = new Set<() => void>();
/**
 * Immutable totals snapshot handed to `useSyncExternalStore` consumers and
 * the tree's apply pass. Rebuilt on every mutation; docs whose merged counts
 * are all zero are dropped so `snapshot.has(docName)` means "has problems".
 */
let snapshot: ReadonlyMap<string, DocProblemCounts> = new Map();

function rebuildSnapshotAndNotify(): void {
  const next = new Map<string, DocProblemCounts>();
  for (const [docName, counts] of entries) {
    const errorCount = counts.lint.errorCount + counts.links.errorCount;
    const warningCount = counts.lint.warningCount + counts.links.warningCount;
    if (errorCount === 0 && warningCount === 0) continue;
    next.set(docName, { errorCount, warningCount });
  }
  snapshot = next;
  for (const listener of listeners) listener();
}

/** Split one doc's diagnostics into per-source counts ('links' vs everything else). */
function countBySource(diagnostics: readonly DiagnosticShape[]): SourceCounts {
  const counts: SourceCounts = {
    lint: { errorCount: 0, warningCount: 0 },
    links: { errorCount: 0, warningCount: 0 },
  };
  for (const diagnostic of diagnostics) {
    const bucket = diagnostic.source === 'links' ? counts.links : counts.lint;
    if (diagnostic.severity === 'error') bucket.errorCount += 1;
    else bucket.warningCount += 1;
  }
  return counts;
}

export function subscribeToValidationStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Merged per-doc totals; only docs with at least one problem are present. */
export function getValidationSnapshot(): ReadonlyMap<string, DocProblemCounts> {
  return snapshot;
}

/**
 * Trigger 1 — a whole-project audit is a full-plane truth: replace every
 * entry (docs healed since the last audit drop out).
 */
export function replaceValidationFromAudit(
  files: readonly { file: string; diagnostics: readonly DiagnosticShape[] }[],
): void {
  entries.clear();
  for (const file of files) {
    entries.set(filePathToDocName(file.file), countBySource(file.diagnostics));
  }
  rebuildSnapshotAndNotify();
}

/**
 * Trigger 3 — one doc re-validated (scoped audit): both sources for that doc
 * are fresh truth; an empty plane means the doc healed.
 */
export function patchDocValidationFromAudit(
  docName: string,
  diagnostics: readonly DiagnosticShape[],
): void {
  entries.set(docName, countBySource(diagnostics));
  rebuildSnapshotAndNotify();
}

/**
 * Trigger 2 — one source's live counts for the open doc (lint off the CRDT
 * debounce, links off the doc-scoped fetch), preserving the other source.
 */
export function patchDocValidationSource(
  docName: string,
  source: ValidationSourceKey,
  counts: DocProblemCounts,
): void {
  const current = entries.get(docName) ?? { lint: ZERO, links: ZERO };
  const existing = current[source];
  if (existing.errorCount === counts.errorCount && existing.warningCount === counts.warningCount) {
    return;
  }
  entries.set(docName, { ...current, [source]: counts });
  rebuildSnapshotAndNotify();
}

export function resetValidationStoreForTest(): void {
  entries.clear();
  snapshot = new Map();
  listeners.clear();
}
