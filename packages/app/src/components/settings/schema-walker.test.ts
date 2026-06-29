import { describe, expect, test } from 'bun:test';
import { ConfigSchema } from '@inkeep/open-knowledge-core';
import {
  buildPatch,
  getEnumOptions,
  getFieldDefault,
  getLeafTypeTag,
  resolveLeafSchema,
} from './schema-walker';

describe('buildPatch', () => {
  test('single-segment path', () => {
    expect(buildPatch(['theme'], 'dark')).toEqual({ theme: 'dark' });
  });

  test('nested path produces nested object', () => {
    expect(buildPatch(['mcp', 'tools', 'search', 'maxResults'], 100)).toEqual({
      mcp: { tools: { search: { maxResults: 100 } } },
    });
  });

  test('null preserved (RFC 7396 spirit)', () => {
    expect(buildPatch(['appearance', 'theme'], null)).toEqual({
      appearance: { theme: null },
    });
  });

  test('throws on empty path', () => {
    expect(() => buildPatch([], 'x')).toThrow();
  });
});

function requireLeaf(path: readonly string[]) {
  const leaf = resolveLeafSchema(ConfigSchema, path);
  if (!leaf) throw new Error(`expected leaf at ${path.join('.')}`);
  return leaf;
}

describe('resolveLeafSchema against ConfigSchema', () => {
  test('descends through .default() wrappers', () => {
    expect(getLeafTypeTag(requireLeaf(['content', 'dir']))).toBe('string');
  });

  test('descends to an enum leaf and returns options', () => {
    const leaf = requireLeaf(['appearance', 'theme']);
    expect(getLeafTypeTag(leaf)).toBe('enum');
    expect(getEnumOptions(leaf)).toEqual(['light', 'dark', 'system']);
  });

  test('descends to defaulted boolean leaves', () => {
    const leaf = requireLeaf(['editor', 'wordWrap']);
    expect(getLeafTypeTag(leaf)).toBe('boolean');
  });

  test('returns undefined for non-existent path', () => {
    expect(resolveLeafSchema(ConfigSchema, ['does', 'not', 'exist'])).toBeUndefined();
  });
});

describe('getFieldDefault against ConfigSchema', () => {
  test('returns scalar defaults for defaulted leaves', () => {
    expect(getFieldDefault(requireLeaf(['content', 'dir']))).toBe('.');
  });

  test('returns undefined for fields without .default()', () => {
    expect(getFieldDefault(requireLeaf(['appearance', 'theme']))).toBeUndefined();
  });

  test('returns defaults for editor.wordWrap', () => {
    expect(getFieldDefault(requireLeaf(['editor', 'wordWrap']))).toBe(true);
  });
});
