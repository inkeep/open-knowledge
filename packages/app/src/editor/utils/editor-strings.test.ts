import { describe, expect, test } from 'bun:test';
import { formatContainerAriaLabel, humanizePropName } from './editor-strings';

describe('formatContainerAriaLabel', () => {
  test('empty container emits "(empty)"', () => {
    expect(formatContainerAriaLabel('Cards', 'Card', 0)).toBe('Cards (empty)');
  });

  test('single child uses "item" (Intl.PluralRules "one")', () => {
    expect(formatContainerAriaLabel('Cards', 'Card', 1)).toBe('Cards with 1 item');
    expect(formatContainerAriaLabel('Steps', 'Step', 1)).toBe('Steps with 1 item');
  });

  test('multiple children uses "items"', () => {
    expect(formatContainerAriaLabel('Cards', 'Card', 3)).toBe('Cards with 3 items');
    expect(formatContainerAriaLabel('Cards', 'Card', 10)).toBe('Cards with 10 items');
  });

  test('negative child counts collapse to empty state', () => {
    expect(formatContainerAriaLabel('Cards', 'Card', -1)).toBe('Cards (empty)');
  });

  test('irregular noun is not inflected — "item/items" stays fixed', () => {
    // The new shape ignores childName for the output prose so irregular
    // plurals are unreachable.
    expect(formatContainerAriaLabel('Feet', 'Foot', 3)).toBe('Feet with 3 items');
  });
});

describe('humanizePropName', () => {
  test('camelCase splits on uppercase boundaries', () => {
    expect(humanizePropName('emptyChildName')).toBe('Empty Child Name');
  });

  test('snake_case splits on underscore (only first character capitalized)', () => {
    expect(humanizePropName('default_value')).toBe('Default value');
  });

  test('kebab-case splits on dash (only first character capitalized)', () => {
    expect(humanizePropName('default-value')).toBe('Default value');
  });

  test('consecutive capitals followed by lowercase split correctly', () => {
    expect(humanizePropName('ARIALabel')).toBe('ARIA Label');
  });

  test('empty string passes through unchanged', () => {
    expect(humanizePropName('')).toBe('');
  });
});
