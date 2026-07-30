/**
 * Shared validation-results store: per-doc problem counts read by BOTH the
 * Problems panel and the file tree (the tree tints/badges rows from it).
 * Module store + subscribe (the codebase's module-event idiom;
 * `useSyncExternalStore`-compatible) rather than React context — the file
 * tree consumes it from a MutationObserver callback outside React.
 *
 * Counts are tracked per validator source so the freshness triggers can write
 * independently without clobbering each other:
 *  1. a project audit replaces the WHOLE store (both sources, every doc);
 *  2. the open doc's lint entry is written live off the `useDocDiagnostics`
 *     debounce, and its links entry off the doc-scoped audit fetch;
 *  3. a persisted doc (CC1 `disk-ack`, the one per-doc channel) is re-validated
 *     alone and patched (both sources);
 *  4. a lint-config change (plugin enabled, rule toggled, schema edited)
 *     replaces the whole store from the counts-only audit plane — the config
 *     that produced every existing entry no longer holds;
 *  5. opening the project replaces the whole store once, so a KB configured in
 *     an earlier session is correct on arrival instead of empty until the user
 *     opens files or audits by hand (no project-size cap — the on-demand and
 *     config-change audits have none either).
 * No trigger polls. The two whole-project walks (4 and 5) fetch counts only,
 * single-flight, and coalesce server-side.
 */

import {
  countDiagnosticsBySource,
  type ValidationDocCounts,
  type ValidationSourceCounts,
  type ValidationSourceKey,
} from '@inkeep/open-knowledge-core';
import { filePathToDocName } from '@/lib/doc-hash';

/** Alias kept for existing call sites; the shape lives in core with the predicate. */
export type DocProblemCounts = ValidationSourceCounts;

export type { ValidationSourceKey };

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

/**
 * Split one doc's diagnostics into per-source counts. This is the SAME core
 * predicate the server tallies its counts-only audit plane with, so an entry
 * written from the enumerated plane and one written from the counts plane can
 * never disagree about the same doc.
 */
const countBySource: (diagnostics: readonly DiagnosticShape[]) => SourceCounts =
  countDiagnosticsBySource;

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
 * Trigger 4 — a counts-only project audit, same full-plane truth as trigger 1
 * but tallied server-side. Entries are already split by source, so nothing is
 * re-derived here; docs healed since the last audit drop out as they do for
 * trigger 1.
 */
export function replaceValidationFromCounts(files: readonly ValidationDocCounts[]): void {
  entries.clear();
  for (const file of files) {
    entries.set(filePathToDocName(file.file), { lint: file.lint, links: file.links });
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
