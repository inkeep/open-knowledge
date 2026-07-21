import { describe, expect, test } from 'vitest';
import { computeDiffRows, type DiffRow } from './inline-diff';

const rowTypes = (rows: DiffRow[]): string[] => rows.map((r) => r.type);

describe('computeDiffRows', () => {
  test('a null oldText renders as pure addition (file creation)', () => {
    const rows = computeDiffRows(null, 'one\ntwo\n');
    expect(rows).toEqual([
      { type: 'add', text: 'one' },
      { type: 'add', text: 'two' },
    ]);
  });

  test('a one-line change in a large file is a one-line diff, not two full files', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const before = lines.join('\n');
    const after = lines.map((l) => (l === 'line 20' ? 'line twenty' : l)).join('\n');
    const rows = computeDiffRows(before, after);
    expect(rows.filter((r) => r.type === 'del')).toEqual([{ type: 'del', text: 'line 20' }]);
    expect(rows.filter((r) => r.type === 'add')).toEqual([{ type: 'add', text: 'line twenty' }]);
    // The untouched top and bottom collapse into gap rows.
    const gaps = rows.filter((r): r is Extract<DiffRow, { type: 'gap' }> => r.type === 'gap');
    expect(gaps.length).toBeGreaterThanOrEqual(2);
    const shownLines = rows.filter((r) => r.type !== 'gap').length;
    expect(shownLines).toBeLessThan(12);
    const hidden = gaps.reduce((n, g) => n + g.count, 0);
    expect(shownLines + hidden).toBeGreaterThanOrEqual(40);
  });

  test('short unchanged runs render inline without a gap', () => {
    const rows = computeDiffRows('a\nb\nc\nd\n', 'a\nb\nc\nX\n');
    expect(rowTypes(rows)).toEqual(['ctx', 'ctx', 'ctx', 'del', 'add']);
  });

  test('identical texts produce only context (or a single gap)', () => {
    const text = 'same\nlines\n';
    const rows = computeDiffRows(text, text);
    expect(rows.every((r) => r.type === 'ctx' || r.type === 'gap')).toBe(true);
  });

  test('keeps a genuinely empty trailing line when there is no final newline', () => {
    const rows = computeDiffRows(null, 'a\n\n');
    expect(rows).toEqual([
      { type: 'add', text: 'a' },
      { type: 'add', text: '' },
    ]);
  });
});
