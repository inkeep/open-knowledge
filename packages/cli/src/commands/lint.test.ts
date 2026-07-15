/**
 * Unit tests for the `ok lint` human-readable report formatter. The walk/lint
 * pipeline is covered by `content/lint-runner.test.ts`; here we pin the output
 * shaping against a synthetic result (no fs).
 */

import { describe, expect, test } from 'bun:test';
import { isAbsolute } from 'node:path';
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
    ...over,
  };
}

describe('formatLintReport', () => {
  test('reports a clean run', async () => {
    const out = formatLintReport(result({ fileCount: 3 }));
    expect(out).toContain('No problems in 3 files');
  });

  test('groups diagnostics under their file with a summary', async () => {
    const out = formatLintReport(
      result({
        fileCount: 1,
        warningCount: 1,
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

  test('surfaces runner warnings', async () => {
    const out = formatLintReport(result({ warnings: ['could not read directory drafts'] }));
    expect(out).toContain('could not read directory drafts');
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
    // The prior hand-rolled `startsWith('/')` join produced `${cwd}/C:\docs`
    // on Windows-style inputs; resolve() yields one well-formed absolute path.
    const out = resolveTarget('sub/dir', cwd);
    expect(isAbsolute(out)).toBe(true);
    expect(out.includes(`${cwd}/${cwd}`)).toBe(false);
  });
});
