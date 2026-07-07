import { describe, expect, test } from 'bun:test';
import {
  FRONTMATTER_TYPES,
  FrontmatterMapSchema,
  frontmatterValuesEqual,
  inferType,
  isFrontmatterValueEmpty,
} from './schema.ts';

describe('isFrontmatterValueEmpty', () => {
  test('treats null, empty string, and empty array as empty', () => {
    expect(isFrontmatterValueEmpty(null)).toBe(true);
    expect(isFrontmatterValueEmpty('')).toBe(true);
    expect(isFrontmatterValueEmpty([])).toBe(true);
  });

  test('treats `0` and `false` as non-empty (valid stored values)', () => {
    // Load-bearing carve-out: a loose `!value` check would reject numeric
    // 0 and boolean false, corrupting properties whose intended stored
    // value is one of those literals. Keep these explicit.
    expect(isFrontmatterValueEmpty(0)).toBe(false);
    expect(isFrontmatterValueEmpty(false)).toBe(false);
  });

  test('treats non-empty strings and arrays as non-empty', () => {
    expect(isFrontmatterValueEmpty('x')).toBe(false);
    expect(isFrontmatterValueEmpty(' ')).toBe(false); // whitespace counts as content
    expect(isFrontmatterValueEmpty(['a'])).toBe(false);
  });

  test('treats other primitives as non-empty', () => {
    expect(isFrontmatterValueEmpty(42)).toBe(false);
    expect(isFrontmatterValueEmpty(true)).toBe(false);
  });
});

describe('FRONTMATTER_TYPES', () => {
  test('includes object for nested mapping support', () => {
    expect(FRONTMATTER_TYPES).toContain('object');
  });
});

describe('inferType', () => {
  test('returns object for a plain mapping', () => {
    expect(inferType({})).toBe('object');
    expect(inferType({ version: '1.0' })).toBe('object');
    expect(inferType({ a: { b: 'c' } })).toBe('object');
  });

  test('returns list for arrays regardless of element shape', () => {
    expect(inferType([])).toBe('list');
    expect(inferType(['a', 'b'])).toBe('list');
    expect(inferType([{ k: 'v' }])).toBe('list');
    expect(inferType([{ a: 1 }, { b: 2 }])).toBe('list');
  });

  test('preserves scalar inference (boolean, number, date, text)', () => {
    expect(inferType(true)).toBe('boolean');
    expect(inferType(42)).toBe('number');
    expect(inferType('2026-06-09')).toBe('date');
    expect(inferType('hello')).toBe('text');
  });
});

describe('frontmatterValuesEqual', () => {
  test('scalars compare by value', () => {
    expect(frontmatterValuesEqual('a', 'a')).toBe(true);
    expect(frontmatterValuesEqual(1, 1)).toBe(true);
    expect(frontmatterValuesEqual(true, true)).toBe(true);
    expect(frontmatterValuesEqual('a', 'b')).toBe(false);
    expect(frontmatterValuesEqual(1, 2)).toBe(false);
  });

  test('structurally-equal nested objects are equal across references', () => {
    // The regression this guards: two objects parsed from the same
    // YAML on consecutive observer events are distinct references. Reference
    // equality would (wrongly) report them unequal and re-fire listeners on
    // every body keystroke.
    expect(
      frontmatterValuesEqual(
        { version: '1.0.0', author: 'Inkeep' },
        { version: '1.0.0', author: 'Inkeep' },
      ),
    ).toBe(true);
    // Key order does not matter.
    expect(frontmatterValuesEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  test('differing nested leaf is unequal', () => {
    expect(frontmatterValuesEqual({ version: '1.0.0' }, { version: '2.0.0' })).toBe(false);
  });

  test('extra key in either side is unequal', () => {
    expect(frontmatterValuesEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(frontmatterValuesEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });

  test('arrays recurse into element structure (not reference)', () => {
    expect(frontmatterValuesEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(frontmatterValuesEqual([{ k: 1 }], [{ k: 1 }])).toBe(true);
    expect(frontmatterValuesEqual([{ k: 1 }], [{ k: 2 }])).toBe(false);
    expect(frontmatterValuesEqual(['a'], ['a', 'b'])).toBe(false);
  });

  test('deeply nested structures compare structurally', () => {
    expect(
      frontmatterValuesEqual(
        { meta: { tags: ['x'], nested: { n: 1 } } },
        { meta: { tags: ['x'], nested: { n: 1 } } },
      ),
    ).toBe(true);
    expect(
      frontmatterValuesEqual({ meta: { nested: { n: 1 } } }, { meta: { nested: { n: 2 } } }),
    ).toBe(false);
  });

  test('cross-type mismatches are unequal', () => {
    expect(frontmatterValuesEqual({}, [])).toBe(false);
    expect(frontmatterValuesEqual('1', 1)).toBe(false);
    expect(frontmatterValuesEqual({ a: 1 }, 'a')).toBe(false);
  });

  test('null is handled by the guard path (only equal to itself)', () => {
    // The binding passes raw map values, which can be `undefined`/`null` for an
    // absent key; the `a !== null && b !== null` guard must keep null from
    // entering the object branch.
    expect(frontmatterValuesEqual(null, null)).toBe(true);
    expect(frontmatterValuesEqual(null, {})).toBe(false);
    expect(frontmatterValuesEqual({}, null)).toBe(false);
    expect(frontmatterValuesEqual(null, 'a')).toBe(false);
  });

  test('same key count but different key set is unequal (Object.hasOwn guard)', () => {
    expect(frontmatterValuesEqual({ a: 1, b: 2 }, { a: 1, c: 2 })).toBe(false);
  });
});

describe('FrontmatterMapSchema — Obsidian null coercion', () => {
  // yaml@2 parses Obsidian's empty-list / bare-key shapes to `null`; the read
  // schema deliberately excludes `null` (it's the RFC 7396 delete sentinel),
  // so it coerces those to empty values at the map boundary rather than
  // rejecting the whole map. See `coerceNullFrontmatter` in schema.ts.

  test('drops null sequence elements ([null] → [])', () => {
    const result = FrontmatterMapSchema.safeParse({ tags: [null] });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ tags: [] });
  });

  test('drops null elements but keeps real items in a mixed sequence', () => {
    const result = FrontmatterMapSchema.safeParse({ aliases: ['Real', null, 'Also'] });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ aliases: ['Real', 'Also'] });
  });

  test('coerces a bare-key null scalar to an empty string (key stays visible)', () => {
    const result = FrontmatterMapSchema.safeParse({ tags: null, author: 'Alice' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ tags: '', author: 'Alice' });
  });

  test('coerces null nested inside a mapping subtree', () => {
    const result = FrontmatterMapSchema.safeParse({ metadata: { version: null, name: 'x' } });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ metadata: { version: '', name: 'x' } });
  });

  test('leaves null-free maps untouched (no behavior change for valid input)', () => {
    const input = { title: 'Hello', tags: ['a', 'b'], meta: { n: 1 } };
    const result = FrontmatterMapSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success)
      expect(result.data).toEqual({ title: 'Hello', tags: ['a', 'b'], meta: { n: 1 } });
  });
});
