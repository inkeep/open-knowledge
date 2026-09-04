import { describe, expect, test } from 'vitest';
import { MARKDOWN_MEDIA_TYPES, prefersMarkdown } from './accept-negotiation.ts';

const BROWSER_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
const SAFARI_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const CODING_AGENT_ACCEPT = 'text/markdown, text/html, */*';

describe('prefersMarkdown serves Markdown only on an explicit, winning ask', () => {
  test.each([
    ['bare text/markdown', 'text/markdown'],
    ['the text/x-markdown spelling', 'text/x-markdown'],
    ['a coding agent listing Markdown first at equal weight', CODING_AGENT_ACCEPT],
    ['Markdown outweighing HTML', 'text/html;q=0.5, text/markdown;q=0.9'],
    ['Markdown above a de-weighted wildcard', 'text/markdown, */*;q=0.1'],
    ['HTML explicitly refused', 'text/html;q=0, text/markdown'],
    ['a wildcard listed first but less specific', '*/*, text/markdown'],
    [
      'Markdown above a weakened HTML, wildcard present',
      'text/markdown;q=0.5, text/html;q=0.1, */*',
    ],
    [
      'a type wildcard not overriding the exact HTML entry',
      'text/markdown;q=0.3, text/html;q=0.2, text/*;q=0.9',
    ],
    ['parameters and casing the client chose', 'Text/Markdown; charset=utf-8'],
  ])('%s wins Markdown', (_label, accept) => {
    expect(prefersMarkdown(accept)).toBe(true);
  });

  test.each([
    ['Chrome', BROWSER_ACCEPT],
    ['Safari', SAFARI_ACCEPT],
    ['a bare wildcard', '*/*'],
    ['a type wildcard', 'text/*'],
    ['text/plain, which asks for text without markup', 'text/plain'],
    ['text/plain ranked above HTML', 'text/plain, text/html;q=0.5'],
    ['Markdown ranked below HTML', 'text/html, text/markdown;q=0.1'],
    ['Markdown refused outright', 'text/markdown;q=0, text/html'],
    ['Markdown tied with HTML but listed second', 'text/html, text/markdown'],
    ['no Accept at all', null],
    ['an empty Accept', ''],
    ['JSON', 'application/json'],
  ])('%s gets HTML', (_label, accept) => {
    expect(prefersMarkdown(accept)).toBe(false);
  });
});

describe('prefersMarkdown survives malformed input', () => {
  test.each([
    ['a bare token with no slash', 'garbage'],
    ['punctuation', ';;;,,,'],
    ['an unreadable quality on the Markdown entry', 'text/markdown;q=abc'],
    ['a truncated header', 'text/markdown;'],
  ])('%s never throws', (_label, accept) => {
    expect(() => prefersMarkdown(accept)).not.toThrow();
  });

  test('an unreadable quality drops that entry rather than weighting it', () => {
    expect(prefersMarkdown('text/markdown;q=abc')).toBe(false);
    expect(prefersMarkdown('text/markdown;q=abc, text/html')).toBe(false);
  });

  test('stray commas and whitespace do not create phantom entries', () => {
    expect(prefersMarkdown(' , text/markdown , ')).toBe(true);
  });

  test('a quality above 1 is clamped rather than used to outrank', () => {
    expect(prefersMarkdown('text/html;q=1, text/markdown;q=5')).toBe(false);
  });
});

describe('MARKDOWN_MEDIA_TYPES', () => {
  test('does not include text/plain', () => {
    expect(MARKDOWN_MEDIA_TYPES).not.toContain('text/plain');
  });
});
