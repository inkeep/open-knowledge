import { describe, expect, test } from 'vitest';
import { sharedExtensions } from '../extensions/shared.ts';
import { MarkdownManager } from '../markdown/index.ts';
import { jsxAttributeValue } from './jsx-attribute-value.ts';

describe('jsxAttributeValue', () => {
  test('reads a valueless attribute as true', () => {
    expect(jsxAttributeValue(null)).toBe(true);
  });

  test('reads a quoted value as text, or as the number or boolean its prop declares', () => {
    expect(jsxAttributeValue('7')).toBe('7');
    expect(jsxAttributeValue('7', { type: 'number' })).toBe(7);
    expect(jsxAttributeValue('true', { type: 'boolean' })).toBe(true);
  });

  test('keeps text that is not a number on a number prop, and reads only "true" as true', () => {
    expect(jsxAttributeValue('100%', { type: 'number' })).toBe('100%');
    expect(jsxAttributeValue('false', { type: 'boolean' })).toBe(false);
    expect(jsxAttributeValue('yes', { type: 'boolean' })).toBe(false);
  });

  test('is what the parser stores, typed by the component prop it fills', () => {
    const doc = new MarkdownManager({ extensions: sharedExtensions }).parse(
      '<img src="photo.png" alt="Team photo" width="320" />\n',
    );
    const image = (doc.content ?? []).find((node) => node.type === 'jsxComponent');
    expect((image?.attrs?.props as Record<string, unknown> | undefined)?.width).toBe(320);
  });

  test('parses an expression value as JSON, keeping its source text when it is not JSON', () => {
    expect(jsxAttributeValue({ value: '42' })).toBe(42);
    expect(jsxAttributeValue({ value: '"plans"' })).toBe('plans');
    expect(jsxAttributeValue({ value: 'plans' })).toBe('plans');
  });
});
