import { describe, expect, test } from 'vitest';
import { isLoomUrl, parseLoomUrl } from './loom-embed.ts';

describe('parseLoomUrl', () => {
  test('accepts canonical share URLs', () => {
    expect(parseLoomUrl('https://www.loom.com/share/abc123def456ghi789jk')).toEqual({
      id: 'abc123def456ghi789jk',
      startRaw: null,
    });
    expect(parseLoomUrl('https://loom.com/share/abc123def456ghi789jk')).toEqual({
      id: 'abc123def456ghi789jk',
      startRaw: null,
    });
  });

  test('accepts already-embed URLs', () => {
    expect(parseLoomUrl('https://www.loom.com/embed/abc123def456ghi789jk')).toEqual({
      id: 'abc123def456ghi789jk',
      startRaw: null,
    });
  });

  test('accepts a real 32-char hex Loom ID', () => {
    const id = '0123456789abcdef0123456789abcdef';
    expect(parseLoomUrl(`https://www.loom.com/share/${id}`)).toEqual({
      id,
      startRaw: null,
    });
  });

  test('preserves the raw `?t=` timestamp verbatim for documented grammar', () => {
    for (const t of ['42', '42s', '2m30s', '1h2m3s', '45s', '1h', '30m', '0']) {
      expect(parseLoomUrl(`https://www.loom.com/share/abc123def456ghi789jk?t=${t}`)).toEqual({
        id: 'abc123def456ghi789jk',
        startRaw: t,
      });
    }
  });

  test('drops malformed `?t=` values to prevent embed-URL param injection', () => {
    const malformedCases = [
      '42&autoplay=false',
      '42 OR 1=1',
      'hide_owner=true',
      '42;extra',
      '#fragment',
      'NaN',
      '1m30',
      'h30s',
    ];
    for (const malformed of malformedCases) {
      const parsed = parseLoomUrl(
        `https://www.loom.com/share/abc123def456ghi789jk?t=${encodeURIComponent(malformed)}`,
      );
      expect(parsed).toEqual({
        id: 'abc123def456ghi789jk',
        startRaw: null,
      });
    }
  });

  test('bare `?t=` (empty value) collapses to null (pins the load-bearing length guard)', () => {
    expect(parseLoomUrl('https://www.loom.com/share/abc123def456ghi789jk?t=')).toEqual({
      id: 'abc123def456ghi789jk',
      startRaw: null,
    });
  });

  test('ignores unrelated query parameters (`sid`, `from`, etc.)', () => {
    expect(
      parseLoomUrl('https://www.loom.com/share/abc123def456ghi789jk?sid=session&from=email'),
    ).toEqual({
      id: 'abc123def456ghi789jk',
      startRaw: null,
    });
  });

  test('rejects non-Loom hosts', () => {
    expect(parseLoomUrl('https://youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(parseLoomUrl('https://vimeo.com/22439234')).toBeNull();
    expect(parseLoomUrl('https://example.com/share/abc123def456ghi789jk')).toBeNull();
  });

  test('rejects subdomain-spoofing hostnames', () => {
    expect(parseLoomUrl('https://loom.com.attacker.example/share/abc123def456ghi789jk')).toBeNull();
    expect(
      parseLoomUrl('https://www.loom.com.attacker.example/share/abc123def456ghi789jk'),
    ).toBeNull();
  });

  test('rejects paths outside /share/ and /embed/', () => {
    expect(parseLoomUrl('https://www.loom.com/recordings/abc123def456ghi789jk')).toBeNull();
    expect(parseLoomUrl('https://www.loom.com/login')).toBeNull();
    expect(parseLoomUrl('https://www.loom.com/')).toBeNull();
  });

  test('rejects too-short IDs (under 20 chars)', () => {
    expect(parseLoomUrl('https://www.loom.com/share/short')).toBeNull();
    expect(parseLoomUrl('https://www.loom.com/share/0123456789abcdef')).toBeNull();
  });

  test('rejects non-http(s) schemes', () => {
    expect(parseLoomUrl('javascript:alert(1)')).toBeNull();
    expect(parseLoomUrl('data:text/html,<script>1</script>')).toBeNull();
  });

  test('rejects malformed URLs and empty input', () => {
    expect(parseLoomUrl('')).toBeNull();
    expect(parseLoomUrl('not a url')).toBeNull();
    // @ts-expect-error — runtime guard against non-string callers
    expect(parseLoomUrl(undefined)).toBeNull();
    // @ts-expect-error - runtime guard against non-string callers
    expect(parseLoomUrl(null)).toBeNull();
  });
});

describe('isLoomUrl', () => {
  test('returns true for accepted Loom shapes', () => {
    expect(isLoomUrl('https://www.loom.com/share/abc123def456ghi789jk')).toBe(true);
    expect(isLoomUrl('https://loom.com/embed/abc123def456ghi789jk')).toBe(true);
  });

  test('returns false for everything else', () => {
    expect(isLoomUrl('https://youtube.com/watch?v=dQw4w9WgXcQ')).toBe(false);
    expect(isLoomUrl('https://www.loom.com/recordings/abc123def456ghi789jk')).toBe(false);
    expect(isLoomUrl('')).toBe(false);
  });
});
