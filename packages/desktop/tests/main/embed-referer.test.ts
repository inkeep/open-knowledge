import { describe, expect, test } from 'bun:test';
import {
  EMBED_HOST_PATTERNS,
  EMBED_REFERER,
  rewriteEmbedRequestHeaders,
} from '../../src/main/embed-referer.ts';

describe('EMBED_REFERER', () => {
  test('is a real HTTPS origin (YouTube rejects file:// and empty)', () => {
    expect(EMBED_REFERER.startsWith('https://')).toBe(true);
    // Sanity: trailing slash so the value is a complete origin, not a path.
    expect(EMBED_REFERER.endsWith('/')).toBe(true);
  });
});

describe('EMBED_HOST_PATTERNS', () => {
  test('covers both subdomained and bare YouTube hosts (www, m, music, …)', () => {
    expect(EMBED_HOST_PATTERNS).toContain('https://*.youtube.com/*');
    expect(EMBED_HOST_PATTERNS).toContain('https://youtube.com/*');
  });

  test('covers the privacy-enhanced youtube-nocookie.com host', () => {
    expect(EMBED_HOST_PATTERNS).toContain('https://*.youtube-nocookie.com/*');
    expect(EMBED_HOST_PATTERNS).toContain('https://youtube-nocookie.com/*');
  });

  test('does not cover Vimeo / Loom (their iframes accept any embedding origin)', () => {
    // Pin the scope decision so a future broadening surfaces here — a
    // Vimeo/Loom-also-failing report should bring this test with it.
    expect(EMBED_HOST_PATTERNS.some((p) => p.includes('vimeo'))).toBe(false);
    expect(EMBED_HOST_PATTERNS.some((p) => p.includes('loom'))).toBe(false);
  });
});

describe('rewriteEmbedRequestHeaders', () => {
  test('sets Referer to the canonical embed origin when absent', () => {
    const out = rewriteEmbedRequestHeaders({
      'User-Agent': 'Electron/Whatever',
    });
    expect(out.Referer).toBe(EMBED_REFERER);
    // Other headers preserved.
    expect(out['User-Agent']).toBe('Electron/Whatever');
  });

  test('replaces an existing Referer (file:// origin → embed origin)', () => {
    const out = rewriteEmbedRequestHeaders({
      Referer: 'file:///Users/me/desktop-build/index.html',
    });
    expect(out.Referer).toBe(EMBED_REFERER);
  });

  test('drops lowercase `referer` to avoid duplicate casings in the outbound request', () => {
    // Electron's HttpHeaders is case-insensitive on read but preserves
    // the casing of the last write. Downstream HTTP libs vary on which
    // they emit, so the rewrite normalizes to a single canonical
    // `Referer` and drops any stale lowercase entry.
    const out = rewriteEmbedRequestHeaders({
      referer: 'file:///path/to/old',
      'X-Custom': 'keep-me',
    });
    expect(out.Referer).toBe(EMBED_REFERER);
    expect('referer' in out).toBe(false);
    expect(out['X-Custom']).toBe('keep-me');
  });

  test('is idempotent — re-applying yields the same output', () => {
    const once = rewriteEmbedRequestHeaders({ 'User-Agent': 'UA' });
    const twice = rewriteEmbedRequestHeaders(once);
    expect(twice).toEqual(once);
    expect(twice.Referer).toBe(EMBED_REFERER);
  });

  test('preserves array-valued headers (Electron typing allows string[])', () => {
    const out = rewriteEmbedRequestHeaders({
      'Accept-Language': ['en-US', 'en;q=0.9'],
    });
    expect(out['Accept-Language']).toEqual(['en-US', 'en;q=0.9']);
    expect(out.Referer).toBe(EMBED_REFERER);
  });

  test('returns a new object — does not mutate the input', () => {
    const input: Record<string, string | string[]> = {
      Referer: 'file:///old',
      'User-Agent': 'UA',
    };
    rewriteEmbedRequestHeaders(input);
    // Input unchanged.
    expect(input.Referer).toBe('file:///old');
  });
});
