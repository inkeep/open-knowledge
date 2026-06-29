import { describe, expect, test } from 'bun:test';
import { buildTagSuggestionItems, type TagSummaryEntry, tagMatcher } from './tag-suggestion.ts';

const tags = (entries: Array<[string, number]>): TagSummaryEntry[] =>
  entries.map(([name, count]) => ({ name, count, isLeaf: true }));

describe('buildTagSuggestionItems — filter + rank', () => {
  test('empty query returns all tags sorted by count desc, then name asc', () => {
    const out = buildTagSuggestionItems(
      tags([
        ['frontend', 5],
        ['backend', 12],
        ['design', 5],
      ]),
      '',
    );
    expect(out.map((i) => (i.kind === 'tag' ? i.value : `+${i.value}`))).toEqual([
      'backend', // count 12
      'design', // count 5, name < 'frontend'
      'frontend', // count 5
    ]);
  });

  test('non-empty query keeps matches only (case-insensitive substring)', () => {
    const out = buildTagSuggestionItems(
      tags([
        ['frontend', 5],
        ['backend', 12],
        ['Frontend-mobile', 3],
      ]),
      'front',
    );
    const tagsOnly = out.filter((i) => i.kind === 'tag').map((i) => i.kind === 'tag' && i.value);
    expect(tagsOnly).toEqual(['frontend', 'Frontend-mobile']);
    expect(tagsOnly).not.toContain('backend');
  });

  test('prefix-matches outrank substring matches', () => {
    const out = buildTagSuggestionItems(
      tags([
        ['myweb', 100],
        ['webapp', 1],
      ]),
      'web',
    );
    const tagsOnly = out.filter((i) => i.kind === 'tag').map((i) => i.kind === 'tag' && i.value);
    expect(tagsOnly).toEqual(['webapp', 'myweb']);
  });

  test('caps result list at MAX_ITEMS (8)', () => {
    const many = tags(
      Array.from({ length: 15 }, (_, i) => [`tag${i}`, 100 - i] as [string, number]),
    );
    const out = buildTagSuggestionItems(many, '');
    expect(out.length).toBe(8);
  });

  test('valid query with no exact match appends a Create row', () => {
    const out = buildTagSuggestionItems(tags([['frontend', 5]]), 'front');
    expect(out[0]).toEqual({ kind: 'tag', value: 'frontend', count: 5, isLeaf: true });
    expect(out[out.length - 1]).toEqual({ kind: 'create', value: 'front' });
  });

  test('exact case-sensitive match suppresses Create row', () => {
    const out = buildTagSuggestionItems(tags([['frontend', 5]]), 'frontend');
    expect(out.find((i) => i.kind === 'create')).toBeUndefined();
    expect(out[0]).toEqual({ kind: 'tag', value: 'frontend', count: 5, isLeaf: true });
  });

  test('different-case match still offers Create (tags are case-sensitive)', () => {
    const out = buildTagSuggestionItems(tags([['frontend', 5]]), 'Frontend');
    expect(out[out.length - 1]).toEqual({ kind: 'create', value: 'Frontend' });
  });

  test('invalid tag name (starts with digit) suppresses Create row', () => {
    const out = buildTagSuggestionItems(tags([]), '9invalid');
    expect(out).toEqual([]);
  });

  test('invalid tag name (leading hyphen) suppresses Create row', () => {
    const out = buildTagSuggestionItems(tags([]), '-bad');
    expect(out).toEqual([]);
  });

  test('hierarchical tag names work end-to-end', () => {
    const out = buildTagSuggestionItems(
      tags([
        ['proj', 10],
        ['proj/team', 4],
        ['proj/team/2026', 2],
      ]),
      'proj',
    );
    expect(out.filter((i) => i.kind === 'tag').map((i) => i.kind === 'tag' && i.value)).toEqual([
      'proj',
      'proj/team',
      'proj/team/2026',
    ]);
    expect(out.find((i) => i.kind === 'create')).toBeUndefined();
  });

  test('whitespace-only query is treated as empty', () => {
    const out = buildTagSuggestionItems(tags([['a', 1]]), '   ');
    expect(out.find((i) => i.kind === 'create')).toBeUndefined();
    expect(out[0]).toEqual({ kind: 'tag', value: 'a', count: 1, isLeaf: true });
  });

  test('count tiebreak prefers higher usage', () => {
    const out = buildTagSuggestionItems(
      tags([
        ['design-systems', 1],
        ['design', 100],
      ]),
      'design',
    );
    expect(out.map((i) => i.kind === 'tag' && i.value)).toEqual(['design', 'design-systems']);
  });

  test('alphabetical tiebreak when counts are equal', () => {
    const out = buildTagSuggestionItems(
      tags([
        ['zebra', 5],
        ['apple', 5],
        ['mango', 5],
      ]),
      '',
    );
    expect(out.map((i) => i.kind === 'tag' && i.value)).toEqual(['apple', 'mango', 'zebra']);
  });
});

describe('tagMatcher — boundary semantics', () => {
  /** Stub satisfying the subset of ResolvedPos used by tagMatcher.
   *  Mirrors the wiki-link-suggestion test pattern. */
  function stubPosition(textBefore: string, blockStart: number) {
    const cursorPos = blockStart + textBefore.length;
    return {
      $position: {
        parent: {
          textBetween: () => textBefore,
        },
        parentOffset: textBefore.length,
        start: () => blockStart,
        pos: cursorPos,
      },
    };
  }

  test('bare `#` at start of block triggers with empty query', () => {
    const result = tagMatcher(stubPosition('#', 1) as never);
    expect(result).toEqual({
      range: { from: 1, to: 2 },
      query: '',
      text: '#',
    });
  });

  test('`#tag` at start of block triggers with the tag name as query', () => {
    const result = tagMatcher(stubPosition('#frontend', 1) as never);
    expect(result).toEqual({
      range: { from: 1, to: 10 },
      query: 'frontend',
      text: '#frontend',
    });
  });

  test('`#` after whitespace triggers (mid-paragraph)', () => {
    const result = tagMatcher(stubPosition('hello #fr', 1) as never);
    expect(result).toEqual({
      range: { from: 7, to: 10 },
      query: 'fr',
      text: '#fr',
    });
  });

  test('hierarchical `#proj/team` triggers with slashes preserved in query', () => {
    const result = tagMatcher(stubPosition('#proj/team', 1) as never);
    expect(result).toEqual({
      range: { from: 1, to: 11 },
      query: 'proj/team',
      text: '#proj/team',
    });
  });

  test('`# ` (heading shortcut) does NOT trigger — space disqualifies the body', () => {
    expect(tagMatcher(stubPosition('# ', 1) as never)).toBeNull();
  });

  test('`# Heading` (heading with text) does NOT trigger', () => {
    expect(tagMatcher(stubPosition('# Heading', 1) as never)).toBeNull();
  });

  test('`abc#tag` (mid-word) does NOT trigger — `#` requires whitespace/start prefix', () => {
    expect(tagMatcher(stubPosition('abc#tag', 1) as never)).toBeNull();
  });

  test('text without `#` returns null', () => {
    expect(tagMatcher(stubPosition('plain text here', 1) as never)).toBeNull();
  });

  test('`#9foo` (digit-leading) does NOT trigger — body must start with a letter', () => {
    expect(tagMatcher(stubPosition('#9foo', 1) as never)).toBeNull();
  });

  test('`#-bad` (hyphen-leading) does NOT trigger', () => {
    expect(tagMatcher(stubPosition('#-bad', 1) as never)).toBeNull();
  });

  test('matches `#tag` after an inline-atom placeholder (textBetween emits ￼)', () => {
    const result = tagMatcher(stubPosition('￼#wip', 1) as never);
    expect(result).toEqual({
      range: { from: 2, to: 6 },
      query: 'wip',
      text: '#wip',
    });
  });
});
