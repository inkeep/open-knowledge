import type { LintDiagnostic } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import {
  composeFixAllProblemsTerminalPaste,
  composeLintFixTerminalPaste,
} from './compose-lint-fix-prompt.ts';

function diag(over: Partial<LintDiagnostic> = {}): LintDiagnostic {
  return {
    range: { start: { line: 11, character: 2 }, end: { line: 11, character: 3 } },
    severity: 'warning',
    source: 'markdownlint',
    code: 'MD010',
    message: 'Hard tabs',
    ...over,
  };
}

describe('composeLintFixTerminalPaste', () => {
  test('grounds the paste with the .md-suffixed doc path and 1-based position', () => {
    const paste = composeLintFixTerminalPaste('guides/setup', diag(), '\tindented');
    expect(paste).toContain('@guides/setup.md');
    // 0-based LSP range start (11,2) renders as line 12, column 3.
    expect(paste).toContain('at line 12, column 3');
    expect(paste).toContain('\tindented');
  });

  test('resolves the primary markdownlint alias from the generated catalog', () => {
    const paste = composeLintFixTerminalPaste('notes', diag(), undefined);
    expect(paste).toContain('markdownlint/MD010 (no-hard-tabs)');
  });

  test('a non-markdownlint source carries no alias', () => {
    const paste = composeLintFixTerminalPaste(
      'notes',
      diag({ source: 'frontmatter', code: 'FM001' }),
      undefined,
    );
    expect(paste).toContain('frontmatter/FM001 at');
    expect(paste).not.toContain('FM001 (');
  });
});

describe('composeFixAllProblemsTerminalPaste', () => {
  test('maps an extension-less docName to its path for the doc scope', () => {
    const paste = composeFixAllProblemsTerminalPaste('guides/setup');
    expect(paste).toContain('@guides/setup.md');
    expect(paste).not.toContain('setup.md.md');
    expect(paste).toContain('Run the `audit` tool scoped to it');
  });

  test('null docName asks for the whole project and mentions no doc', () => {
    const paste = composeFixAllProblemsTerminalPaste(null);
    expect(paste).toContain("across this project's documents");
    expect(paste).not.toContain('@');
  });
});
