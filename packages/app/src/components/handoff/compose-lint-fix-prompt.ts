import {
  composeFixAllProblemsPrompt,
  composeLintFixPrompt,
  type LintDiagnostic,
  MARKDOWNLINT_RULE_CATALOG,
} from '@inkeep/open-knowledge-core';
import { docNameToRelativePath } from '@/lib/workspace-paths';

const ALIAS_BY_CODE = new Map(MARKDOWNLINT_RULE_CATALOG.map((rule) => [rule.id, rule.alias]));

type ComposableDiagnostic = Pick<LintDiagnostic, 'code' | 'message' | 'range'> & {
  readonly source: string;
};

function aliasOf(diagnostic: ComposableDiagnostic): string | undefined {
  return diagnostic.source === 'markdownlint' ? ALIAS_BY_CODE.get(diagnostic.code) : undefined;
}

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

export function composeFixAllProblemsTerminalPaste(docName: string | null): string {
  return composeFixAllProblemsPrompt(docName === null ? null : docNameToRelativePath(docName));
}
