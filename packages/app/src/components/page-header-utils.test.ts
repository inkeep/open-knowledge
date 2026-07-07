import { describe, expect, test } from 'bun:test';
import { resolvePageCover, resolvePageIcon } from './page-header-utils';

// ---------------------------------------------------------------------------
// resolvePageIcon
// ---------------------------------------------------------------------------

describe('resolvePageIcon', () => {
  test('classifies a single emoji as emoji', () => {
    expect(resolvePageIcon('📝')).toEqual({ kind: 'emoji', value: '📝' });
  });

  test('classifies a multi-codepoint emoji (skin tone) as emoji', () => {
    expect(resolvePageIcon('👨‍💻').kind).toBe('emoji');
  });

  test('classifies a flag emoji (regional indicator pair) as emoji', () => {
    expect(resolvePageIcon('🇺🇸').kind).toBe('emoji');
  });

  test('rejects emoji with ASCII letters mixed in', () => {
    expect(resolvePageIcon('hi 📝')).toEqual({ kind: 'unsupported', value: '' });
  });

  test('rejects empty / whitespace-only input', () => {
    expect(resolvePageIcon('').kind).toBe('unsupported');
    expect(resolvePageIcon('   ').kind).toBe('unsupported');
  });

  test('rejects non-string input', () => {
    expect(resolvePageIcon(null).kind).toBe('unsupported');
    expect(resolvePageIcon(undefined).kind).toBe('unsupported');
    expect(resolvePageIcon(42).kind).toBe('unsupported');
    expect(resolvePageIcon({}).kind).toBe('unsupported');
  });

  test('rejects inputs over the length cap', () => {
    expect(resolvePageIcon('a'.repeat(3000)).kind).toBe('unsupported');
  });

  test('classifies an https image URL as url', () => {
    expect(resolvePageIcon('https://example.com/logo.png')).toEqual({
      kind: 'url',
      value: 'https://example.com/logo.png',
    });
  });

  test('classifies an http image URL as url (still safe scheme)', () => {
    expect(resolvePageIcon('http://example.com/logo.png').kind).toBe('url');
  });

  test('classifies a relative path with an image extension as path', () => {
    const r = resolvePageIcon('assets/logo.png');
    expect(r.kind).toBe('path');
    expect(r.value).toContain('/api/asset?path=');
    expect(r.value).toContain(encodeURIComponent('assets/logo.png'));
  });

  test('rejects javascript: URL (unsafe scheme)', () => {
    expect(resolvePageIcon('javascript:alert(1).png').kind).toBe('unsupported');
  });

  test('rejects data: URL (not in safe-scheme allowlist)', () => {
    expect(resolvePageIcon('data:image/png;base64,iVBORw0…').kind).toBe('unsupported');
  });

  test('rejects path traversal (leading ../)', () => {
    expect(resolvePageIcon('../secrets/logo.png').kind).toBe('unsupported');
  });

  test('rejects path with embedded /..', () => {
    expect(resolvePageIcon('assets/../secrets/logo.png').kind).toBe('unsupported');
  });

  test('rejects a path with non-image extension', () => {
    expect(resolvePageIcon('docs/note.md').kind).toBe('unsupported');
    expect(resolvePageIcon('archive.zip').kind).toBe('unsupported');
  });

  test('rejects a URL with non-image extension', () => {
    expect(resolvePageIcon('https://example.com/doc.pdf').kind).toBe('unsupported');
  });

  test('strips query / hash from URL extension check (URL branch only)', () => {
    // `image.png?v=2` on the URL branch classifies by `png`, not
    // `png?v=2` — the browser fetches URLs directly and ignores
    // server-side `extname` lookup.
    expect(resolvePageIcon('https://example.com/image.png?v=2').kind).toBe('url');
    expect(resolvePageIcon('https://example.com/image.png#anchor').kind).toBe('url');
  });

  test('rejects query / hash on the path branch (would 415 server-side)', () => {
    // Path-branch values flow into `/api/asset?path=...`. The server
    // runs `extname(path)` against the literal string and would see
    // `.png?v=2`, 415ing on missing mime. We pre-reject so the failure
    // is visible at storage / render time rather than at network.
    expect(resolvePageIcon('assets/image.png?v=2').kind).toBe('unsupported');
    expect(resolvePageIcon('assets/image.png#anchor').kind).toBe('unsupported');
  });

  test('tolerates a single leading slash (upload-pipeline shape)', () => {
    // `/api/upload` returns `/attachments/foo.png` for every successful
    // upload; the widget commits that string verbatim into frontmatter.
    // Resolver must classify as `path` AND strip the leading slash
    // before encoding into `/api/asset?path=...` so the server-side
    // `resolve(contentDir, ...)` doesn't discard `contentDir`.
    const r = resolvePageIcon('/attachments/banner.png');
    expect(r.kind).toBe('path');
    expect(r.value).toContain('/api/asset?path=');
    // No leading slash inside the encoded path query.
    expect(r.value).toContain(encodeURIComponent('attachments/banner.png'));
    expect(r.value).not.toContain(encodeURIComponent('/attachments/banner.png'));
  });

  test('rejects a double leading slash (network-relative URL)', () => {
    // `//evil.com/foo.png` would `<img src>` cross-origin without
    // triggering `isSafeUrl` (no scheme to inspect). Reject.
    expect(resolvePageIcon('//evil.com/logo.png').kind).toBe('unsupported');
  });

  test('rejects a non-Latin word that ASCII-only letter check would let through', () => {
    // `привет` and `γειά` had no `[a-zA-Z]` chars so the
    // emoji classifier accepted them. `\p{L}/u` closes that.
    expect(resolvePageIcon('привет').kind).toBe('unsupported');
    expect(resolvePageIcon('γειά').kind).toBe('unsupported');
    expect(resolvePageIcon('مرحبا').kind).toBe('unsupported');
  });

  test('accepts svg / avif / webp extensions', () => {
    expect(resolvePageIcon('assets/icon.svg').kind).toBe('path');
    expect(resolvePageIcon('assets/icon.avif').kind).toBe('path');
    expect(resolvePageIcon('assets/icon.webp').kind).toBe('path');
  });
});

// ---------------------------------------------------------------------------
// resolvePageCover
// ---------------------------------------------------------------------------

describe('resolvePageCover', () => {
  test('rejects emoji (covers require an image)', () => {
    expect(resolvePageCover('🏔️').kind).toBe('unsupported');
  });

  test('classifies an https image URL as url', () => {
    expect(resolvePageCover('https://example.com/banner.jpg').kind).toBe('url');
  });

  test('classifies a relative path with an image extension as path', () => {
    const r = resolvePageCover('assets/banner.jpg');
    expect(r.kind).toBe('path');
    expect(r.value).toContain('/api/asset?path=');
  });

  test('rejects empty + whitespace-only', () => {
    expect(resolvePageCover('').kind).toBe('unsupported');
    expect(resolvePageCover('   ').kind).toBe('unsupported');
  });

  test('rejects non-string input', () => {
    expect(resolvePageCover(null).kind).toBe('unsupported');
    expect(resolvePageCover(42).kind).toBe('unsupported');
  });

  test('rejects unsafe schemes', () => {
    expect(resolvePageCover('javascript:image.png').kind).toBe('unsupported');
  });

  test('rejects path traversal', () => {
    expect(resolvePageCover('../../../etc/passwd.png').kind).toBe('unsupported');
  });

  test('rejects non-image extension', () => {
    expect(resolvePageCover('archive.zip').kind).toBe('unsupported');
    expect(resolvePageCover('docs/note.md').kind).toBe('unsupported');
  });

  test('rejects query / hash on the path branch (URL branch keeps working)', () => {
    expect(resolvePageCover('assets/banner.jpg?v=2').kind).toBe('unsupported');
    expect(resolvePageCover('https://example.com/banner.jpg#x').kind).toBe('url');
  });

  test('tolerates a single leading slash (upload-pipeline shape)', () => {
    const r = resolvePageCover('/attachments/banner.png');
    expect(r.kind).toBe('path');
    expect(r.value).toContain(encodeURIComponent('attachments/banner.png'));
    expect(r.value).not.toContain(encodeURIComponent('/attachments/banner.png'));
  });

  test('rejects a double leading slash (network-relative URL)', () => {
    expect(resolvePageCover('//evil.com/banner.png').kind).toBe('unsupported');
  });
});
