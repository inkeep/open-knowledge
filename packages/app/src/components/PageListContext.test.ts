import { describe, expect, test } from 'vitest';
import { mergePageSets, pruneConfirmedOptimisticPages } from './PageListContext';

describe('PageListContext helpers', () => {
  test('mergePageSets keeps optimistic created pages visible until server confirms them', () => {
    const merged = mergePageSets(new Set(['STORIES']), new Set(['Y']));
    expect([...merged].sort()).toEqual(['STORIES', 'Y']);
  });

  test('pruneConfirmedOptimisticPages removes pages once the server index includes them', () => {
    const pending = pruneConfirmedOptimisticPages(new Set(['Y', 'tim']), new Set(['Y', 'STORIES']));
    expect([...pending]).toEqual(['tim']);
  });
});
