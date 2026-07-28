/**
 * Unit contract for the markdownlint rule value model behind the rule browser:
 * the on/off toggle and the option-edit composition that preserve keys they
 * don't edit, plus the row-state derivation (governing value, modified marker,
 * severity chip, search match). The DOM test covers rendering; this pins the
 * value computation.
 */

import { MARKDOWNLINT_RULE_CATALOG } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import {
  governingRuleValue,
  isRuleModified,
  optionKeys,
  ruleEnabled,
  ruleMatchesSearch,
  ruleSeverity,
  ruleValueWithOption,
  toggledRuleValue,
} from './markdownlint-rule-browser';

describe('ruleEnabled', () => {
  test('bare booleans map to themselves', () => {
    expect(ruleEnabled(true)).toBe(true);
    expect(ruleEnabled(false)).toBe(false);
  });

  test('an object with no enabled flag reads as enabled', () => {
    expect(ruleEnabled({ line_length: 100 })).toBe(true);
  });

  test('enabled:false disables regardless of other options', () => {
    expect(ruleEnabled({ line_length: 100, enabled: false })).toBe(false);
    expect(ruleEnabled({ enabled: true })).toBe(true);
  });

  test('severity strings read as enabled', () => {
    expect(ruleEnabled('error')).toBe(true);
    expect(ruleEnabled('warning')).toBe(true);
  });
});

describe('optionKeys', () => {
  test('excludes the enabled flag, keeps real options', () => {
    expect(optionKeys({ line_length: 100, enabled: false })).toEqual(['line_length']);
  });

  test('a bare boolean has no options', () => {
    expect(optionKeys(true)).toEqual([]);
    expect(optionKeys(false)).toEqual([]);
  });

  test('an enabled-only object has no options', () => {
    expect(optionKeys({ enabled: false })).toEqual([]);
  });

  test('a severity string has no options', () => {
    expect(optionKeys('error')).toEqual([]);
  });
});

describe('toggledRuleValue', () => {
  test('bare booleans stay bare', () => {
    expect(toggledRuleValue(true, false)).toBe(false);
    expect(toggledRuleValue(false, true)).toBe(true);
  });

  test('disabling an option-carrying rule preserves options and adds enabled:false', () => {
    expect(toggledRuleValue({ line_length: 100 }, false)).toEqual({
      line_length: 100,
      enabled: false,
    });
  });

  test('re-enabling drops the enabled flag but keeps options (minimal file)', () => {
    expect(toggledRuleValue({ line_length: 100, enabled: false }, true)).toEqual({
      line_length: 100,
    });
  });

  test('an enabled-only object collapses to a bare boolean', () => {
    expect(toggledRuleValue({ enabled: true }, false)).toBe(false);
    expect(toggledRuleValue({ enabled: false }, true)).toBe(true);
  });

  test('MD043-style headings are preserved across a toggle round-trip', () => {
    const disabled = toggledRuleValue({ headings: ['# A', '## B'] }, false);
    expect(disabled).toEqual({ headings: ['# A', '## B'], enabled: false });
    expect(toggledRuleValue(disabled, true)).toEqual({ headings: ['# A', '## B'] });
  });

  test('a severity-string value collapses to a bare boolean (never written back)', () => {
    expect(toggledRuleValue('error', false)).toBe(false);
    expect(toggledRuleValue('warning', true)).toBe(true);
  });
});

describe('ruleValueWithOption', () => {
  test('unknown sibling keys in the existing value survive an option edit', () => {
    expect(ruleValueWithOption({ line_length: 120, unknown_key: 'x' }, 'line_length', 100)).toEqual(
      { line_length: 100, unknown_key: 'x' },
    );
  });

  test('a new option key lands alongside the existing ones', () => {
    expect(ruleValueWithOption({ line_length: 100 }, 'code_blocks', false)).toEqual({
      line_length: 100,
      code_blocks: false,
    });
  });

  test('an enabled:false flag survives, so editing options keeps the rule off', () => {
    expect(ruleValueWithOption({ enabled: false, line_length: 80 }, 'line_length', 100)).toEqual({
      enabled: false,
      line_length: 100,
    });
  });

  test('a bare-true value starts a fresh params object', () => {
    expect(ruleValueWithOption(true, 'line_length', 100)).toEqual({ line_length: 100 });
  });

  test('a bare-false value starts a params object that stays off', () => {
    expect(ruleValueWithOption(false, 'line_length', 100)).toEqual({
      enabled: false,
      line_length: 100,
    });
  });

  test('a severity-string value is replaced by the params object (row-replace)', () => {
    expect(ruleValueWithOption('error', 'line_length', 100)).toEqual({ line_length: 100 });
  });

  test('string-array option values pass through intact', () => {
    expect(ruleValueWithOption({ match_case: true }, 'headings', ['*', '## Summary'])).toEqual({
      match_case: true,
      headings: ['*', '## Summary'],
    });
  });
});

describe('governingRuleValue', () => {
  test('the rule key wins over the config default', () => {
    expect(governingRuleValue({ MD001: false, default: true }, 'MD001')).toBe(false);
  });

  test('falls back to the config default key', () => {
    expect(governingRuleValue({ default: false }, 'MD001')).toBe(false);
  });

  test('falls back to the engine built-in (on) when neither is set', () => {
    expect(governingRuleValue({}, 'MD001')).toBe(true);
  });
});

describe('isRuleModified', () => {
  test('a key set by a governing file marks the rule modified', () => {
    expect(isRuleModified({ MD001: false }, '.markdownlint.json', 'MD001')).toBe(true);
  });

  test('tuned-default keys without a governing file are not modified', () => {
    expect(isRuleModified({ MD013: false, default: true }, null, 'MD013')).toBe(false);
  });

  test('a rule absent from the governing file is not modified', () => {
    expect(isRuleModified({ default: true }, '.markdownlint.json', 'MD001')).toBe(false);
  });
});

describe('ruleSeverity', () => {
  test('severity strings surface; other value shapes do not', () => {
    expect(ruleSeverity('error')).toBe('error');
    expect(ruleSeverity('warning')).toBe('warning');
    expect(ruleSeverity(true)).toBeNull();
    expect(ruleSeverity(false)).toBeNull();
    expect(ruleSeverity({ line_length: 100 })).toBeNull();
  });
});

describe('ruleMatchesSearch', () => {
  const md025 = MARKDOWNLINT_RULE_CATALOG.find((rule) => rule.id === 'MD025');
  if (md025 === undefined) throw new Error('MD025 missing from the generated catalog');

  test('an empty or whitespace query matches every rule', () => {
    expect(ruleMatchesSearch(md025, '')).toBe(true);
    expect(ruleMatchesSearch(md025, '   ')).toBe(true);
  });

  test('matches the id case-insensitively', () => {
    expect(ruleMatchesSearch(md025, 'md025')).toBe(true);
  });

  test('matches the primary alias', () => {
    expect(ruleMatchesSearch(md025, 'single-title')).toBe(true);
  });

  test('matches a fragment of the upstream name', () => {
    expect(ruleMatchesSearch(md025, 'top-level heading')).toBe(true);
  });

  test('rejects a query matching none of id, alias, or name', () => {
    expect(ruleMatchesSearch(md025, 'zzz-no-such-rule')).toBe(false);
  });
});
