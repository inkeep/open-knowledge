import {
  composeLintFixPrompt,
  type LintDiagnostic,
  MARKDOWNLINT_RULE_CATALOG,
} from '@inkeep/open-knowledge-core';
import { docNameToRelativePath } from '@/lib/workspace-paths';

const ALIAS_BY_CODE = new Map(MARKDOWNLINT_RULE_CATALOG.map((rule) => [rule.id, rule.alias]));

/**
 * Grounded lint-fix paste for a terminal CLI: the doc named as an `@`-mention,
 * one diagnostic located precisely (rule, line, column, message, offending
 * line), and a fix-via-OK-MCP directive. The Problems panel "Ask AI" button
 * fires this through `requestActiveTerminalInput` — same transport as the
 * selection paste, so a live agent TUI receives it for review-before-send.
 *
 * `lineText` is the offending source line read from `Y.Text('source')` at
 * click time; the composer omits its block when unavailable.
 */
export function composeLintFixTerminalPaste(
  docName: string,
  // Structural over the fields actually read: the unified Problems panel
  // hands wire-shape diagnostics whose `source` is any validator id, not the
  // in-process lint-plugin literal union. `LintDiagnostic` remains assignable.
  diagnostic: Pick<LintDiagnostic, 'code' | 'message' | 'range'> & { source: string },
  lineText: string | undefined,
): string {
  return composeLintFixPrompt({
    relativePath: docNameToRelativePath(docName),
    source: diagnostic.source,
    code: diagnostic.code,
    ruleAlias:
      diagnostic.source === 'markdownlint' ? ALIAS_BY_CODE.get(diagnostic.code) : undefined,
    message: diagnostic.message,
    line: diagnostic.range.start.line + 1,
    column: diagnostic.range.start.character + 1,
    lineText,
  });
}
