import {
  composeFixAllProblemsPrompt,
  composeLintFixPrompt,
  type LintDiagnostic,
  MARKDOWNLINT_RULE_CATALOG,
} from '@inkeep/open-knowledge-core';
import { docNameToRelativePath } from '@/lib/workspace-paths';

const ALIAS_BY_CODE = new Map(MARKDOWNLINT_RULE_CATALOG.map((rule) => [rule.id, rule.alias]));

/** The diagnostic fields both composers read. Structural over the wire shape:
 *  the unified Problems panel hands diagnostics whose `source` is any validator
 *  id, not the in-process lint-plugin literal union. */
type ComposableDiagnostic = Pick<LintDiagnostic, 'code' | 'message' | 'range'> & {
  readonly source: string;
};

/** Rule alias, when the diagnostic came from markdownlint and the code is known. */
function aliasOf(diagnostic: ComposableDiagnostic): string | undefined {
  return diagnostic.source === 'markdownlint' ? ALIAS_BY_CODE.get(diagnostic.code) : undefined;
}

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
  diagnostic: ComposableDiagnostic,
  lineText: string | undefined,
): string {
  return composeLintFixPrompt({
    relativePath: docNameToRelativePath(docName),
    source: diagnostic.source,
    code: diagnostic.code,
    ruleAlias: aliasOf(diagnostic),
    message: diagnostic.message,
    line: diagnostic.range.start.line + 1,
    column: diagnostic.range.start.character + 1,
    lineText,
  });
}

/**
 * Bulk sibling of {@link composeLintFixTerminalPaste} for the Problems panel's
 * "Fix all with AI" button. `docName` names the open doc (doc scope) or is null
 * for the whole project; only the doc case needs the docName-to-path mapping.
 *
 * Carries no diagnostics — see `composeFixAllProblemsPrompt` for why the agent
 * reads its own list instead.
 */
export function composeFixAllProblemsTerminalPaste(docName: string | null): string {
  return composeFixAllProblemsPrompt(docName === null ? null : docNameToRelativePath(docName));
}
