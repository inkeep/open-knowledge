import { describe, expect, test } from 'vitest';
import { detectClipboardPrefillUrl, detectLoneGfmUrl, detectLoneTrustedUrl } from './lone-url.ts';

describe('detectLoneGfmUrl — cursor-paste policy (GFM shapes only)', () => {
  test.each([
    ['https://example.com', 'https://example.com'],
    ['http://example.com/path?q=1', 'http://example.com/path?q=1'],
    ['HTTPS://EXAMPLE.COM', 'HTTPS://EXAMPLE.COM'],
    ['www.example.com', 'www.example.com'],
    ['nick@inkeep.com', 'nick@inkeep.com'],
    ['https://en.wikipedia.org/wiki/Foo_(bar)', 'https://en.wikipedia.org/wiki/Foo_(bar)'],
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
    ['www.example.com', 'https://www.example.com'],
    ['AGENTS.md', 'https://AGENTS.md'],
    ['example.com/docs?q=1#frag', 'https://example.com/docs?q=1#frag'],
    ['example.com/@user', 'https://example.com/@user'],
  ])('schemeless dotted host gets https: %s', (raw, expected) => {
    expect(detectLoneTrustedUrl(raw)).toBe(expected);
  });

  test('email becomes mailto:', () => {
    expect(detectLoneTrustedUrl('nick@inkeep.com')).toBe('mailto:nick@inkeep.com');
  });

  test('email-shaped token the GFM grammar rejects is refused rather than guessed at', () => {
    expect(detectLoneTrustedUrl('user@host')).toBeNull();
  });

  test.each([
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
    ['example.com'],
    ['www.example.com'],
    ['nick@inkeep.com'],
    ['AGENTS.md'],
  ])('schemeless token the trust-intent policy would convert stays out: %s', (raw) => {
    expect(detectClipboardPrefillUrl(raw)).toBeNull();
  });

  test.each([
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
