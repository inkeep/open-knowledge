import { describe, expect, test } from 'vitest';
import {
  groupClaudeModelFamilies,
  hasContextChoice,
  nominalTokensForTag,
  parseClaudeModelVariant,
} from './claude-variant.ts';

describe('reading the window out of a Claude model id', () => {
  test('a tagged id splits into its base and its tag', () => {
    expect(parseClaudeModelVariant('claude-opus-4-8[1m]')).toEqual({
      raw: 'claude-opus-4-8[1m]',
      baseId: 'claude-opus-4-8',
      contextTag: '1m',
      nominalTokens: 1_000_000,
    });
  });

  test('an untagged id is its own base and claims no window', () => {
    expect(parseClaudeModelVariant('claude-opus-4-8')).toEqual({
      raw: 'claude-opus-4-8',
      baseId: 'claude-opus-4-8',
      contextTag: null,
      nominalTokens: null,
    });
  });

  test('the tag is decoded as notation, not looked up in a table', () => {
    expect(nominalTokensForTag('1m')).toBe(1_000_000);
    expect(nominalTokensForTag('200k')).toBe(200_000);
    expect(nominalTokensForTag('1.5m')).toBe(1_500_000);
    expect(nominalTokensForTag('1M')).toBe(1_000_000);
  });

  test('a tag that is not a size yields no number rather than a guess', () => {
    for (const tag of ['beta', '', 'm', '1g', '1 m', 'v2']) {
      expect(nominalTokensForTag(tag)).toBeNull();
    }
  });

  test('a non-size tag still separates the base id', () => {
    expect(parseClaudeModelVariant('some-model[beta]')).toMatchObject({
      baseId: 'some-model',
      contextTag: 'beta',
      nominalTokens: null,
    });
  });
});

describe('grouping variants into the model they belong to', () => {
  const advertised = ['claude-opus-4-8', 'claude-opus-4-8[1m]', 'claude-sonnet-5'];

  test('variants of one model collapse into a single family', () => {
    const families = groupClaudeModelFamilies(advertised);
    expect(families).toHaveLength(2);
    const opus = families.find((f) => f.baseId === 'claude-opus-4-8');
    expect(opus?.variants.map((v) => v.raw)).toEqual(['claude-opus-4-8', 'claude-opus-4-8[1m]']);
  });

  test('a family with more than one variant offers a window choice', () => {
    const families = groupClaudeModelFamilies(advertised);
    expect(hasContextChoice(families.find((f) => f.baseId === 'claude-opus-4-8') as never)).toBe(
      true,
    );
    expect(hasContextChoice(families.find((f) => f.baseId === 'claude-sonnet-5') as never)).toBe(
      false,
    );
  });

  test('advertised order is preserved inside a family', () => {
    const families = groupClaudeModelFamilies(['m[1m]', 'm']);
    expect(families[0]?.variants.map((v) => v.contextTag)).toEqual(['1m', null]);
  });

  test('nothing advertised yields no families', () => {
    expect(groupClaudeModelFamilies([])).toEqual([]);
  });
});
