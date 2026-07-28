/**
 * Unit tests for the WYSIWYG lint→block mapping. `mapDiagnosticsToBlocks`
 * groups source-line diagnostics by the top-level mdast block they fall in,
 * which is what the plugin then maps onto top-level PM nodes (1:1 by the
 * bridge invariant — the fragment derives from parse of the same Y.Text
 * source the diagnostics were linted against).
 */

import {
  sharedExtensions as coreExtensions,
  type LintDiagnostic,
  MarkdownManager,
} from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import {
  blockIndexForLine,
  computeSourceBlockSpans,
  mapDiagnosticsToBlocks,
} from './markdown-lint-decorations.ts';

const md = new MarkdownManager({ extensions: coreExtensions });

function diag(line: number, over: Partial<LintDiagnostic> = {}): LintDiagnostic {
  // `line` is 1-based (the mdast/source convention these tests reason in).
  return {
    range: { start: { line: line - 1, character: 0 }, end: { line: line - 1, character: 1 } },
    severity: 'warning',
    source: 'markdownlint',
    code: 'MD010',
    message: 'Hard tabs',
    ...over,
  };
}

describe('mapDiagnosticsToBlocks', () => {
  test('returns an empty map for no diagnostics', () => {
    expect(mapDiagnosticsToBlocks('# A\n\nbody\n', [], md).size).toBe(0);
  });

  // body:
  //   1: # Heading
  //   2:
  //   3: First paragraph.
  //   4:
  //   5: Second paragraph.
  const body = '# Heading\n\nFirst paragraph.\n\nSecond paragraph.\n';

  test('maps a diagnostic to the block index that contains its line', () => {
    // line 1 → block 0 (heading), line 3 → block 1, line 5 → block 2.
    const byBlock = mapDiagnosticsToBlocks(body, [diag(1), diag(3), diag(5)], md);
    expect([...byBlock.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect(byBlock.get(0)?.[0]?.range.start.line).toBe(0);
    expect(byBlock.get(1)?.[0]?.range.start.line).toBe(2);
    expect(byBlock.get(2)?.[0]?.range.start.line).toBe(4);
  });

  test('groups multiple diagnostics on the same block', () => {
    const byBlock = mapDiagnosticsToBlocks(body, [diag(3), diag(3, { code: 'MD009' })], md);
    expect(byBlock.size).toBe(1);
    expect(byBlock.get(1)).toHaveLength(2);
  });

  test('maps any line within a multi-line block to that one block', () => {
    // A fenced code block spans several source lines; a diagnostic on any of
    // them belongs to the single code block.
    const codeBody = 'intro para\n\n```\nline a\nline b\n```\n';
    // lines: 1 para, 3-6 code fence
    const byBlock = mapDiagnosticsToBlocks(codeBody, [diag(4)], md);
    expect(byBlock.size).toBe(1);
    // block 0 = paragraph, block 1 = code
    expect(byBlock.has(1)).toBe(true);
  });

  test('anchors a between-block diagnostic (blank-line run) to the NEXT block', () => {
    // line 2 is the blank line between heading and paragraph — where rules
    // like MD012 (multiple blank lines) report. It anchors to the following
    // block instead of being dropped.
    const byBlock = mapDiagnosticsToBlocks(body, [diag(2, { code: 'MD012' })], md);
    expect(byBlock.size).toBe(1);
    expect(byBlock.has(1)).toBe(true);
  });

  test('anchors a trailing diagnostic (past the last block) to the LAST block', () => {
    // e.g. MD047 (file should end with a single newline) on a trailing blank.
    const byBlock = mapDiagnosticsToBlocks(body, [diag(6, { code: 'MD047' })], md);
    expect(byBlock.size).toBe(1);
    expect(byBlock.has(2)).toBe(true);
  });

  test('keeps a loose list as a single block (line-span, not blank-line split)', () => {
    // A loose list has blank lines between items but is ONE top-level block —
    // both item diagnostics must land on the same block index.
    const listBody = '- one\n\n- two\n\n- three\n';
    const byBlock = mapDiagnosticsToBlocks(listBody, [diag(1), diag(5)], md);
    expect(byBlock.size).toBe(1);
    expect(byBlock.get(0)).toHaveLength(2);
  });

  // source with frontmatter:
  //   1: ---
  //   2: title: X
  //   3: ---
  //   4: # Heading
  //   5:
  //   6: Paragraph.
  const fmSource = '---\ntitle: X\n---\n# Heading\n\nParagraph.\n';

  test('shifts block mapping under a frontmatter region (full-source lines)', () => {
    // Diagnostics carry FULL-source lines (markdownlint skips the FM region
    // itself but keeps absolute numbering): line 4 → block 0, line 6 → block 1.
    const byBlock = mapDiagnosticsToBlocks(fmSource, [diag(4), diag(6)], md);
    expect([...byBlock.keys()].sort((a, b) => a - b)).toEqual([0, 1]);
  });

  test('skips a diagnostic inside the frontmatter region (no WYSIWYG anchor)', () => {
    const byBlock = mapDiagnosticsToBlocks(fmSource, [diag(2)], md);
    expect(byBlock.size).toBe(0);
  });
});

describe('computeSourceBlockSpans', () => {
  test('spans are in full-source coordinates when frontmatter is present', () => {
    const { spans, fmLineCount } = computeSourceBlockSpans(
      '---\ntitle: X\n---\n# Heading\n\nParagraph.\n',
      md,
    );
    expect(fmLineCount).toBe(3);
    expect(spans).toEqual([
      { start: 4, end: 4 },
      { start: 6, end: 6 },
    ]);
  });

  test('no frontmatter → zero offset', () => {
    const { spans, fmLineCount } = computeSourceBlockSpans('# H\n\nP\n', md);
    expect(fmLineCount).toBe(0);
    expect(spans[0]).toEqual({ start: 1, end: 1 });
  });

  test('empty body → no spans', () => {
    expect(computeSourceBlockSpans('', md).spans).toHaveLength(0);
  });
});

describe('blockIndexForLine', () => {
  const spans = [
    { start: 1, end: 1 },
    { start: 3, end: 6 },
    { start: 8, end: 8 },
  ];

  test('line inside a span → that block', () => {
    expect(blockIndexForLine(spans, 4)).toBe(1);
  });

  test('line in a gap → the following block', () => {
    expect(blockIndexForLine(spans, 2)).toBe(1);
    expect(blockIndexForLine(spans, 7)).toBe(2);
  });

  test('line past the last span → the last block', () => {
    expect(blockIndexForLine(spans, 12)).toBe(2);
  });

  test('no spans → null', () => {
    expect(blockIndexForLine([], 1)).toBeNull();
  });
});
