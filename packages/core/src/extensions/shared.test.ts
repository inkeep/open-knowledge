import { describe, expect, test } from 'vitest';
import { MarkdownManager } from '../markdown/index.ts';
import { sharedExtensions } from './shared';

const mdManager = new MarkdownManager({ extensions: sharedExtensions });

describe('Link extension round-trip', () => {
  test('inline link parses and serializes correctly', () => {
    const original = 'Check out [this link](https://example.com) for more.';
    const parsed = mdManager.parse(original);
    const serialized = mdManager.serialize(parsed);
    expect(serialized.trim()).toBe(original);
  });

  test('link with title parses and serializes correctly', () => {
    const original = '[Example](https://example.com "My title")';
    const parsed = mdManager.parse(original);
    const serialized = mdManager.serialize(parsed);
    expect(serialized.trim()).toBe(original);
  });

  test('multiple links in a paragraph round-trip correctly', () => {
    const original = 'See [foo](https://foo.com) and [bar](https://bar.com).';
    const parsed = mdManager.parse(original);
    const serialized = mdManager.serialize(parsed);
    expect(serialized.trim()).toBe(original);
  });

  test('link href is preserved after round-trip', () => {
    const original = '[click here](https://example.com/path?q=1&r=2)';
    const parsed = mdManager.parse(original);
    const serialized = mdManager.serialize(parsed);
    expect(serialized.trim()).toBe(original);
  });
});
