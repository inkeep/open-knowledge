/**
 * Apply markdownlint auto-fixes to `Y.Text('source')` from any surface (the
 * Problems panel, the WYSIWYG lint tooltip). Source mode gets this for free via
 * CodeMirror's lint `Action`; WYSIWYG and the panel have no CM view, so they
 * write the same `LintTextEdit`s straight to the source CRDT and let the bridge
 * repaint the fragment — mirroring how the property panel edits source via
 * `FORM_WRITE_ORIGIN`.
 */

import type { LintDiagnostic, LintPosition, LintTextEdit } from '@inkeep/open-knowledge-core';
import type * as Y from 'yjs';

/** Minimal provider shape — just the Y.Doc, so this stays test-friendly. */
export interface SourceWriteProvider {
  document: Y.Doc;
}

/**
 * Frozen local origin for lint auto-fix writes. Mirrors `FORM_WRITE_ORIGIN`'s
 * shape (single-root Y.Text writer; the server's Observer B recomposes the
 * fragment on sync). Distinct `context.origin` keeps the write's provenance
 * legible to any client-side observer that inspects origins.
 */
/**
 * Fired on `window` after a fix lands on `Y.Text('source')`. A source-only fix
 * (trailing spaces, hard tabs, blank-line runs) changes the source bytes but
 * NOT the rendered ProseMirror doc, so the WYSIWYG lint decoration — which
 * recomputes on PM-doc changes — would otherwise leave a stale squiggle until
 * the next edit. The decoration extension listens for this and re-lints.
 */
export const LINT_SOURCE_FIXED_EVENT = 'open-knowledge:lint-source-fixed';

const LINT_FIX_ORIGIN = Object.freeze({
  source: 'local' as const,
  skipStoreHooks: false,
  context: Object.freeze({ origin: 'lint-fix' as const }),
});

/** 0-based LSP line/character → absolute offset into `source`, clamped to the line. */
function offsetOf(source: string, pos: LintPosition): number {
  const lines = source.split('\n');
  let offset = 0;
  for (let i = 0; i < pos.line && i < lines.length; i += 1) offset += lines[i].length + 1;
  const lineLen = lines[Math.min(pos.line, lines.length - 1)]?.length ?? 0;
  return offset + Math.min(Math.max(pos.character, 0), lineLen);
}

/** Every auto-fix edit carried by `diagnostics`, in document order. */
export function collectFixes(diagnostics: readonly LintDiagnostic[]): LintTextEdit[] {
  return diagnostics.flatMap((d) => d.fixes ?? []);
}

/**
 * Apply `fixes` to the provider's `Y.Text('source')` in one transaction.
 * Offsets are resolved against the pre-fix source, then applied high→low so an
 * earlier edit never shifts a later one's coordinates (matches how CodeMirror
 * composes a lint fix's change set). Returns false when there is nothing to do.
 *
 * Edits from DIFFERENT diagnostics may duplicate or overlap (e.g. a whole-line
 * delete swallowing another rule's same-line replace). Upstream markdownlint's
 * `applyFixes` skips such fixes rather than compounding them; mirror that:
 * exact duplicates apply once, and an edit overlapping an already-applied one
 * is dropped — it resurfaces as a live diagnostic on the post-fix re-lint.
 */
export function applyLintFixes(
  provider: SourceWriteProvider,
  fixes: readonly LintTextEdit[],
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
    // End-desc so a containing edit (whole-line delete) orders before edits
    // inside it — the container applies, the swallowed edit skips. For
    // non-overlapping edits this is the same high→low order as from-desc.
    .sort((a, b) => b.to - a.to || b.from - a.from || a.insert.localeCompare(b.insert));
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
    }
  }, LINT_FIX_ORIGIN);
  // Nudge any mounted WYSIWYG lint decoration to re-lint — a source-only fix
  // leaves the PM doc unchanged, so its PM-driven recompute never fires.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(LINT_SOURCE_FIXED_EVENT));
  }
  return true;
}
