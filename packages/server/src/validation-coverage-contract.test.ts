import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isMutatingParserReservation,
  LINT_PLUGIN_IDS,
  VALIDATION_SOURCES,
} from '@inkeep/open-knowledge-core';
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
const OKF_PLUGIN = readFileSync(
  join(import.meta.dir, '../../../docs/content/plugins/okf.mdx'),
  'utf8',
);

function formatCodepoint(codepoint: number): string {
  return `U+${codepoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

function documentedParserReservations(): string[] {
  const clause = /Parser-reserved Private Use Area code points (.+?) are also replaced/.exec(
    OKF_PLUGIN,
  )?.[1];
  if (clause === undefined) throw new Error('OKF parser-reservation disclosure is missing');
  return [...clause.matchAll(/U\+([0-9A-F]{4,6})(?:–U\+([0-9A-F]{4,6}))?/g)].flatMap(
    ([, startHex, endHex]) => {
      const start = Number.parseInt(startHex ?? '', 16);
      const end = Number.parseInt(endHex ?? startHex ?? '', 16);
      return Array.from({ length: end - start + 1 }, (_, offset) =>
        formatCodepoint(start + offset),
      );
    },
  );
}

function mcpReferenceRow(tool: string): string {
  const row = MCP_REFERENCE.split('\n').find((line) => line.startsWith(`| \`${tool}\` |`));
  if (row === undefined) throw new Error(`no mcp.mdx table row for \`${tool}\``);
  return row;
}

describe('validation coverage source contract', () => {
  test('OKF documents every parser reservation neutralized by generated indexes', () => {
    const executable = Array.from({ length: 0xf8ff - 0xe000 + 1 }, (_, offset) => 0xe000 + offset)
      .filter((codepoint) => isMutatingParserReservation(String.fromCodePoint(codepoint)))
      .map(formatCodepoint);
    expect(documentedParserReservations()).toEqual(executable);
  });

  test('tool descriptions name every source family they can select', () => {
    for (const source of LINT_PLUGIN_IDS) expect(LINT_DESCRIPTION).toContain(`\`${source}\``);
    for (const source of VALIDATION_SOURCES) expect(AUDIT_DESCRIPTION).toContain(`\`${source}\``);
  });

  test('every surface states the absence inference, not just the enumeration', () => {
    const clause = 'absent from `ran` was not checked';
    expect(LINT_DESCRIPTION).toContain(clause);
    expect(AUDIT_DESCRIPTION).toContain(clause);
    expect(PROJECT_SKILL).toContain(clause);
    expect(CONTENT_RULES_OVERVIEW).toContain(clause);
    expect(mcpReferenceRow('lint')).toContain(clause);
    expect(mcpReferenceRow('audit')).toContain(clause);
  });

  test('agent guidance and public docs explain ran in lockstep', () => {
    expect(PROJECT_SKILL).toContain('Read `ran`');
    expect(PROJECT_SKILL).toContain('`[]` means no checks were selected');

    expect(mcpReferenceRow('lint')).toContain('Successful responses include `ran`');
    expect(mcpReferenceRow('audit')).toContain('Successful responses include `ran`');
    expect(mcpReferenceRow('audit')).toContain('remains in `ran` if it degrades');

    expect(CONTENT_RULES_OVERVIEW).toContain('"ran": [');
    expect(CONTENT_RULES_OVERVIEW).toContain('The top-level `ran` array');
    expect(CONTENT_RULES_OVERVIEW).toContain("The audit's top-level `ran` array");
    expect(CONTENT_RULES_OVERVIEW).toContain('selected validator degrades');
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
