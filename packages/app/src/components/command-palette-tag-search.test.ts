
import { describe, expect, test } from 'bun:test';
import type { TagSummaryEntry } from '../editor/extensions/tag-suggestion.ts';
import { filterTagList, parseTagPaletteQuery } from './command-palette-tag-search.ts';

const tags = (entries: Array<[string, number]>): TagSummaryEntry[] =>
  entries.map(([name, count]) => ({ name, count, isLeaf: true }));

const known = (...names: string[]) => new Set(names);

describe('parseTagPaletteQuery — mode discrimination', () => {
  test('non-tag query → normal mode (passes through)', () => {
    expect(parseTagPaletteQuery('hello world', known())).toEqual({
      kind: 'normal',
      query: 'hello world',
    });
  });

  test('empty query → normal mode', () => {
    expect(parseTagPaletteQuery('', known())).toEqual({ kind: 'normal', query: '' });
  });

  test('`tag:` alone → tag-list mode with empty query', () => {
    expect(parseTagPaletteQuery('tag:', known('frontend'))).toEqual({
      kind: 'tag-list',
      query: '',
    });
  });

  test('`tag:fr` (partial, no exact match) → tag-list mode', () => {
    expect(parseTagPaletteQuery('tag:fr', known('frontend', 'backend'))).toEqual({
      kind: 'tag-list',
      query: 'fr',
    });
  });

  test('`tag:frontend` (exact known match) → tag-docs mode', () => {
    expect(parseTagPaletteQuery('tag:frontend', known('frontend'))).toEqual({
      kind: 'tag-docs',
      tagName: 'frontend',
    });
  });

  test('`tag: frontend` (whitespace after colon) → tag-docs mode', () => {
    expect(parseTagPaletteQuery('tag: frontend', known('frontend'))).toEqual({
      kind: 'tag-docs',
      tagName: 'frontend',
    });
  });

  test('`tag:frontend ` (trailing whitespace) → tag-docs mode', () => {
    expect(parseTagPaletteQuery('tag:frontend ', known('frontend'))).toEqual({
      kind: 'tag-docs',
      tagName: 'frontend',
    });
  });

  test('case-insensitive prefix match (`Tag:fr` works)', () => {
    expect(parseTagPaletteQuery('Tag:fr', known('frontend'))).toEqual({
      kind: 'tag-list',
      query: 'fr',
    });
    expect(parseTagPaletteQuery('TAG:fr', known('frontend'))).toEqual({
      kind: 'tag-list',
      query: 'fr',
    });
  });

  test('case-sensitive tag-name match (mixed case stays in tag-list)', () => {
    expect(parseTagPaletteQuery('tag:frontend', known('Frontend'))).toEqual({
      kind: 'tag-list',
      query: 'frontend',
    });
  });

  test('hierarchical tag name (slash) routes through correctly', () => {
    expect(parseTagPaletteQuery('tag:proj/team', known('proj/team', 'proj'))).toEqual({
      kind: 'tag-docs',
      tagName: 'proj/team',
    });
  });

  test('empty known-set during loading stays in tag-list mode (no flicker)', () => {
    expect(parseTagPaletteQuery('tag:frontend', known())).toEqual({
      kind: 'tag-list',
      query: 'frontend',
    });
  });
});

describe('filterTagList — rank order', () => {
  test('empty query → all tags by count desc, name asc', () => {
    const out = filterTagList(
      tags([
        ['frontend', 5],
        ['backend', 12],
        ['design', 5],
      ]),
      '',
    );
    expect(out.map((t) => t.name)).toEqual(['backend', 'design', 'frontend']);
  });

  test('non-empty query filters case-insensitively', () => {
    const out = filterTagList(
      tags([
        ['frontend', 5],
        ['backend', 12],
        ['Frontend-mobile', 3],
      ]),
      'front',
    );
    expect(out.map((t) => t.name)).toEqual(['frontend', 'Frontend-mobile']);
  });

  test('prefix-matches outrank substring matches', () => {
    const out = filterTagList(
      tags([
        ['myweb', 100],
        ['webapp', 1],
      ]),
      'web',
    );
    expect(out.map((t) => t.name)).toEqual(['webapp', 'myweb']);
  });

  test('returns the full list (host CommandList scrolls — no cap)', () => {
    const many = tags(
      Array.from({ length: 30 }, (_, i) => [`tag${i}`, 100 - i] as [string, number]),
    );
    expect(filterTagList(many, '').length).toBe(30);
  });
});
