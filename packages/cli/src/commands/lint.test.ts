import { isAbsolute } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { LintRunResult } from '../content/lint-runner.ts';
import { formatLintReport, resolveTarget } from './lint.ts';

function result(over: Partial<LintRunResult> = {}): LintRunResult {
  return {
    contentDir: '/x',
    files: [],
    warnings: [],
    fileCount: 0,
    errorCount: 0,
    warningCount: 0,
    fixedCount: 0,
    ran: ['markdownlint'],
    ...over,
  };
}

describe('formatLintReport', () => {
  test('reports a clean run', async () => {
    const out = formatLintReport(result({ fileCount: 3 }));
    expect(out).toContain('No problems in 3 files');
    expect(out).toContain('Checks run: markdownlint.');
  });

  test('groups diagnostics under their file with a summary', async () => {
    const out = formatLintReport(
      result({
        fileCount: 1,
        warningCount: 1,
        warnings: ['could not read directory drafts'],
        files: [
          {
            file: 'a.md',
            fixed: false,
            diagnostics: [
              {
                range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } },
                severity: 'warning',
                source: 'markdownlint',
                code: 'MD010',
                message: 'Hard tabs',
              },
            ],
          },
        ],
      }),
    );
    expect(out).toContain('a.md');
    expect(out).toContain('Hard tabs');
    expect(out).toContain('markdownlint/MD010');
    expect(out).toContain('1 problem');
    expect(out).toContain('Checks run: markdownlint.');
    expect(out.indexOf('Checks run: markdownlint.')).toBeLessThan(
      out.indexOf('could not read directory drafts'),
    );
  });

  test('marks fixed files and shows a fixed summary', async () => {
    const out = formatLintReport(
      result({
        fileCount: 1,
        fixedCount: 1,
        files: [{ file: 'a.md', fixed: true, diagnostics: [] }],
      }),
    );
    expect(out).toContain('Fixed 1 file');
  });

  test('surfaces runner warnings after the summary, not before it', async () => {
    const out = formatLintReport(
      result({ fileCount: 500, warnings: ['could not read directory drafts'] }),
    );
    expect(out).toContain('could not read directory drafts');
    expect(out.indexOf('could not read directory drafts')).toBeGreaterThan(
      out.indexOf('No problems in 500 files'),
    );
    expect(out.indexOf('Checks run: markdownlint.')).toBeLessThan(
      out.indexOf('could not read directory drafts'),
    );
  });

  test('distinguishes an explicit empty selection from an older response', () => {
    expect(formatLintReport(result({ ran: [] }))).toContain('No checks ran.');
    expect(formatLintReport(result({ ran: undefined }))).not.toContain('Checks run:');
    expect(formatLintReport(result({ ran: undefined }))).not.toContain('No checks ran.');
  });
});

describe('resolveTarget', () => {
  const cwd = '/home/user/project';

  test('joins a relative path onto the invocation cwd', () => {
    expect(resolveTarget('guides/intro.md', cwd)).toBe('/home/user/project/guides/intro.md');
  });

  test('normalizes a leading-dot relative path (no doubled segment)', () => {
    expect(resolveTarget('./foo', cwd)).toBe('/home/user/project/foo');
  });

  test('returns a POSIX-absolute input unchanged', () => {
    expect(resolveTarget('/etc/docs', cwd)).toBe('/etc/docs');
  });

  test('produces a single absolute path (never the cwd-prefixed concat bug)', () => {
    const out = resolveTarget('sub/dir', cwd);
    expect(isAbsolute(out)).toBe(true);
    expect(out.includes(`${cwd}/${cwd}`)).toBe(false);
  });
});

describe('formatLintReport — frontmatter diagnostics', () => {
  test('renders the composed frontmatter/<keyword> id with 1-based display line', async () => {
    const out = formatLintReport(
      result({
        fileCount: 1,
        warningCount: 1,
        files: [
          {
            file: 'docs/guide.md',
            fixed: false,
            diagnostics: [
              {
                range: { start: { line: 1, character: 0 }, end: { line: 1, character: 15 } },
                severity: 'warning',
                source: 'frontmatter',
                code: 'enum',
                message: 'Frontmatter property "status" must be one of: draft, review, published',
              },
            ],
          },
        ],
      }),
    );
    expect(out).toContain('frontmatter/enum');
    expect(out).toContain('2:1');
  });
});
