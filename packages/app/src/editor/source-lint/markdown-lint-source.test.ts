/**
 * Unit tests for the pure diagnostic mapping (0-based LSP ranges → absolute CM
 * offsets). Uses an `EditorState`-derived `Text` so it runs headless (no DOM),
 * matching the source-polish convention of testing the pure builder directly.
 */

import { lintGutter } from '@codemirror/lint';
import { EditorState } from '@codemirror/state';
import {
  DEFAULT_LINTER_CONFIG,
  type LintDiagnostic,
  type LintRange,
} from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import { createMarkdownLintExtension, mapLintDiagnostics } from './markdown-lint-source.ts';

const docOf = (text: string) => EditorState.create({ doc: text }).doc;

const range = (
  startLine: number,
  startCharacter: number,
  endLine: number,
  endCharacter: number,
): LintRange => ({
  start: { line: startLine, character: startCharacter },
  end: { line: endLine, character: endCharacter },
});

describe('mapLintDiagnostics', () => {
  test('maps a range to absolute offsets on the right line', () => {
    const doc = docOf('# Title\n\nhas a\ttab here\n');
    const results: LintDiagnostic[] = [
      {
        range: range(2, 5, 2, 6),
        severity: 'warning',
        source: 'markdownlint',
        code: 'MD010',
        message: 'Hard tabs',
      },
    ];
    const [d] = mapLintDiagnostics(doc, results);
    const line3 = doc.line(3);
    expect(d?.from).toBe(line3.from + 5);
    expect(d?.to).toBe(line3.from + 6);
    expect(d?.severity).toBe('warning');
    expect(d?.source).toBe('markdownlint/MD010');
  });

  test('a whole-line range spans to end of line', () => {
    const doc = docOf('---\nstatus: draft\n---\n');
    const results: LintDiagnostic[] = [
      {
        range: range(0, 0, 0, '---'.length),
        severity: 'warning',
        source: 'frontmatter',
        code: 'required',
        message: 'Frontmatter property "title" is required',
      },
    ];
    const [d] = mapLintDiagnostics(doc, results);
    const line1 = doc.line(1);
    expect(d?.from).toBe(line1.from);
    expect(d?.to).toBe(line1.to);
  });

  test('clamps an out-of-range line instead of throwing', () => {
    const doc = docOf('one line\n');
    const results: LintDiagnostic[] = [
      {
        range: range(998, 0, 998, 5),
        severity: 'warning',
        source: 'markdownlint',
        code: 'MD047',
        message: 'x',
      },
    ];
    expect(() => mapLintDiagnostics(doc, results)).not.toThrow();
    expect(mapLintDiagnostics(doc, results)).toHaveLength(1);
  });

  test('attaches a Fix action only when fixes are present', () => {
    const doc = docOf('a\tb\n');
    const base: LintDiagnostic = {
      range: range(0, 1, 0, 2),
      severity: 'warning',
      source: 'markdownlint',
      code: 'MD010',
      message: 'Hard tabs',
    };
    const withFix: LintDiagnostic[] = [
      { ...base, fixes: [{ range: range(0, 1, 0, 2), newText: '    ' }] },
    ];
    const noFix: LintDiagnostic[] = [base];
    expect(mapLintDiagnostics(doc, withFix)[0]?.actions).toHaveLength(1);
    expect(mapLintDiagnostics(doc, withFix)[0]?.actions?.[0]?.name).toBe('Fix');
    expect(mapLintDiagnostics(doc, noFix)[0]?.actions).toBeUndefined();
  });
});

describe('createMarkdownLintExtension', () => {
  test('returns an empty extension when disabled', () => {
    const ext = createMarkdownLintExtension({ ...DEFAULT_LINTER_CONFIG, enabled: false });
    expect(Array.isArray(ext) ? ext.length : 1).toBe(0);
  });

  test('returns lint extensions when enabled', () => {
    const ext = createMarkdownLintExtension({ ...DEFAULT_LINTER_CONFIG, enabled: true });
    // [lintGutter(), linter(...)] — a non-empty extension array.
    expect(Array.isArray(ext)).toBe(true);
    expect((ext as unknown[]).length).toBeGreaterThan(0);
    // Smoke: lintGutter is constructible in this environment.
    expect(lintGutter()).toBeDefined();
  });
});
