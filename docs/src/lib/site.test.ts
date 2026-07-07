import { describe, expect, test } from 'bun:test';
import { metaDescription, SITE_DESCRIPTION } from './site.ts';

const MAX = 160;

describe('metaDescription', () => {
  test('falls back to SITE_DESCRIPTION for empty / whitespace / null / undefined', () => {
    expect(metaDescription('')).toBe(SITE_DESCRIPTION);
    expect(metaDescription('   ')).toBe(SITE_DESCRIPTION);
    expect(metaDescription(null)).toBe(SITE_DESCRIPTION);
    expect(metaDescription(undefined)).toBe(SITE_DESCRIPTION);
  });

  test('honors an explicit fallback when text is empty', () => {
    expect(metaDescription('', 'custom fallback')).toBe('custom fallback');
  });

  test('passes short text through unchanged', () => {
    const s = 'A concise, healthy-length description.';
    expect(metaDescription(s)).toBe(s);
  });

  test('collapses internal whitespace and trims', () => {
    expect(metaDescription('  hello   world\n\tagain  ')).toBe('hello world again');
  });

  test('passes through text exactly at the limit without truncating', () => {
    const s = 'a'.repeat(MAX);
    expect(metaDescription(s)).toBe(s);
  });

  test('truncates over-long text to within the limit with an ellipsis', () => {
    const s = 'word '.repeat(60); // 300 chars
    const out = metaDescription(s);
    expect(out.length).toBeLessThanOrEqual(MAX);
    expect(out.endsWith('…')).toBe(true);
  });

  test('prefers a word boundary — does not cut mid-word when a space is available', () => {
    const s = `${'alpha '.repeat(40)}END`; // long, spaced
    const out = metaDescription(s);
    // The kept portion (sans ellipsis) ends on a whole word, not a partial.
    const body = out.replace(/…$/, '');
    expect(body.endsWith(' ')).toBe(false);
    expect(body).toBe(body.trimEnd());
    // Every retained token is the complete word "alpha", never a fragment.
    for (const token of body.split(' ')) {
      expect(token).toBe('alpha');
    }
  });

  test('hard-slices when there is no usable space in the truncation window', () => {
    const s = 'x'.repeat(MAX + 50); // single unbroken token
    const out = metaDescription(s);
    expect(out.length).toBeLessThanOrEqual(MAX);
    expect(out.endsWith('…')).toBe(true);
  });
});
