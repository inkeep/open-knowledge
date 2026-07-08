import { describe, expect, test } from 'bun:test';
import { MarkdownManager, SAFE_URL_SCHEMES, sharedExtensions } from '@inkeep/open-knowledge-core';
import type { JSONContent } from '@tiptap/core';
import { detectGfmLinkToken, type GfmLinkToken } from './gfm-link-detector';

// Real pipeline, shared with production — the parity oracle. Constructing one
// manager pulls the same remark-gfm autolink transform the editor uses.
const mdManager = new MarkdownManager({ extensions: sharedExtensions });

/** Walk a parsed doc for the first text run carrying a link mark and return
 *  the exact {href, text} the pipeline produced (or null if nothing linked). */
function parseFirstLink(token: string): GfmLinkToken | null {
  function walk(node: JSONContent): GfmLinkToken | null {
    const mark = node.marks?.find((m) => m.type === 'link');
    if (mark) {
      return { href: String(mark.attrs?.href ?? ''), text: node.text ?? '' };
    }
    for (const child of node.content ?? []) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  }
  return walk(mdManager.parse(token));
}

// The locked acceptance matrix. `null` = stays plain text.
const MATRIX: Array<{ token: string; expected: GfmLinkToken | null }> = [
  {
    token: 'https://example.com',
    expected: { href: 'https://example.com', text: 'https://example.com' },
  },
  {
    token: 'www.example.com',
    expected: { href: 'http://www.example.com', text: 'www.example.com' },
  },
  { token: 'a@b.com', expected: { href: 'mailto:a@b.com', text: 'a@b.com' } },
  { token: 'example.com', expected: null },
  { token: 'AGENTS.md', expected: null },
  { token: 'package.json', expected: null },
  { token: 'localhost:5173', expected: null },
  { token: 'foo.bar', expected: null },
  { token: 'v1.2.3', expected: null },
  { token: '192.168.1.1', expected: null },
  // Explicit-scheme dotless hosts: micromark's http_autolink skips the
  // dotted-domain requirement, so these linkify and round-trip as bare
  // literals (the schemeless rows above stay rejected).
  {
    token: 'http://localhost:5174',
    expected: { href: 'http://localhost:5174', text: 'http://localhost:5174' },
  },
  {
    token: 'http://localhost:5174/#/doc',
    expected: { href: 'http://localhost:5174/#/doc', text: 'http://localhost:5174/#/doc' },
  },
  { token: 'http://localhost', expected: { href: 'http://localhost', text: 'http://localhost' } },
  {
    token: 'http://127.0.0.1:8080/x',
    expected: { href: 'http://127.0.0.1:8080/x', text: 'http://127.0.0.1:8080/x' },
  },
  { token: 'localhost:5174', expected: null },
  { token: 'http://foo_bar', expected: null },
  // Ported edge branches — splitUrl's trailing-punctuation / unbalanced-paren
  // strips, isCorrectDomain's underscore reject, the email bad-tail reject,
  // and their keep-side complements. In this array they get parity coverage
  // against the real parse like every other row, which is what guards the
  // hand-port against upstream drift.
  {
    token: 'https://example.com.',
    expected: { href: 'https://example.com', text: 'https://example.com' },
  },
  {
    token: 'https://example.com)',
    expected: { href: 'https://example.com', text: 'https://example.com' },
  },
  { token: 'https://foo_bar.com', expected: null },
  { token: 'a@b.c_', expected: null },
  { token: 'user@host.com-', expected: null },
  { token: 'a@b.co1', expected: null },
  { token: 'a@b_c.com', expected: { href: 'mailto:a@b_c.com', text: 'a@b_c.com' } },
  {
    token: 'www.a_b.example.com',
    expected: { href: 'http://www.a_b.example.com', text: 'www.a_b.example.com' },
  },
];

describe('detectGfmLinkToken — acceptance matrix', () => {
  for (const { token, expected } of MATRIX) {
    test(`${token} → ${expected ? `link ${expected.href}` : 'plain text'}`, () => {
      expect(detectGfmLinkToken(token)).toEqual(expected);
    });
  }
});

describe('detectGfmLinkToken — parity with MarkdownManager.parse', () => {
  // The single-source-of-truth contract: for every matrix token the detector
  // agrees with what the real pipeline linkifies (verdict AND href).
  const parityTokens = [
    ...MATRIX.map((row) => row.token),
    'http://example.com',
    'HTTPS://Example.com',
    'WWW.Example.com',
    'a.b@c.co.uk',
    'ftp://files.example.com',
    'https://en.wikipedia.org/wiki/Foo_(bar)',
  ];
  for (const token of parityTokens) {
    test(`agrees with the pipeline for ${token}`, () => {
      expect(detectGfmLinkToken(token)).toEqual(parseFirstLink(token));
    });
  }
});

describe('detectGfmLinkToken — bare domains are rejected structurally, not by TLD', () => {
  // No TLD table ships. A bare domain never linkifies regardless of how
  // real its suffix looks; only a scheme, `www.`, or `@` promotes it.
  for (const token of [
    'example.com',
    'foo.bar',
    'a.io',
    'my-site.dev',
    'stripe.com',
    '192.168.1.1',
  ]) {
    test(`${token} stays plain text`, () => {
      expect(detectGfmLinkToken(token)).toBeNull();
    });
  }
});

describe('detectGfmLinkToken — href scheme stays inside the allowlist', () => {
  test('every produced href uses a SAFE_URL_SCHEMES scheme', () => {
    const allowed = SAFE_URL_SCHEMES.map((s) => `${s}:`);
    for (const token of [
      'https://example.com',
      'http://example.com',
      'www.example.com',
      'a@b.com',
    ]) {
      const result = detectGfmLinkToken(token);
      expect(result).not.toBeNull();
      const href = result?.href.toLowerCase() ?? '';
      expect(allowed.some((prefix) => href.startsWith(prefix))).toBe(true);
    }
  });

  test('ftp:// is a safe scheme but not a GFM shape, so it does not convert', () => {
    // Guards against widening the recognizer to the full scheme allowlist:
    // the shape rules are GFM's (http/https/www/email), not SAFE_URL_SCHEMES.
    expect(detectGfmLinkToken('ftp://files.example.com')).toBeNull();
  });
});

describe('detectGfmLinkToken — href shape details', () => {
  test('www. tokens get an http:// href, not https://', () => {
    expect(detectGfmLinkToken('www.example.com')?.href).toBe('http://www.example.com');
  });

  test('scheme match is case-insensitive and preserves original casing', () => {
    expect(detectGfmLinkToken('HTTPS://Example.com')).toEqual({
      href: 'HTTPS://Example.com',
      text: 'HTTPS://Example.com',
    });
    expect(detectGfmLinkToken('WWW.Example.com')?.href).toBe('http://WWW.Example.com');
  });

  test('email tokens become mailto: hrefs with the address as text', () => {
    expect(detectGfmLinkToken('a.b@c.co.uk')).toEqual({
      href: 'mailto:a.b@c.co.uk',
      text: 'a.b@c.co.uk',
    });
  });

  test('trailing sentence punctuation is split off the linkified span', () => {
    expect(detectGfmLinkToken('https://example.com.')).toEqual({
      href: 'https://example.com',
      text: 'https://example.com',
    });
  });

  test('a closing paren that balances an opening paren stays in the link', () => {
    expect(detectGfmLinkToken('https://en.wikipedia.org/wiki/Foo_(bar)')?.text).toBe(
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    );
  });

  test('empty string is not a link', () => {
    expect(detectGfmLinkToken('')).toBeNull();
  });
});
