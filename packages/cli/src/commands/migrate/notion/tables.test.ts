import { describe, expect, test } from 'bun:test';
import { buildStubPage, extractStubTitle, renderCsvTable } from './tables.ts';

describe('renderCsvTable', () => {
  test('renders a header, separator, and rows', () => {
    const { table, columns, wide } = renderCsvTable('Name,Status\nAlpha,Done\nBeta,Todo\n');
    expect(columns).toBe(2);
    expect(wide).toBe(false);
    expect(table).toBe(
      ['| Name | Status |', '| --- | --- |', '| Alpha | Done |', '| Beta | Todo |'].join('\n'),
    );
  });

  test('flattens embedded newlines to <br> and escapes pipes', () => {
    const { table } = renderCsvTable('Name,Note\n"Alpha","line one\nline two"\n"Beta","a | b"\n');
    expect(table).toContain('| Alpha | line one<br>line two |');
    expect(table).toContain('| Beta | a \\| b |');
  });

  test('flags a wide table past the threshold but still renders it', () => {
    const header = Array.from({ length: 40 }, (_, i) => `c${i}`).join(',');
    const { columns, wide, table } = renderCsvTable(`${header}\n`);
    expect(columns).toBe(40);
    expect(wide).toBe(true);
    expect(table.startsWith('| c0 |')).toBe(true);
  });

  test('links the title column when the resolver returns a path', () => {
    const { table } = renderCsvTable('Title,Status\nMy Row,Done\n', {
      linkForTitle: (t) => (t === 'My Row' ? 'DB/My Row abc.md' : null),
    });
    // Target has spaces -> angle-bracket wrapped.
    expect(table).toContain('| [My Row](<DB/My Row abc.md>) | Done |');
  });

  test('falls back to plain text when the resolver returns null', () => {
    const { table } = renderCsvTable('Title,Status\nGhost,Done\n', { linkForTitle: () => null });
    expect(table).toContain('| Ghost | Done |');
  });

  test('honors a non-zero title column', () => {
    const { table } = renderCsvTable('Status,Title\nDone,My Row\n', {
      titleColumn: 1,
      linkForTitle: () => 'row.md',
    });
    expect(table).toContain('| Done | [My Row](row.md) |');
  });

  test('renders a header-only CSV as a table with no body rows', () => {
    const { table } = renderCsvTable('A,B,C\n');
    expect(table).toBe(['| A | B | C |', '| --- | --- | --- |'].join('\n'));
  });
});

describe('buildStubPage + extractStubTitle', () => {
  test('regeneration is idempotent for a fixed (title, csv)', () => {
    const csv = 'Name,Status\nAlpha,Done\n';
    const title = extractStubTitle(
      '# Content Plan\n\n[Content Plan](Content%20Plan_all.csv)\n',
      'fallback',
    );
    expect(title).toBe('Content Plan');
    const once = buildStubPage(title, renderCsvTable(csv).table);
    const twice = buildStubPage(extractStubTitle(once, 'fallback'), renderCsvTable(csv).table);
    expect(twice).toBe(once);
  });
});
