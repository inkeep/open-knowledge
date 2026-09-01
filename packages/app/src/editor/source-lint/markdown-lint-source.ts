import { type Action, type Diagnostic, linter, lintGutter } from '@codemirror/lint';
import type { Extension, Text } from '@codemirror/state';
import type { LintDiagnostic, LinterConfig, LintPosition } from '@inkeep/open-knowledge-core';
import { lintDocument } from '@inkeep/open-knowledge-core';

export function createMarkdownLintExtension(config: LinterConfig, docName?: string): Extension {
  if (!config.enabled) return [];
  return [
    lintGutter(),
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

function offsetOf(doc: Text, position: LintPosition): number {
  const lineNumber = Math.min(Math.max(position.line + 1, 1), doc.lines);
  const line = doc.line(lineNumber);
  return Math.min(line.from + Math.max(0, position.character), line.to);
}

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
      view.dispatch({
        changes: fixes.map((fix) => ({
          from: offsetOf(doc, fix.range.start),
          to: offsetOf(doc, fix.range.end),
          insert: fix.newText,
        })),
        userEvent: 'input.complete',
      });
    },
  };
}
