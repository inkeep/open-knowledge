/**
 * Classification matrix for the paste dispatcher's two lone-URL policies.
 *
 * Cursor policy (`detectLoneGfmUrl`) must agree with the typed-autolink
 * token policy — GFM autolink-literal shapes only — so a pasted token and a
 * typed token convert (or don't) identically. Over-selection policy
 * (`detectLoneTrustedUrl`) is deliberately broader (trust the gesture):
 * every allowlisted scheme verbatim, emails as mailto:, dotted hosts
 * https-prepended.
 */

import { describe, expect, test } from 'bun:test';
import { detectClipboardPrefillUrl, detectLoneGfmUrl, detectLoneTrustedUrl } from './lone-url.ts';

describe('detectLoneGfmUrl — cursor-paste policy (GFM shapes only)', () => {
  test.each([
    ['https://example.com', 'https://example.com'],
    ['http://example.com/path?q=1', 'http://example.com/path?q=1'],
    ['HTTPS://EXAMPLE.COM', 'HTTPS://EXAMPLE.COM'],
    ['www.example.com', 'www.example.com'],
    ['nick@inkeep.com', 'nick@inkeep.com'],
    ['https://en.wikipedia.org/wiki/Foo_(bar)', 'https://en.wikipedia.org/wiki/Foo_(bar)'],
    // Explicit-scheme dotless hosts are GFM autolink literals (the dotted-
    // domain rule is schemeless-only), so cursor paste converts them too.
    ['http://localhost:5174/', 'http://localhost:5174/'],
    ['http://127.0.0.1:8080/x', 'http://127.0.0.1:8080/x'],
  ])('accepts %s', (raw, expected) => {
    expect(detectLoneGfmUrl(raw)).toBe(expected);
  });

  test('trims clipboard whitespace padding before classifying', () => {
    expect(detectLoneGfmUrl('  https://example.com\n')).toBe('https://example.com');
  });

  test('keeps trailing punctuation on the returned token — the markdown parse applies the same GFM split at insert time', () => {
    expect(detectLoneGfmUrl('https://example.com),')).toBe('https://example.com),');
  });

  test.each([
    ['example.com'],
    ['AGENTS.md'],
    ['package.json'],
    ['localhost:5173'],
    ['localhost:5174'],
    ['foo.bar'],
    ['v1.2.3'],
    ['192.168.1.1'],
    // ftp is an allowlisted scheme but not a GFM autolink-literal shape.
    ['ftp://host/file'],
    ['see https://example.com now'],
    [''],
    ['   \n'],
  ])('rejects %s', (raw) => {
    expect(detectLoneGfmUrl(raw)).toBeNull();
  });
});

describe('detectLoneTrustedUrl — over-selection policy (trust the gesture)', () => {
  test.each([
    ['https://inkeep.com', 'https://inkeep.com'],
    ['  https://inkeep.com\n', 'https://inkeep.com'],
    ['ftp://host/file', 'ftp://host/file'],
    ['mailto:nick@inkeep.com', 'mailto:nick@inkeep.com'],
    ['tel:+15551234567', 'tel:+15551234567'],
  ])('allowlisted explicit scheme passes verbatim: %s', (raw, expected) => {
    expect(detectLoneTrustedUrl(raw)).toBe(expected);
  });

  test.each([
    ['javascript:alert(1)'],
    ['data:text/html,x'],
    ['vbscript:x'],
    ['foo:bar'],
  ])('non-allowlisted scheme is refused: %s', (raw) => {
    expect(detectLoneTrustedUrl(raw)).toBeNull();
  });

  test.each([
    ['example.com', 'https://example.com'],
    // https (not GFM's http) — the result is an explicit link, not an
    // autolink literal, so the modern default wins over pipeline parity.
    ['www.example.com', 'https://www.example.com'],
    // Any dotted host is trusted — including filename-shaped tokens the
    // typed/cursor policies reject. The gesture disambiguates.
    ['AGENTS.md', 'https://AGENTS.md'],
    ['example.com/docs?q=1#frag', 'https://example.com/docs?q=1#frag'],
    // `@` after the authority part is a path, not an email.
    ['example.com/@user', 'https://example.com/@user'],
  ])('schemeless dotted host gets https: %s', (raw, expected) => {
    expect(detectLoneTrustedUrl(raw)).toBe(expected);
  });

  test('email becomes mailto:', () => {
    expect(detectLoneTrustedUrl('nick@inkeep.com')).toBe('mailto:nick@inkeep.com');
  });

  test('email-shaped token the GFM grammar rejects is refused rather than guessed at', () => {
    // No dot in the domain → not a GFM email; https-prepending would mint
    // an unintended userinfo URL, so the classifier refuses.
    expect(detectLoneTrustedUrl('user@host')).toBeNull();
  });

  test.each([
    // Scheme grammar collides with host:port shorthand → fail closed.
    ['localhost:5173'],
    ['example.com:8080'],
    ['foo'],
    ['./relative'],
    ['/abs/path'],
    ['#fragment'],
    ['.hidden'],
    ['trailing.'],
    ['paste some prose'],
    [''],
  ])('refuses %s', (raw) => {
    expect(detectLoneTrustedUrl(raw)).toBeNull();
  });
});

describe('detectClipboardPrefillUrl — link-popover pre-fill policy (explicit scheme only)', () => {
  test.each([
    ['https://inkeep.com/docs', 'https://inkeep.com/docs'],
    ['  https://inkeep.com\n', 'https://inkeep.com'],
    ['http://example.com', 'http://example.com'],
    ['mailto:nick@inkeep.com', 'mailto:nick@inkeep.com'],
    ['tel:+15551234567', 'tel:+15551234567'],
    ['ftp://host/file', 'ftp://host/file'],
  ])('pre-fills an allowlisted explicit-scheme URL verbatim: %s', (raw, expected) => {
    expect(detectClipboardPrefillUrl(raw)).toBe(expected);
  });

  test.each([
    ['javascript:alert(1)'],
    ['data:text/html,x'],
    ['vbscript:x'],
  ])('non-allowlisted scheme never pre-fills: %s', (raw) => {
    expect(detectClipboardPrefillUrl(raw)).toBeNull();
  });

  test.each([
    // The over-selection policy converts all four of these; the speculative
    // pre-fill deliberately does not — no prepending, no mailto: minting.
    ['example.com'],
    ['www.example.com'],
    ['nick@inkeep.com'],
    ['AGENTS.md'],
  ])('schemeless token the trust-intent policy would convert stays out: %s', (raw) => {
    expect(detectClipboardPrefillUrl(raw)).toBeNull();
  });

  test.each([
    // Scheme grammar collides with host:port shorthand → fail closed.
    ['localhost:5173'],
    ['example.com:8080'],
    ['see https://example.com now'],
    ['https://a.com\nhttps://b.com'],
    [''],
    ['   \n'],
  ])('refuses %s', (raw) => {
    expect(detectClipboardPrefillUrl(raw)).toBeNull();
  });
});
