import { describe, expect, test } from 'bun:test';
import { parseYouTubeUrl, youtubeEmbedUrl } from './youtube-embed.ts';

describe('youtubeEmbedUrl', () => {
  // ── Recognized hosts → canonical /embed/<id> output ───────────────────

  test.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ'],
    ['https://youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ'],
    // YouTube Music — same video-id system as the canonical host.
    ['https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ'],
    // Old player URL — `/v/<id>`. Still encountered in older docs.
    ['https://www.youtube.com/v/dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ'],
    // Already-embed URLs pass through (canonicalized to www).
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ'],
    // Privacy host preserved.
    [
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ],
  ])('converts %s → %s', (input, expected) => {
    expect(youtubeEmbedUrl(input)).toBe(expected);
  });

  // ── Timestamp preservation ────────────────────────────────────────────

  test('preserves ?t=<seconds> as ?start=<seconds>', () => {
    expect(youtubeEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ?start=42',
    );
  });

  test('preserves ?t=<n>s suffix form', () => {
    expect(youtubeEmbedUrl('https://youtu.be/dQw4w9WgXcQ?t=90s')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ?start=90',
    );
  });

  test('parses h/m/s composite timestamp (2m30s = 150)', () => {
    expect(youtubeEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=2m30s')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ?start=150',
    );
  });

  test('parses h-only composite (1h = 3600)', () => {
    expect(youtubeEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ?start=3600',
    );
  });

  test('parses full h/m/s composite (2h3m4s = 7384)', () => {
    expect(youtubeEmbedUrl('https://youtu.be/dQw4w9WgXcQ?t=2h3m4s')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ?start=7384',
    );
  });

  test('accepts ?start= directly (already in embed-form param)', () => {
    expect(youtubeEmbedUrl('https://www.youtube.com/embed/dQw4w9WgXcQ?start=99')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ?start=99',
    );
  });

  test('strips every query param beyond timestamp (intentional reconstruction)', () => {
    // The output is built by reconstructing the embed URL from validated
    // parts (host allowlist + 11-char ID regex + parsed timestamp) — NOT
    // by forwarding the input query string. This pins that contract: a
    // future refactor that forwarded the full query (minus `v=`) would
    // silently change iframe behavior (playlist UI from `&list=`, ads
    // from `&feature=`, share-token tracking from `&si=`) without any
    // test breaking. If a new opt-in passthrough lands, replace this
    // test with the new allowed surface.
    expect(
      youtubeEmbedUrl(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42&list=PL123&feature=share&si=abc',
      ),
    ).toBe('https://www.youtube.com/embed/dQw4w9WgXcQ?start=42');
  });

  test('drops zero-second timestamps from both plain and composite forms', () => {
    // Both branches floor at `> 0`, so `?t=0` and `?t=0s` produce the
    // same clean embed URL (no `?start=` param). YouTube ignores
    // `?start=0` so emitting it would just bloat the URL.
    expect(youtubeEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=0')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    );
    expect(youtubeEmbedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=0s')).toBe(
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
    );
  });

  // ── Rejected inputs → null ────────────────────────────────────────────

  test('returns null for non-YouTube hosts', () => {
    expect(youtubeEmbedUrl('https://vimeo.com/123456789')).toBeNull();
    expect(youtubeEmbedUrl('https://example.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    // Subdomain spoofing — `evil.youtube.com.attacker.example` doesn't
    // match the host allowlist.
    expect(youtubeEmbedUrl('https://youtube.com.attacker.example/watch?v=dQw4w9WgXcQ')).toBeNull();
    // Unknown YouTube subdomains still fail closed — the allowlist is
    // exact-match (m. / music. / www. are enumerated), not a blanket
    // `*.youtube.com` rule.
    expect(youtubeEmbedUrl('https://kids.youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(youtubeEmbedUrl('https://studio.youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
  });

  test('returns null for non-http(s) schemes', () => {
    expect(youtubeEmbedUrl('javascript:alert(1)')).toBeNull();
    expect(youtubeEmbedUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(youtubeEmbedUrl('ftp://youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
  });

  test('returns null for missing or malformed video id', () => {
    // Watch URL with no `v=` query.
    expect(youtubeEmbedUrl('https://www.youtube.com/watch')).toBeNull();
    // ID shorter than 11 chars.
    expect(youtubeEmbedUrl('https://youtu.be/short')).toBeNull();
    // ID with disallowed character (`.`).
    expect(youtubeEmbedUrl('https://www.youtube.com/watch?v=abc.def.ghi')).toBeNull();
    // Embed path with no id segment.
    expect(youtubeEmbedUrl('https://www.youtube.com/embed/')).toBeNull();
  });

  test('returns null for non-string / empty src', () => {
    expect(youtubeEmbedUrl('')).toBeNull();
    // biome-ignore lint/suspicious/noExplicitAny: testing the runtime guard
    expect(youtubeEmbedUrl(null as any)).toBeNull();
    // biome-ignore lint/suspicious/noExplicitAny: testing the runtime guard
    expect(youtubeEmbedUrl(undefined as any)).toBeNull();
  });

  test('returns null for non-parseable URLs', () => {
    expect(youtubeEmbedUrl('not a url')).toBeNull();
    expect(youtubeEmbedUrl('youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull(); // no scheme
  });
});

describe('parseYouTubeUrl', () => {
  // Structured-parse companion. The host-allowlist, scheme-guard, and
  // ID-grammar checks are pinned by the `youtubeEmbedUrl` suite above
  // (both functions share the same internals); this block only pins the
  // fields that the helper exposes — `id`, `startSeconds`, `noCookie` —
  // so callers wiring into a facade like `react-lite-youtube-embed` can
  // rely on the shape.

  test('extracts id from /watch URLs', () => {
    expect(parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({
      id: 'dQw4w9WgXcQ',
      startSeconds: null,
      noCookie: false,
    });
  });

  test('extracts id from youtu.be short links', () => {
    expect(parseYouTubeUrl('https://youtu.be/dQw4w9WgXcQ')).toEqual({
      id: 'dQw4w9WgXcQ',
      startSeconds: null,
      noCookie: false,
    });
  });

  test('flags noCookie when input host is youtube-nocookie.com', () => {
    expect(parseYouTubeUrl('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).toEqual({
      id: 'dQw4w9WgXcQ',
      startSeconds: null,
      noCookie: true,
    });
  });

  test('resolves ?t=<seconds>, ?t=<n>s, and h/m/s composite timestamps', () => {
    expect(parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42')?.startSeconds).toBe(
      42,
    );
    expect(parseYouTubeUrl('https://youtu.be/dQw4w9WgXcQ?t=90s')?.startSeconds).toBe(90);
    expect(
      parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=2m30s')?.startSeconds,
    ).toBe(150);
    expect(parseYouTubeUrl('https://youtu.be/dQw4w9WgXcQ?t=2h3m4s')?.startSeconds).toBe(7384);
  });

  test('accepts the /v/<id> old player URL shape', () => {
    expect(parseYouTubeUrl('https://www.youtube.com/v/dQw4w9WgXcQ')).toEqual({
      id: 'dQw4w9WgXcQ',
      startSeconds: null,
      noCookie: false,
    });
  });

  test('returns null for non-YouTube hosts (host-allowlist enforced)', () => {
    expect(parseYouTubeUrl('https://vimeo.com/123456789')).toBeNull();
    expect(parseYouTubeUrl('https://youtube.com.attacker.example/watch?v=dQw4w9WgXcQ')).toBeNull();
  });

  test('returns null for malformed video IDs', () => {
    expect(parseYouTubeUrl('https://youtu.be/short')).toBeNull();
    expect(parseYouTubeUrl('https://www.youtube.com/watch?v=abc.def.ghi')).toBeNull();
  });
});
