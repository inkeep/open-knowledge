import { describe, expect, test } from 'vitest';
import { formatToolList, formatUnitList } from './tool-list-format';

describe('formatToolList', () => {
  test('joins with a locale conjunction so a checkbox label reads as prose', () => {
    expect(formatToolList(['Claude', 'Cursor', 'Codex'], 'en')).toBe('Claude, Cursor, and Codex');
  });

  test('two tools take the conjunction with no serial comma', () => {
    expect(formatToolList(['Claude', 'Cursor'], 'en')).toBe('Claude and Cursor');
  });

  test('a single tool renders bare', () => {
    expect(formatToolList(['Claude'], 'en')).toBe('Claude');
  });

  test('an empty list renders empty rather than throwing', () => {
    expect(formatToolList([], 'en')).toBe('');
  });

  test('an unset locale falls back to the runtime default instead of throwing', () => {
    expect(formatToolList(['Claude', 'Cursor'], '')).toContain('Claude');
  });

  test('the conjunction is localized, not hardcoded English', () => {
    expect(formatToolList(['Claude', 'Cursor'], 'es')).toBe('Claude y Cursor');
  });
});

describe('formatUnitList', () => {
  test('joins attributes without a conjunction, so it reads as a list of states', () => {
    expect(formatUnitList(['Opus 5', 'Fast', 'Max'], 'en')).toBe('Opus 5, Fast, Max');
  });

  test('uses the separator the locale uses, not a fixed comma', () => {
    expect(formatUnitList(['Opus 5', 'Fast', 'Max'], 'ar')).toContain('،');
    expect(formatUnitList(['Opus 5', 'Fast', 'Max'], 'ar')).not.toContain('Opus 5, Fast');
  });

  test('a single part is returned unchanged', () => {
    expect(formatUnitList(['Opus 5'], 'en')).toBe('Opus 5');
  });

  test('an empty locale falls back to the runtime default instead of throwing', () => {
    const parts = ['Opus 5', 'Fast', 'Max'];
    expect(formatUnitList(parts, '')).toBe(
      new Intl.ListFormat(undefined, { style: 'short', type: 'unit' }).format(parts),
    );
  });
});
