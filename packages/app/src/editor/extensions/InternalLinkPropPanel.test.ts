import { describe, expect, test } from 'vitest';
import { getMarkdownLinkEditMode } from './InternalLinkPropPanel';

describe('getMarkdownLinkEditMode', () => {
  test('keeps slash-prefixed paths in doc mode', () => {
    expect(getMarkdownLinkEditMode('/', 'external')).toBe('doc');
    expect(getMarkdownLinkEditMode('/guides/install', 'external')).toBe('doc');
  });

  test('keeps protocol-relative and scheme URLs in external mode', () => {
    expect(getMarkdownLinkEditMode('//example.com', 'doc')).toBe('external');
    expect(getMarkdownLinkEditMode('https://example.com', 'doc')).toBe('external');
  });

  test('keeps hash targets in anchor mode', () => {
    expect(getMarkdownLinkEditMode('#intro', 'external')).toBe('anchor');
  });
});
