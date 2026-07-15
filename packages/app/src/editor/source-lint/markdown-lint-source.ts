import { type Action, type Diagnostic, linter, lintGutter } from '@codemirror/lint';
import type { Extension, Text } from '@codemirror/state';
import type { LintDiagnostic, LinterConfig, LintPosition } from '@inkeep/open-knowledge-core';
import { lintDocument } from '@inkeep/open-knowledge-core';

/**
 * Source-mode markdown linter for CodeMirror. Wraps the framework-agnostic core
 * engine (`lintDocument`) in `@codemirror/lint`'s `linter()` facet: it produces
 * wavy underlines, the lint gutter, hover tooltips, and an inline "Fix" action
 * for auto-fixable rules. The diagnostics map the engine's 0-based LSP ranges
 * onto absolute CM offsets.
 *
 * Returns `[]` when linting is disabled so the gutter column disappears
 * entirely. Reconfigure the owning Compartment (in `SourceEditor.tsx`) when the
 * config changes — that re-runs the pass with the new rules.
 */
export function createMarkdownLintExtension(config: LinterConfig, docName?: string): Extension {
  if (!config.enabled) return [];
  return [
    lintGutter(),
    // 600ms trailing debounce keeps re-linting off the typing hot path. The
    // async source is native to @codemirror/lint — it re-checks doc currency
    // when the promise resolves.
    linter(
      async (view) =>
        mapLintDiagnostics(
          view.state.doc,
          await lintDocument(view.state.doc.toString(), config, docName),
        ),
      {
        delay: 600,
      },
    ),
  ];
}

/**
 * Clamped absolute CM offset for a 0-based LSP position. Lines are clamped —
 * the doc can shift between the async lint request and this mapping.
 */
function offsetOf(doc: Text, position: LintPosition): number {
  const lineNumber = Math.min(Math.max(position.line + 1, 1), doc.lines);
  const line = doc.line(lineNumber);
  return Math.min(line.from + Math.max(0, position.character), line.to);
}

/**
 * Map the engine's LSP-range diagnostics onto CodeMirror `Diagnostic`s against
 * `doc`. Pure (no `EditorView`) so it's unit-testable with an
 * `EditorState`-derived `Text` and no DOM.
 */
export function mapLintDiagnostics(doc: Text, results: LintDiagnostic[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const result of results) {
    const from = offsetOf(doc, result.range.start);
    const to = offsetOf(doc, result.range.end);

    const diagnostic: Diagnostic = {
      from,
      to: Math.max(to, from),
      severity: result.severity,
      message: result.message,
      source: `${result.source}/${result.code}`,
    };
    const action = fixAction(result);
    if (action) diagnostic.actions = [action];
    diagnostics.push(diagnostic);
  }
  return diagnostics;
}

function fixAction(result: LintDiagnostic): Action | null {
  const fixes = result.fixes;
  if (!fixes || fixes.length === 0) return null;
  return {
    name: 'Fix',
    apply(view) {
      const doc = view.state.doc;
      // Each `LintTextEdit` range is resolved against the pre-fix doc; CM
      // composes the change set atomically, so the offsets need no rebasing.
      view.dispatch({
        changes: fixes.map((fix) => ({
          from: offsetOf(doc, fix.range.start),
          to: offsetOf(doc, fix.range.end),
          insert: fix.newText,
        })),
      });
    },
  };
}
