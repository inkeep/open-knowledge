import { describe, expect, test } from 'vitest';
import {
  hasInlineLinks,
  type PropertyInlineSegment,
  tokenizePropertyInlineLinks,
} from './property-inline-link-tokens';

function reassemble(segments: PropertyInlineSegment[]): string {
  return segments.map((seg) => (seg.type === 'text' ? seg.value : seg.raw)).join('');
}

function expectRoundTrip(input: string, segments: PropertyInlineSegment[]): void {
  expect(reassemble(segments)).toBe(input);
}

describe('tokenizePropertyInlineLinks — wiki-links', () => {
  test('bare wikilink at the start, followed by trailing prose', () => {
    const input = '[[Some/Page]] — description';
    const segs = tokenizePropertyInlineLinks(input);
    expect(segs).toEqual([
      {
        type: 'wikilink',
        raw: '[[Some/Page]]',
        target: 'Some/Page',
        alias: null,
        anchor: null,
      },
      { type: 'text', value: ' — description' },
    ]);
    expectRoundTrip(input, segs);
  });

  test('wikilink with alias', () => {
    const input = '[[Some/Page|My Alias]]';
    const segs = tokenizePropertyInlineLinks(input);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toEqual({
      type: 'wikilink',
      raw: '[[Some/Page|My Alias]]',
      target: 'Some/Page',
      alias: 'My Alias',
      anchor: null,
    });
  });

  test('wikilink with anchor', () => {
    const input = '[[Some/Page#heading-slug]]';
    const segs = tokenizePropertyInlineLinks(input);
    expect(segs[0]).toEqual({
      type: 'wikilink',
      raw: '[[Some/Page#heading-slug]]',
      target: 'Some/Page',
      alias: null,
      anchor: 'heading-slug',
    });
  });

  test('multiple wikilinks separated by prose', () => {
    const input = '[[A]] and [[B|alias]] together';
    const segs = tokenizePropertyInlineLinks(input);
    expect(segs.map((s) => s.type)).toEqual(['wikilink', 'text', 'wikilink', 'text']);
    expectRoundTrip(input, segs);
  });

  test('PRD-7111 reported shape — wikilink + em-dash + parenthetical', () => {
    const input =
      '[[public/open-knowledge/specs/2026-06-12-showall-truncation-ux/SPEC]] — which entries appear (cap), NOT horizontal density';
    const segs = tokenizePropertyInlineLinks(input);
    expect(segs[0]).toEqual({
      type: 'wikilink',
      raw: '[[public/open-knowledge/specs/2026-06-12-showall-truncation-ux/SPEC]]',
      target: 'public/open-knowledge/specs/2026-06-12-showall-truncation-ux/SPEC',
      alias: null,
      anchor: null,
    });
    expectRoundTrip(input, segs);
  });

  test('empty wikilink `[[]]` is not a wikilink — renders as plain text', () => {
    const input = '[[]]';
    const segs = tokenizePropertyInlineLinks(input);
    expect(segs).toEqual([{ type: 'text', value: '[[]]' }]);
  });

  test('unbalanced `[[Page` falls through to text', () => {
    const input = 'lead [[Page in middle';
    const segs = tokenizePropertyInlineLinks(input);
    expect(segs).toEqual([{ type: 'text', value: 'lead [[Page in middle' }]);
  });
});

describe('tokenizePropertyInlineLinks — markdown links', () => {
  test('bare markdown link', () => {
    const input = '[label](https://example.com)';
    const segs = tokenizePropertyInlineLinks(input);
    expect(segs).toEqual([
      {
        type: 'link',
        raw: '[label](https://example.com)',
        text: 'label',
        url: 'https://example.com',
      },
    ]);
  });

  test('markdown link embedded in prose', () => {
    const input = 'see [the page](./foo.md) for details';
    const segs = tokenizePropertyInlineLinks(input);
    expect(segs.map((s) => s.type)).toEqual(['text', 'link', 'text']);
    expectRoundTrip(input, segs);
  });

  test('relative markdown link', () => {
    const input = '[doc](./folder/doc.md)';
    const segs = tokenizePropertyInlineLinks(input);
    expect(segs).toEqual([
      { type: 'link', raw: '[doc](./folder/doc.md)', text: 'doc', url: './folder/doc.md' },
    ]);
  });

  test('malformed: missing `(` after `]` — falls through to text', () => {
    const input = '[label] no paren';
    const segs = tokenizePropertyInlineLinks(input);
    expect(segs).toEqual([{ type: 'text', value: '[label] no paren' }]);
  });

  test('malformed: missing closing `)` — link rejected, but bare URL still recognized', () => {
    const input = '[label](https://example.com';
    const segs = tokenizePropertyInlineLinks(input);
    expect(segs).toEqual([
      { type: 'text', value: '[label](' },
      { type: 'autolink', raw: 'https://example.com', url: 'https://example.com' },
    ]);
  });

  test('empty URL `[text]()` — falls through to text', () => {
    const input = '[text]()';
    const segs = tokenizePropertyInlineLinks(input);
    expect(segs).toEqual([{ type: 'text', value: '[text]()' }]);
  });

  test('nested `[` inside text — falls through to text', () => {
    const input = '[a [b] c](url)';
    const segs = tokenizePropertyInlineLinks(input);
    expect(segs).toEqual([{ type: 'text', value: '[a [b] c](url)' }]);
  });
});

describe('tokenizePropertyInlineLinks — bare URLs (autolinks)', () => {
  test('bare URL renders as autolink', () => {
    const input = 'https://example.com';
    const segs = tokenizePropertyInlineLinks(input);
    expect(segs).toEqual([
      { type: 'autolink', raw: 'https://example.com', url: 'https://example.com' },
    ]);
  });

  test('http (not https) also recognized', () => {
    const input = 'http://example.com/path';
    const segs = tokenizePropertyInlineLinks(input);
    expect(segs[0]).toEqual({
      type: 'autolink',
      raw: 'http://example.com/path',
      url: 'http://example.com/path',
    });
  });

  test('bare URL embedded in prose', () => {
    const input = 'visit https://example.com today';
    const segs = tokenizePropertyInlineLinks(input);
    expect(segs.map((s) => s.type)).toEqual(['text', 'autolink', 'text']);
    expectRoundTrip(input, segs);
  });

  test('trailing punctuation stripped from URL', () => {
    const input = 'see https://example.com.';
    const segs = tokenizePropertyInlineLinks(input);
    const autolink = segs.find((s) => s.type === 'autolink');
    expect(autolink).toBeDefined();
    if (autolink?.type !== 'autolink') throw new Error('unreachable');
    expect(autolink.url).toBe('https://example.com');
    expectRoundTrip(input, segs);
  });

  test('URL with balanced parens kept whole', () => {
    const input = 'https://en.wikipedia.org/wiki/Foo_(disambiguation)';
    const segs = tokenizePropertyInlineLinks(input);
    expect(segs).toEqual([
      {
        type: 'autolink',
        raw: 'https://en.wikipedia.org/wiki/Foo_(disambiguation)',
        url: 'https://en.wikipedia.org/wiki/Foo_(disambiguation)',
      },
    ]);
  });

  test('URL inside parentheses — trailing `)` stripped (no matching `(` in URL)', () => {
    const input = 'as documented (see https://example.com) for details';
    const segs = tokenizePropertyInlineLinks(input);
    const autolink = segs.find((s) => s.type === 'autolink');
    expect(autolink).toBeDefined();
    if (autolink?.type !== 'autolink') throw new Error('unreachable');
    expect(autolink.url).toBe('https://example.com');
    expectRoundTrip(input, segs);
  });
});

describe('tokenizePropertyInlineLinks — mixed', () => {
  test('wikilink, markdown link, autolink in one string', () => {
    const input = '[[A]] then [B](./b.md) and https://c.example';
    const segs = tokenizePropertyInlineLinks(input);
    expect(segs.map((s) => s.type)).toEqual(['wikilink', 'text', 'link', 'text', 'autolink']);
    expectRoundTrip(input, segs);
  });

  test('plain text only', () => {
    const input = 'no links here, just words';
    const segs = tokenizePropertyInlineLinks(input);
    expect(segs).toEqual([{ type: 'text', value: 'no links here, just words' }]);
  });

  test('empty string', () => {
    expect(tokenizePropertyInlineLinks('')).toEqual([]);
  });
});

describe('hasInlineLinks', () => {
  test('returns false for plain text', () => {
    expect(hasInlineLinks('plain words')).toBe(false);
  });

  test('returns false for empty string', () => {
    expect(hasInlineLinks('')).toBe(false);
  });

  test('returns true for wikilink', () => {
    expect(hasInlineLinks('[[Page]] text')).toBe(true);
  });

  test('returns true for markdown link', () => {
    expect(hasInlineLinks('[text](url)')).toBe(true);
  });

  test('returns true for bare URL', () => {
    expect(hasInlineLinks('see https://example.com')).toBe(true);
  });

  test('cheap-probe short-circuit: text containing `[[` but no real wikilink → still calls tokenizer', () => {
    expect(hasInlineLinks('value with [[]] sequence')).toBe(false);
  });
});
