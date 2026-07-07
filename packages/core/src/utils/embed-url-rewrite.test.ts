import { describe, expect, test } from 'bun:test';
import { isEmbedUrlRewritable, rewriteEmbedUrl } from './embed-url-rewrite.ts';

describe('rewriteEmbedUrl — YouTube', () => {
  test('youtube.com/watch?v=ID → /embed/ID', () => {
    expect(rewriteEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    );
  });

  test('youtu.be/ID short link → /embed/ID', () => {
    expect(rewriteEmbedUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    );
  });

  test('youtube.com/shorts/ID → /embed/ID', () => {
    expect(rewriteEmbedUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    );
  });

  test('youtube-nocookie.com/watch?v=ID → nocookie embed', () => {
    expect(rewriteEmbedUrl('https://www.youtube-nocookie.com/watch?v=dQw4w9WgXcQ')).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    );
  });

  test('?t=42 timestamp → ?start=42 on embed', () => {
    expect(rewriteEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ?start=42',
    );
  });

  test('youtu.be/ID?t=2m30s → ?start=150', () => {
    expect(rewriteEmbedUrl('https://youtu.be/dQw4w9WgXcQ?t=2m30s')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ?start=150',
    );
  });
});

describe('rewriteEmbedUrl — Vimeo', () => {
  test('vimeo.com/ID → player.vimeo.com/video/ID', () => {
    expect(rewriteEmbedUrl('https://vimeo.com/123456789')).toBe(
      'https://player.vimeo.com/video/123456789',
    );
  });

  test('www.vimeo.com/ID → player.vimeo.com/video/ID', () => {
    expect(rewriteEmbedUrl('https://www.vimeo.com/123456789')).toBe(
      'https://player.vimeo.com/video/123456789',
    );
  });

  test('vimeo.com/<id>/<hash> unlisted-link form → player.vimeo.com/video/<id>', () => {
    // Unlisted videos take a path-hash after the ID. The hash is required
    // for authentication on the player surface — Vimeo's iframe normally
    // honors it via a sibling `h=` query param. Today this rewrite drops
    // the hash; that's a known gap (unlisted videos won't authenticate
    // through the rewritten URL).
    // authors who hit it can paste the player.vimeo.com URL directly.
    expect(rewriteEmbedUrl('https://vimeo.com/123456789/abc123')).toBe(
      'https://player.vimeo.com/video/123456789',
    );
  });

  test('player.vimeo.com/video/ID (already embed) → unchanged', () => {
    // Returning the embed URL verbatim is the right answer — short-
    // circuiting the rewrite would also be correct but adds branches.
    expect(rewriteEmbedUrl('https://player.vimeo.com/video/123456789')).toBe(
      'https://player.vimeo.com/video/123456789',
    );
  });

  test('vimeo.com/channels/foo (no ID) → unchanged', () => {
    // Channel / group / showcase pages have no per-video iframe
    // equivalent. The rewrite returns the input so the iframe fails
    // visibly and the author switches to the canonical URL.
    const channelUrl = 'https://vimeo.com/channels/staffpicks';
    expect(rewriteEmbedUrl(channelUrl)).toBe(channelUrl);
  });
});

describe('rewriteEmbedUrl — Loom', () => {
  test('loom.com/share/ID → /embed/ID', () => {
    expect(rewriteEmbedUrl('https://www.loom.com/share/abcdef0123456789abcdef0123456789')).toBe(
      'https://www.loom.com/embed/abcdef0123456789abcdef0123456789',
    );
  });

  test('loom.com/share/ID?t=42 → /embed/ID?t=42', () => {
    expect(
      rewriteEmbedUrl('https://www.loom.com/share/abcdef0123456789abcdef0123456789?t=42'),
    ).toBe('https://www.loom.com/embed/abcdef0123456789abcdef0123456789?t=42');
  });
});

describe('rewriteEmbedUrl — passthrough', () => {
  test('arbitrary https URL → unchanged', () => {
    expect(rewriteEmbedUrl('https://example.com/page')).toBe('https://example.com/page');
  });

  test('codesandbox / figma / etc. → unchanged', () => {
    expect(rewriteEmbedUrl('https://codesandbox.io/s/abc')).toBe('https://codesandbox.io/s/abc');
    expect(rewriteEmbedUrl('https://www.figma.com/embed?embed_host=share&url=...')).toBe(
      'https://www.figma.com/embed?embed_host=share&url=...',
    );
  });

  test('empty string → unchanged', () => {
    expect(rewriteEmbedUrl('')).toBe('');
  });

  test('malformed URL → unchanged', () => {
    // No URL parse → no rewriter recognizes it → returned as-is.
    expect(rewriteEmbedUrl('not a url at all')).toBe('not a url at all');
  });

  test('javascript: / data: schemes → unchanged (caller still gates on scheme)', () => {
    // `<Embed>` itself refuses non-http(s) schemes upstream; the rewriter
    // shouldn't second-guess that — leave the URL as-is so the gate
    // produces the right placeholder.
    expect(rewriteEmbedUrl('javascript:alert(1)')).toBe('javascript:alert(1)');
    expect(rewriteEmbedUrl('data:text/html,<script>')).toBe('data:text/html,<script>');
  });
});

describe('isEmbedUrlRewritable', () => {
  test('returns true when the URL would actually change', () => {
    expect(isEmbedUrlRewritable('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(isEmbedUrlRewritable('https://vimeo.com/123456789')).toBe(true);
    expect(
      isEmbedUrlRewritable('https://www.loom.com/share/abcdef0123456789abcdef0123456789'),
    ).toBe(true);
  });

  test('returns false when the URL is already in embed form or not a known host', () => {
    expect(isEmbedUrlRewritable('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe(false);
    expect(isEmbedUrlRewritable('https://player.vimeo.com/video/123456789')).toBe(false);
    expect(
      isEmbedUrlRewritable('https://www.loom.com/embed/abcdef0123456789abcdef0123456789'),
    ).toBe(false);
    expect(isEmbedUrlRewritable('https://example.com/anything')).toBe(false);
  });
});
