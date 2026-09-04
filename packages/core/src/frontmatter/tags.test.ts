import { describe, expect, test } from 'vitest';
import {
  extractFrontmatterTags,
  FRONTMATTER_TAG_GRAMMAR_HINT,
  FRONTMATTER_TAG_VALUE_RE,
  isValidFrontmatterTagValue,
} from './tags.ts';

describe('FRONTMATTER_TAG_VALUE_RE', () => {
  test('accepts letter- and digit-leading shapes', () => {
    expect(FRONTMATTER_TAG_VALUE_RE.test('typescript')).toBe(true);
    expect(FRONTMATTER_TAG_VALUE_RE.test('proj/team/2026')).toBe(true);
    expect(FRONTMATTER_TAG_VALUE_RE.test('a-b_c')).toBe(true);
    expect(FRONTMATTER_TAG_VALUE_RE.test('a1')).toBe(true);
    expect(FRONTMATTER_TAG_VALUE_RE.test('2026')).toBe(true);
    expect(FRONTMATTER_TAG_VALUE_RE.test('123')).toBe(true);
  });

  test('rejects empty, whitespace, and punctuation-leading shapes', () => {
    expect(FRONTMATTER_TAG_VALUE_RE.test('')).toBe(false);
    expect(FRONTMATTER_TAG_VALUE_RE.test('foo bar')).toBe(false);
    expect(FRONTMATTER_TAG_VALUE_RE.test('-leading-dash')).toBe(false);
    expect(FRONTMATTER_TAG_VALUE_RE.test('/leading-slash')).toBe(false);
  });
});

describe('extractFrontmatterTags', () => {
  test('returns empty for empty input', () => {
    expect(extractFrontmatterTags('')).toEqual([]);
    expect(extractFrontmatterTags('   \n')).toEqual([]);
  });

  test('returns empty when tags key is absent', () => {
    expect(extractFrontmatterTags('title: Hello\ncluster: x\n')).toEqual([]);
  });

  test('extracts a flat list', () => {
    expect(extractFrontmatterTags('tags: [showcase, demo]\n')).toEqual(['showcase', 'demo']);
  });

  test('accepts a single scalar string and treats it as a one-element list', () => {
    expect(extractFrontmatterTags('tags: showcase\n')).toEqual(['showcase']);
  });

  test('strips a leading # tolerated on Obsidian-emit imports', () => {
    expect(extractFrontmatterTags('tags: ["#showcase", "#demo"]\n')).toEqual(['showcase', 'demo']);
  });

  test('preserves hierarchy slashes', () => {
    expect(extractFrontmatterTags('tags: [proj/team, proj/team/2026]\n')).toEqual([
      'proj/team',
      'proj/team/2026',
    ]);
  });

  test('drops invalid entries rather than failing the whole list', () => {
    const out = extractFrontmatterTags('tags: [valid, "with space", "123digit", another]\n');
    expect(out).toEqual(['valid', '123digit', 'another']);
  });

  test('coerces non-string scalars and applies the per-entry tag regex', () => {
    expect(extractFrontmatterTags('tags: [valid, 42, true, also]\n')).toEqual([
      'valid',
      '42',
      'true',
      'also',
    ]);
  });

  test('returns empty when frontmatter parse fails', () => {
    expect(extractFrontmatterTags(': : : invalid yaml')).toEqual([]);
  });

  test('returns empty when tags is null', () => {
    expect(extractFrontmatterTags('tags: null\n')).toEqual([]);
  });

  test("returns empty for Obsidian's empty-list shape (`tags:\\n- `)", () => {
    expect(extractFrontmatterTags('tags:\n- \n')).toEqual([]);
  });

  test('drops a null entry but keeps real tags in a mixed block sequence', () => {
    expect(extractFrontmatterTags('tags:\n  - real\n  - \n  - also\n')).toEqual(['real', 'also']);
  });

  test('drops object array elements rather than stringifying them', () => {
    const yaml = 'tags:\n  - valid\n  - {nested: "object"}\n  - alsoValid\n';
    expect(extractFrontmatterTags(yaml)).toEqual(['valid', 'alsoValid']);
  });

  test('drops nested-array elements rather than stringifying them', () => {
    const yaml = 'tags:\n  - valid\n  - [inner, list]\n  - alsoValid\n';
    expect(extractFrontmatterTags(yaml)).toEqual(['valid', 'alsoValid']);
  });
});

describe('isValidFrontmatterTagValue', () => {
  test('accepts every canonical valid shape', () => {
    for (const value of [
      'showcase',
      'demo',
      'q1-recap',
      'proj/team',
      'proj/team/2026',
      'snake_case',
      'kebab-case',
      'Mixed_Case',
      'a',
    ]) {
      expect(isValidFrontmatterTagValue(value)).toBe(true);
    }
  });

  test('accepts leading-digit values (year-only tags like 2026)', () => {
    expect(isValidFrontmatterTagValue('2026')).toBe(true);
    expect(isValidFrontmatterTagValue('42')).toBe(true);
    expect(isValidFrontmatterTagValue('1q-recap')).toBe(true);
  });

  test('rejects whitespace-containing values', () => {
    expect(isValidFrontmatterTagValue('hello world')).toBe(false);
    expect(isValidFrontmatterTagValue(' leading-space')).toBe(false);
    expect(isValidFrontmatterTagValue('trailing-space ')).toBe(false);
    expect(isValidFrontmatterTagValue('tab\there')).toBe(false);
  });

  test('rejects special-char values outside the grammar', () => {
    expect(isValidFrontmatterTagValue('hello!')).toBe(false);
    expect(isValidFrontmatterTagValue('foo@bar')).toBe(false);
    expect(isValidFrontmatterTagValue('a.b')).toBe(false);
    expect(isValidFrontmatterTagValue('a:b')).toBe(false);
    expect(isValidFrontmatterTagValue('a+b')).toBe(false);
  });

  test('rejects empty + non-string values', () => {
    expect(isValidFrontmatterTagValue('')).toBe(false);
    // @ts-expect-error — runtime guard against non-string callers
    expect(isValidFrontmatterTagValue(undefined)).toBe(false);
    // @ts-expect-error - runtime guard against non-string callers
    expect(isValidFrontmatterTagValue(null)).toBe(false);
    // @ts-expect-error - runtime guard against non-string callers
    expect(isValidFrontmatterTagValue(42)).toBe(false);
  });

  test('strips a single leading `#` (Obsidian-shape input) before validating', () => {
    expect(isValidFrontmatterTagValue('#showcase')).toBe(true);
    expect(isValidFrontmatterTagValue('#proj/team')).toBe(true);
    expect(isValidFrontmatterTagValue('##showcase')).toBe(false);
  });

  test('agrees with the FRONTMATTER_TAG_VALUE_RE constant (single source of truth)', () => {
    for (const value of ['showcase', '2026', 'hello world', '']) {
      const stripped = value.startsWith('#') ? value.slice(1) : value;
      expect(isValidFrontmatterTagValue(value)).toBe(FRONTMATTER_TAG_VALUE_RE.test(stripped));
    }
  });
});

describe('FRONTMATTER_TAG_GRAMMAR_HINT', () => {
  test('is a user-facing string describing the grammar', () => {
    expect(FRONTMATTER_TAG_GRAMMAR_HINT.length).toBeGreaterThan(0);
    expect(FRONTMATTER_TAG_GRAMMAR_HINT).toContain('letter');
    expect(FRONTMATTER_TAG_GRAMMAR_HINT).toContain('digit');
  });
});
