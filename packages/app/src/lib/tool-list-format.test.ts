import { describe, expect, test } from 'vitest';
import { formatToolList } from './tool-list-format';

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
