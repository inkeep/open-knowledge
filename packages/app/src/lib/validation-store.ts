import {
  countDiagnosticsBySource,
  type ValidationDocCounts,
  type ValidationSourceCounts,
  type ValidationSourceKey,
} from '@inkeep/open-knowledge-core';
import { filePathToDocName } from '@/lib/doc-hash';

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

const entries = new Map<string, SourceCounts>();
const listeners = new Set<() => void>();
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

const countBySource: (diagnostics: readonly DiagnosticShape[]) => SourceCounts =
  countDiagnosticsBySource;

export function subscribeToValidationStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getValidationSnapshot(): ReadonlyMap<string, DocProblemCounts> {
  return snapshot;
}

export function replaceValidationFromAudit(
  files: readonly { file: string; diagnostics: readonly DiagnosticShape[] }[],
): void {
  entries.clear();
  for (const file of files) {
    entries.set(filePathToDocName(file.file), countBySource(file.diagnostics));
  }
  rebuildSnapshotAndNotify();
}

export function replaceValidationFromCounts(files: readonly ValidationDocCounts[]): void {
  entries.clear();
  for (const file of files) {
    entries.set(filePathToDocName(file.file), { lint: file.lint, links: file.links });
  }
  rebuildSnapshotAndNotify();
}

export function patchDocValidationFromAudit(
  docName: string,
  diagnostics: readonly DiagnosticShape[],
): void {
  entries.set(docName, countBySource(diagnostics));
  rebuildSnapshotAndNotify();
}

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
