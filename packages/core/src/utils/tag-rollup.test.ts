import { describe, expect, test } from 'vitest';
import { expandTagToHierarchy, tagsMatchingPrefix } from './tag-rollup.ts';

describe('expandTagToHierarchy', () => {
  test('single-segment tag yields a one-element array', () => {
    expect(expandTagToHierarchy('proj')).toEqual(['proj']);
  });

  test('multi-segment tag yields each prefix in order, ending with the full tag', () => {
    expect(expandTagToHierarchy('proj/team/2026')).toEqual(['proj', 'proj/team', 'proj/team/2026']);
  });

  test('two-segment tag yields parent + full', () => {
    expect(expandTagToHierarchy('frontend/regression')).toEqual([
      'frontend',
      'frontend/regression',
    ]);
  });

  test('empty input returns empty array', () => {
    expect(expandTagToHierarchy('')).toEqual([]);
  });

  test('hyphen and underscore stay inside a single segment (not separators)', () => {
    expect(expandTagToHierarchy('foo-bar_baz')).toEqual(['foo-bar_baz']);
    expect(expandTagToHierarchy('a-b/c_d')).toEqual(['a-b', 'a-b/c_d']);
  });
});

describe('tagsMatchingPrefix', () => {
  test('exact match returns just that tag', () => {
    const all = new Set(['proj', 'proj/team', 'other']);
    expect(tagsMatchingPrefix(all, 'proj')).toEqual(new Set(['proj', 'proj/team']));
  });

  test('prefix matches tag plus children with a literal slash boundary', () => {
    const all = new Set(['proj', 'proj/team', 'proj/team/2026', 'proj-x', 'unrelated']);
    expect(tagsMatchingPrefix(all, 'proj')).toEqual(
      new Set(['proj', 'proj/team', 'proj/team/2026']),
    );
  });

  test('hyphen-extended tag (proj-x) does NOT match prefix proj — separator must be /', () => {
    const all = new Set(['proj', 'proj-x', 'proj-x/y']);
    expect(tagsMatchingPrefix(all, 'proj')).toEqual(new Set(['proj']));
  });

  test('no match returns empty set', () => {
    const all = new Set(['proj', 'proj/team']);
    expect(tagsMatchingPrefix(all, 'unrelated')).toEqual(new Set());
  });

  test('empty allTags returns empty set', () => {
    expect(tagsMatchingPrefix(new Set(), 'proj')).toEqual(new Set());
  });

  test('exact-match-only — leaf tag with no children', () => {
    const all = new Set(['leaf', 'leaf/child', 'unrelated']);
    expect(tagsMatchingPrefix(all, 'leaf/child')).toEqual(new Set(['leaf/child']));
  });

  test('prefix-with-children but no exact match — branch acts as virtual root', () => {
    const all = new Set(['proj/team', 'proj/team/2026']);
    expect(tagsMatchingPrefix(all, 'proj')).toEqual(new Set(['proj/team', 'proj/team/2026']));
  });

  test('empty prefix returns every tag (root rollup)', () => {
    const all = new Set(['a', 'b/c', 'd']);
    expect(tagsMatchingPrefix(all, '')).toEqual(new Set(['a', 'b/c', 'd']));
  });
});
