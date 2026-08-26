import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LINT_PLUGIN_IDS, VALIDATION_SOURCES } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { formatValidatorDegradationWarning } from './lint/validation-audit.ts';
import { DESCRIPTION as AUDIT_DESCRIPTION, AUDIT_WARNINGS_DESCRIPTION } from './mcp/tools/audit.ts';
import { DESCRIPTION as LINT_DESCRIPTION, LINT_WARNINGS_DESCRIPTION } from './mcp/tools/lint.ts';

const PROJECT_SKILL = readFileSync(
  join(import.meta.dir, '../assets/skills/project/SKILL.md'),
  'utf8',
);
const CONTENT_RULES_OVERVIEW = readFileSync(
  join(import.meta.dir, '../../../docs/content/advanced/content-rules/overview.mdx'),
  'utf8',
);
const MCP_REFERENCE = readFileSync(
  join(import.meta.dir, '../../../docs/content/reference/mcp.mdx'),
  'utf8',
);

/** The one row of `mcp.mdx`'s tool table that documents `tool`. */
function mcpReferenceRow(tool: string): string {
  const row = MCP_REFERENCE.split('\n').find((line) => line.startsWith(`| \`${tool}\` |`));
  if (row === undefined) throw new Error(`no mcp.mdx table row for \`${tool}\``);
  return row;
}

describe('validation coverage source contract', () => {
  test('tool descriptions name every source family they can select', () => {
    for (const source of LINT_PLUGIN_IDS) expect(LINT_DESCRIPTION).toContain(`\`${source}\``);
    for (const source of VALIDATION_SOURCES) expect(AUDIT_DESCRIPTION).toContain(`\`${source}\``);
  });

  test('every surface states the absence inference, not just the enumeration', () => {
    // The measured failure is the PARTIAL case — a roster that lists two
    // families while the one the task named is silently missing. Contraposing
    // that from an enumeration is a weaker signal than saying it outright, and
    // the DESCRIPTIONs are the surface an agent reads every turn.
    const clause = 'absent from `ran` was not checked';
    expect(LINT_DESCRIPTION).toContain(clause);
    expect(AUDIT_DESCRIPTION).toContain(clause);
    expect(PROJECT_SKILL).toContain(clause);
    expect(CONTENT_RULES_OVERVIEW).toContain(clause);
    expect(mcpReferenceRow('lint')).toContain(clause);
    expect(mcpReferenceRow('audit')).toContain(clause);
  });

  test('agent guidance and public docs explain ran in lockstep', () => {
    // Phrase pins, not bare source-id substrings: `markdownlint`, `frontmatter`,
    // and `links` each occur a dozen-plus times on these pages for unrelated
    // reasons, so a loop over the vocabulary stays green even if the whole `ran`
    // sentence is deleted from the row it documents.
    expect(PROJECT_SKILL).toContain('Read `ran`');
    expect(PROJECT_SKILL).toContain('`[]` means no checks were selected');

    expect(mcpReferenceRow('lint')).toContain('Successful responses include `ran`');
    expect(mcpReferenceRow('audit')).toContain('Successful responses include `ran`');
    expect(mcpReferenceRow('audit')).toContain('remains in `ran` if it degrades');

    expect(CONTENT_RULES_OVERVIEW).toContain('"ran": [');
    expect(CONTENT_RULES_OVERVIEW).toContain('The top-level `ran` array');
    expect(CONTENT_RULES_OVERVIEW).toContain("The audit's top-level `ran` array");
    expect(CONTENT_RULES_OVERVIEW).toContain('selected validator degrades');
    // The zero state is the DEFAULT first-run output — every linter ships off —
    // so the string a user searches for has to appear on the page.
    expect(CONTENT_RULES_OVERVIEW).toContain('No checks ran.');
  });

  test('the audit warning field explains family degradation and its ran join', () => {
    const produced = formatValidatorDegradationWarning('links', 'test');
    expect(produced).toContain('validation degraded:');
    expect(AUDIT_WARNINGS_DESCRIPTION).toContain('validation degraded:');
    expect(AUDIT_WARNINGS_DESCRIPTION).toContain('still listed in `ran`');
    expect(LINT_WARNINGS_DESCRIPTION).toContain('still listed in `ran`');
    for (const surface of [
      AUDIT_WARNINGS_DESCRIPTION,
      AUDIT_DESCRIPTION,
      mcpReferenceRow('audit'),
      CONTENT_RULES_OVERVIEW,
    ]) {
      expect(surface).toContain('may still have contributed findings');
    }
  });

  test('every surface distinguishes document lint from project audit scope', () => {
    expect(LINT_DESCRIPTION).toContain(
      'Project-tree OKF checks and link validation run only through',
    );
    expect(AUDIT_DESCRIPTION).toContain('document and project-tree OKF checks here');
    expect(mcpReferenceRow('audit')).toContain(
      'Document and project-tree OKF checks share the `okf` family',
    );
    expect(CONTENT_RULES_OVERVIEW).toContain(
      "OKF's document and project-tree checks share the public `okf` family",
    );
  });

  test('every capped agent surface documents the warning ceiling and omission signal', () => {
    for (const surface of [
      LINT_DESCRIPTION,
      AUDIT_DESCRIPTION,
      mcpReferenceRow('lint'),
      mcpReferenceRow('audit'),
    ]) {
      expect(surface).toContain('project-wide at 10 warnings');
      expect(surface).toContain('omittedWarningCount');
    }
    expect(CONTENT_RULES_OVERVIEW).toContain('project-wide at 10 warnings');
    expect(CONTENT_RULES_OVERVIEW).toContain('omittedWarningCount');
  });
});
