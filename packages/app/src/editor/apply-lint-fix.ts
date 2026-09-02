import type { LintDiagnostic, LintPosition, LintTextEdit } from '@inkeep/open-knowledge-core';
import type * as Y from 'yjs';
import { requestPreviewTabPromotion } from './preview-tab-promotion';

export interface SourceWriteProvider {
  document: Y.Doc;
}

export const LINT_SOURCE_FIXED_EVENT = 'open-knowledge:lint-source-fixed';

const LINT_FIX_ORIGIN = Object.freeze({
  source: 'local' as const,
  skipStoreHooks: false,
  context: Object.freeze({ origin: 'lint-fix' as const }),
});

function offsetOf(source: string, pos: LintPosition): number {
  const lines = source.split('\n');
  let offset = 0;
  for (let i = 0; i < pos.line && i < lines.length; i += 1) offset += lines[i].length + 1;
  const lineLen = lines[Math.min(pos.line, lines.length - 1)]?.length ?? 0;
  return offset + Math.min(Math.max(pos.character, 0), lineLen);
}

export function collectFixes(diagnostics: readonly LintDiagnostic[]): LintTextEdit[] {
  return diagnostics.flatMap((d) => d.fixes ?? []);
}

export function applyLintFixes(
  provider: SourceWriteProvider,
  fixes: readonly LintTextEdit[],
  docName: string,
): boolean {
  if (fixes.length === 0) return false;
  const ytext = provider.document.getText('source');
  const source = ytext.toString();
  const edits = fixes
    .map((fix) => ({
      from: offsetOf(source, fix.range.start),
      to: offsetOf(source, fix.range.end),
      insert: fix.newText,
    }))
    .sort((a, b) => b.to - a.to || b.from - a.from || a.insert.localeCompare(b.insert));
  let appliedCount = 0;
  provider.document.transact(() => {
    let lowestAppliedFrom = Number.POSITIVE_INFINITY;
    let previous: (typeof edits)[number] | undefined;
    for (const edit of edits) {
      const isDuplicate =
        previous !== undefined &&
        edit.from === previous.from &&
        edit.to === previous.to &&
        edit.insert === previous.insert;
      previous = edit;
      if (isDuplicate || edit.to > lowestAppliedFrom) continue;
      if (edit.to > edit.from) ytext.delete(edit.from, edit.to - edit.from);
      if (edit.insert.length > 0) ytext.insert(edit.from, edit.insert);
      lowestAppliedFrom = edit.from;
      appliedCount += 1;
    }
  }, LINT_FIX_ORIGIN);
  if (appliedCount > 0) requestPreviewTabPromotion(docName);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(LINT_SOURCE_FIXED_EVENT));
  }
  return true;
}
