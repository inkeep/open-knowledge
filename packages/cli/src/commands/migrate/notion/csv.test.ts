import { describe, expect, test } from 'bun:test';
import { parseCsv } from './csv.ts';

describe('parseCsv', () => {
  test('parses a simple header + rows', () => {
    const { header, rows } = parseCsv('a,b,c\n1,2,3\n4,5,6\n');
    expect(header).toEqual(['a', 'b', 'c']);
    expect(rows).toEqual([
      ['1', '2', '3'],
      ['4', '5', '6'],
    ]);
  });

  test('strips a leading UTF-8 BOM from the first field', () => {
    const { header } = parseCsv('﻿Name,Status\nAlpha,Done\n');
    expect(header).toEqual(['Name', 'Status']);
  });

  test('keeps commas inside quoted fields as one cell', () => {
    const { rows } = parseCsv('a,b\n"x, y, z",2\n');
    expect(rows).toEqual([['x, y, z', '2']]);
  });

  test('unescapes doubled quotes inside quoted fields', () => {
    const { rows } = parseCsv('a\n"she said ""hi"""\n');
    expect(rows).toEqual([['she said "hi"']]);
  });

  test('preserves an embedded newline inside a quoted field as one cell', () => {
    const { header, rows } = parseCsv('a,b\n"line one\nline two",2\n');
    expect(header).toEqual(['a', 'b']);
    expect(rows).toEqual([['line one\nline two', '2']]);
    // Critically, it did NOT split into two rows.
    expect(rows).toHaveLength(1);
  });

  test('handles CRLF line endings', () => {
    const { header, rows } = parseCsv('a,b\r\n1,2\r\n');
    expect(header).toEqual(['a', 'b']);
    expect(rows).toEqual([['1', '2']]);
  });

  test('returns empty rows for a header-only CSV without throwing', () => {
    const { header, rows } = parseCsv('Name,Status,Owner\n');
    expect(header).toEqual(['Name', 'Status', 'Owner']);
    expect(rows).toEqual([]);
  });

  test('handles a final row with no trailing newline', () => {
    const { rows } = parseCsv('a,b\n1,2');
    expect(rows).toEqual([['1', '2']]);
  });

  test('preserves trailing empty fields', () => {
    const { rows } = parseCsv('a,b,c\n1,,\n');
    expect(rows).toEqual([['1', '', '']]);
  });

  test('empty input yields empty header and rows', () => {
    const { header, rows } = parseCsv('');
    expect(header).toEqual([]);
    expect(rows).toEqual([]);
  });
});
