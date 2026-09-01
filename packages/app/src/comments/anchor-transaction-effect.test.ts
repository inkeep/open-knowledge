import { describe, expect, test } from 'vitest';
import { anchorTransactionEffect } from './anchor-decorations';

const idle = { docChanged: false };
const edited = { docChanged: true };

describe('anchorTransactionEffect', () => {
  test('a selection-only transaction reuses the existing decorations', () => {
    expect(anchorTransactionEffect(idle, undefined)).toBe('reuse');
  });

  test('a document edit rebuilds', () => {
    expect(anchorTransactionEffect(edited, undefined)).toBe('rebuild');
  });

  test("the store's redraw ping rebuilds even though the document is unchanged", () => {
    expect(anchorTransactionEffect(idle, { refresh: true })).toBe('rebuild');
  });

  test('setting the composer draft is its own effect', () => {
    expect(anchorTransactionEffect(idle, { draft: { from: 3, to: 9 } })).toBe('draft');
  });

  test('clearing the composer draft still counts as a draft change', () => {
    expect(anchorTransactionEffect(idle, { draft: null })).toBe('draft');
  });

  test('a draft change during an edit is handled as a draft change', () => {
    expect(anchorTransactionEffect(edited, { draft: null })).toBe('draft');
  });

  test('an unrelated meta value does not reuse', () => {
    expect(anchorTransactionEffect(idle, 'something-else')).toBe('rebuild');
  });
});
