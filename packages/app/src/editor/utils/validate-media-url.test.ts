import { describe, expect, test } from 'bun:test';
import {
  mediaKindForAccept,
  mediaUrlPlaceholder,
  mediaUrlValidationMessage,
  validateMediaUrl,
} from './validate-media-url';

describe('validateMediaUrl — empty and whitespace', () => {
  test('empty string is valid (prop unset)', () => {
    expect(validateMediaUrl('', 'video')).toEqual({ valid: true });
  });

  test('whitespace-only input is valid (treated as unset)', () => {
    expect(validateMediaUrl('   ', 'video')).toEqual({ valid: true });
    expect(validateMediaUrl('\t\n', 'video')).toEqual({ valid: true });
  });
});

describe('validateMediaUrl — direct video URLs', () => {
  test('accepts every canonical video extension (incl. mkv)', () => {
    for (const ext of ['mp4', 'webm', 'mov', 'm4v', 'mkv']) {
      expect(validateMediaUrl(`https://example.com/clip.${ext}`, 'video')).toEqual({
        valid: true,
      });
    }
  });

  test('accepts uppercase extensions', () => {
    expect(validateMediaUrl('https://example.com/clip.MP4', 'video')).toEqual({ valid: true });
    expect(validateMediaUrl('https://example.com/clip.WebM', 'video')).toEqual({ valid: true });
  });

  test('accepts URLs with query strings', () => {
    expect(validateMediaUrl('https://cdn.example.com/clip.mp4?token=abc&t=42', 'video')).toEqual({
      valid: true,
    });
  });

  test('accepts URLs with fragments', () => {
    expect(validateMediaUrl('https://example.com/clip.mp4#t=10', 'video')).toEqual({
      valid: true,
    });
  });

  test('accepts URLs with path segments', () => {
    expect(validateMediaUrl('https://example.com/path/to/deep/file.webm', 'video')).toEqual({
      valid: true,
    });
  });

  test('accepts file:// URLs with valid extension (desktop asset path)', () => {
    expect(validateMediaUrl('file:///Users/me/movie.mp4', 'video')).toEqual({ valid: true });
  });

  test('accepts relative paths with valid extension', () => {
    expect(validateMediaUrl('/assets/clip.mp4', 'video')).toEqual({ valid: true });
    expect(validateMediaUrl('./clip.mp4', 'video')).toEqual({ valid: true });
    expect(validateMediaUrl('../media/clip.webm', 'video')).toEqual({ valid: true });
  });
});

describe('validateMediaUrl — extensionless CDN URLs (no false positive)', () => {
  test('accepts absolute extensionless URLs from non-embed-provider hosts (signed CDN, Content-Type-driven)', () => {
    expect(validateMediaUrl('https://cdn.example.com/media/abc123', 'video')).toEqual({
      valid: true,
    });
    expect(
      validateMediaUrl('https://firebasestorage.googleapis.com/v0/b/x/o/uuid', 'image'),
    ).toEqual({ valid: true });
    expect(validateMediaUrl('https://example.com/', 'audio')).toEqual({ valid: true });
  });

  test('rejects relative extensionless paths (no Content-Type fallback)', () => {
    expect(validateMediaUrl('/assets/no-extension', 'video')).toEqual({
      valid: false,
      reason: 'wrong-extension',
      extension: '',
    });
  });
});

describe('validateMediaUrl — YouTube accepted for video kind (Video dispatches to iframe)', () => {
  // Video.tsx's `parseYouTubeUrl` helper routes recognized YouTube URLs
  // to a `<LiteYouTubeEmbed>` facade (thumbnail-then-iframe), so
  // accepting them here matches what the renderer will actually do. The
  // validator stays permissive at the host level — Video.tsx's fallback
  // to `<video>` covers malformed IDs.

  test('accepts youtube.com/watch URLs', () => {
    expect(
      validateMediaUrl('https://www.youtube.com/watch?v=rekaSOwGMu0&pp=ugUHEgVlbi1H', 'video'),
    ).toEqual({ valid: true });
  });

  test('accepts youtube.com without www', () => {
    expect(validateMediaUrl('https://youtube.com/watch?v=dQw4w9WgXcQ', 'video')).toEqual({
      valid: true,
    });
  });

  test('accepts youtu.be short links', () => {
    expect(validateMediaUrl('https://youtu.be/rekaSOwGMu0', 'video')).toEqual({ valid: true });
  });

  test('accepts youtube-nocookie.com URLs', () => {
    expect(validateMediaUrl('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'video')).toEqual(
      { valid: true },
    );
  });

  test('accepts youtube subdomains (m., music.)', () => {
    expect(validateMediaUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'video')).toEqual({
      valid: true,
    });
    expect(validateMediaUrl('https://music.youtube.com/watch?v=dQw4w9WgXcQ', 'video')).toEqual({
      valid: true,
    });
  });

  test('accepts /embed and /shorts paths', () => {
    expect(validateMediaUrl('https://www.youtube.com/embed/rekaSOwGMu0', 'video')).toEqual({
      valid: true,
    });
    expect(validateMediaUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ', 'video')).toEqual({
      valid: true,
    });
  });

  test('rejects unsupported YouTube subdomains the renderer cannot dispatch', () => {
    // The validator's YouTube check delegates to `parseYouTubeUrl` so it
    // agrees with the renderer's allowlist exactly. Subdomains the
    // parser doesn't enumerate (`kids.`, `studio.`, etc.) fall through
    // to the broad `endsWith('.youtube.com')` embed-provider detection
    // and get the "Unrecognized YouTube URL" rejection — a clear error
    // at PropPanel time instead of a silent broken-render later.
    expect(validateMediaUrl('https://kids.youtube.com/watch?v=dQw4w9WgXcQ', 'video')).toEqual({
      valid: false,
      reason: 'embed-provider',
      provider: 'youtube',
    });
    expect(validateMediaUrl('https://studio.youtube.com/watch?v=dQw4w9WgXcQ', 'video')).toEqual({
      valid: false,
      reason: 'embed-provider',
      provider: 'youtube',
    });
  });

  test('rejects malformed YouTube IDs at the validator (matches renderer behavior)', () => {
    // The renderer's `parseYouTubeUrl` rejects IDs that don't match
    // the 11-char `[A-Za-z0-9_-]` grammar; the validator inherits that
    // strictness so a paste-time typo surfaces immediately instead of
    // becoming a broken-iframe surprise.
    expect(validateMediaUrl('https://youtu.be/short', 'video')).toEqual({
      valid: false,
      reason: 'embed-provider',
      provider: 'youtube',
    });
  });
});

describe('validateMediaUrl — Vimeo accepted for video kind (Video dispatches to iframe)', () => {
  // Video.tsx's `isVimeoUrl` helper routes recognized Vimeo URLs to
  // `@u-wave/react-vimeo` (eager iframe), so the validator returns valid.

  test('accepts canonical vimeo.com URLs', () => {
    expect(validateMediaUrl('https://vimeo.com/76979871', 'video')).toEqual({ valid: true });
    expect(validateMediaUrl('https://www.vimeo.com/76979871', 'video')).toEqual({ valid: true });
  });

  test('accepts player.vimeo.com embed URLs', () => {
    expect(validateMediaUrl('https://player.vimeo.com/video/76979871', 'video')).toEqual({
      valid: true,
    });
  });

  test('accepts unlisted-hash + channels / groups / showcase paths', () => {
    expect(validateMediaUrl('https://vimeo.com/76979871/abc123def4', 'video')).toEqual({
      valid: true,
    });
    expect(validateMediaUrl('https://vimeo.com/channels/staffpicks/76979871', 'video')).toEqual({
      valid: true,
    });
    expect(validateMediaUrl('https://vimeo.com/groups/motion/videos/76979871', 'video')).toEqual({
      valid: true,
    });
  });
});

describe('validateMediaUrl — Loom accepted for video kind (Video dispatches to iframe)', () => {
  // Video.tsx's `isLoomUrl` helper routes recognized Loom URLs to the
  // direct-iframe LoomEmbed branch, so the validator returns valid.
  // Image + Audio still reject Loom (no embed dispatch for those kinds).

  test('accepts canonical share URLs', () => {
    expect(validateMediaUrl('https://www.loom.com/share/abc123def456ghi789jk', 'video')).toEqual({
      valid: true,
    });
    expect(validateMediaUrl('https://loom.com/share/abc123def456ghi789jk', 'video')).toEqual({
      valid: true,
    });
  });

  test('accepts already-embed URLs', () => {
    expect(validateMediaUrl('https://www.loom.com/embed/abc123def456ghi789jk', 'video')).toEqual({
      valid: true,
    });
  });

  test('accepts URLs with `?t=` timestamp + unrelated query params', () => {
    expect(
      validateMediaUrl('https://www.loom.com/share/abc123def456ghi789jk?t=42&sid=session', 'video'),
    ).toEqual({ valid: true });
  });

  test('rejects malformed Loom IDs (too short — under 20 chars)', () => {
    // The validator's Loom check delegates to `isLoomUrl` → `parseLoomUrl`
    // → `LOOM_ID_RE` ([A-Za-z0-9]{20,}). Anything shorter falls through to
    // the embed-provider rejection path so paste-time typos surface with
    // a clear error instead of becoming a broken-iframe surprise.
    expect(validateMediaUrl('https://www.loom.com/share/abc', 'video')).toEqual({
      valid: false,
      reason: 'embed-provider',
      provider: 'loom',
    });
    expect(validateMediaUrl('https://loom.com/share/short', 'video')).toEqual({
      valid: false,
      reason: 'embed-provider',
      provider: 'loom',
    });
  });
});

describe('validateMediaUrl — embed-provider rejection (image / audio kinds for every provider)', () => {
  // Video flips to acceptance for YouTube + Vimeo + Loom — image / audio
  // renderers don't dispatch any embed host, so embed URLs stay rejected
  // for those kinds.

  test('YouTube rejected for image and audio kinds', () => {
    expect(validateMediaUrl('https://youtu.be/dQw4w9WgXcQ', 'image')).toEqual({
      valid: false,
      reason: 'embed-provider',
      provider: 'youtube',
    });
    expect(validateMediaUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'audio')).toEqual({
      valid: false,
      reason: 'embed-provider',
      provider: 'youtube',
    });
  });

  test('Vimeo / Loom rejected for image and audio kinds', () => {
    expect(validateMediaUrl('https://vimeo.com/123', 'audio')).toEqual({
      valid: false,
      reason: 'embed-provider',
      provider: 'vimeo',
    });
    expect(validateMediaUrl('https://loom.com/share/abc123def456ghi789jk', 'image')).toEqual({
      valid: false,
      reason: 'embed-provider',
      provider: 'loom',
    });
  });
});

describe('validateMediaUrl — wrong extension', () => {
  test('rejects URLs with disallowed extensions', () => {
    expect(validateMediaUrl('https://example.com/page.html', 'video')).toEqual({
      valid: false,
      reason: 'wrong-extension',
      extension: 'html',
    });
    expect(validateMediaUrl('https://example.com/file.pdf', 'video')).toEqual({
      valid: false,
      reason: 'wrong-extension',
      extension: 'pdf',
    });
    expect(validateMediaUrl('https://example.com/file.exe', 'video')).toEqual({
      valid: false,
      reason: 'wrong-extension',
      extension: 'exe',
    });
  });

  test('rejects video URL when validating as image kind (kind mismatch)', () => {
    expect(validateMediaUrl('https://example.com/clip.mp4', 'image')).toEqual({
      valid: false,
      reason: 'wrong-extension',
      extension: 'mp4',
    });
  });

  test('rejects image URL when validating as video kind (kind mismatch)', () => {
    expect(validateMediaUrl('https://example.com/photo.png', 'video')).toEqual({
      valid: false,
      reason: 'wrong-extension',
      extension: 'png',
    });
  });

  test('rejects data: URIs (render-layer sanitizer strips data: scheme to #)', () => {
    expect(validateMediaUrl('data:video/mp4;base64,AAAA', 'video')).toEqual({
      valid: false,
      reason: 'data-uri',
    });
    expect(validateMediaUrl('data:image/png;base64,iVBORw0KGgo=', 'image')).toEqual({
      valid: false,
      reason: 'data-uri',
    });
    expect(validateMediaUrl('data:image/svg+xml,%3Csvg%3E%3C/svg%3E', 'image')).toEqual({
      valid: false,
      reason: 'data-uri',
    });
  });
});

describe('validateMediaUrl — malformed input', () => {
  test('rejects garbage strings with spaces (URL-shape-failure or extension-failure both count)', () => {
    const result = validateMediaUrl('not a url with spaces', 'video');
    expect(result.valid).toBe(false);
  });

  test('rejects strings with unencoded invalid URL chars as invalid-url', () => {
    expect(validateMediaUrl('http://exa<mple>.com/v.mp4', 'video')).toEqual({
      valid: false,
      reason: 'invalid-url',
    });
  });
});

describe('validateMediaUrl — audio + image kinds (canonical extension sets)', () => {
  test('audio kind accepts every canonical audio extension (incl. flac, aac, opus)', () => {
    for (const ext of ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus']) {
      expect(validateMediaUrl(`https://example.com/track.${ext}`, 'audio')).toEqual({
        valid: true,
      });
    }
  });

  test('image kind accepts every canonical image extension', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg']) {
      expect(validateMediaUrl(`https://example.com/img.${ext}`, 'image')).toEqual({
        valid: true,
      });
    }
  });
});

describe('mediaKindForAccept', () => {
  test('returns "video" for video/* accept arrays', () => {
    expect(mediaKindForAccept(['video/mp4', 'video/webm', 'video/ogg'])).toBe('video');
  });

  test('returns "audio" for audio/* accept arrays', () => {
    expect(mediaKindForAccept(['audio/mpeg', 'audio/wav'])).toBe('audio');
  });

  test('returns "image" for image/* accept arrays', () => {
    expect(mediaKindForAccept(['image/png', 'image/jpeg'])).toBe('image');
  });

  test('returns undefined for empty accept array', () => {
    expect(mediaKindForAccept([])).toBeUndefined();
  });

  test('returns undefined for non-media MIME prefixes (pdf, */*)', () => {
    expect(mediaKindForAccept(['application/pdf'])).toBeUndefined();
    expect(mediaKindForAccept(['*/*'])).toBeUndefined();
    expect(mediaKindForAccept(['text/plain'])).toBeUndefined();
  });
});

describe('mediaUrlPlaceholder', () => {
  test('names the kind and every accepted extension', () => {
    const p = mediaUrlPlaceholder('video');
    expect(p).toContain('video');
    expect(p).toContain('.mp4');
    expect(p).toContain('.mkv');
  });

  test('audio + image placeholders name their canonical sets', () => {
    expect(mediaUrlPlaceholder('audio')).toContain('.flac');
    expect(mediaUrlPlaceholder('image')).toContain('.webp');
  });
});

describe('mediaUrlValidationMessage', () => {
  test('valid result yields empty string', () => {
    expect(mediaUrlValidationMessage({ valid: true }, 'video')).toBe('');
  });

  test('invalid-url message', () => {
    expect(mediaUrlValidationMessage({ valid: false, reason: 'invalid-url' }, 'video')).toBe(
      'Not a valid URL.',
    );
  });

  test('data-uri message points the user at a hosted file URL', () => {
    const msg = mediaUrlValidationMessage({ valid: false, reason: 'data-uri' }, 'image');
    expect(msg).toBe('Data URIs are not supported for media fields. Use a hosted file URL.');
  });

  test('embed-provider message generator still produces video-specific output (defensive coverage)', () => {
    // YouTube + Vimeo + Loom + video kind all dispatch via their
    // helpers, so the embed-provider rejection path on video kind only
    // fires now when a provider HOST is matched but the URL grammar
    // fails (malformed share / embed link). The message generator
    // produces an "Unrecognized X URL" message in that case — pinned
    // here so a future regression that resurrects the old "not yet
    // supported" wording breaks loudly.
    const vimeoMsg = mediaUrlValidationMessage(
      { valid: false, reason: 'embed-provider', provider: 'vimeo' },
      'video',
    );
    expect(vimeoMsg).toContain('Vimeo');
    expect(vimeoMsg).toContain('Unrecognized');
    expect(vimeoMsg).not.toContain('PRD-');
    // Old "not yet supported" wording was stale — Vimeo IS dispatched.
    // The new message reflects that the provider is supported but the
    // URL shape didn't pass the parser.
    expect(vimeoMsg).not.toContain('not yet supported');

    const loomMsg = mediaUrlValidationMessage(
      { valid: false, reason: 'embed-provider', provider: 'loom' },
      'video',
    );
    expect(loomMsg).toContain('Loom');
    expect(loomMsg).toContain('Unrecognized');
    expect(loomMsg).not.toContain('not yet supported');
  });

  test('embed-provider message is generic (not "embeds coming soon") for image/audio', () => {
    const imgMsg = mediaUrlValidationMessage(
      { valid: false, reason: 'embed-provider', provider: 'youtube' },
      'image',
    );
    expect(imgMsg).toContain('YouTube');
    expect(imgMsg).toContain('not direct image files');
    expect(imgMsg).not.toContain('embeds');

    // Audio-kind interpolation is pinned directly (not just via PropPanel).
    const audioMsg = mediaUrlValidationMessage(
      { valid: false, reason: 'embed-provider', provider: 'loom' },
      'audio',
    );
    expect(audioMsg).toContain('Loom');
    expect(audioMsg).toContain('not direct audio files');
    expect(audioMsg).not.toContain('embeds');
  });

  test('wrong-extension with empty extension → missing-extension message', () => {
    expect(
      mediaUrlValidationMessage(
        { valid: false, reason: 'wrong-extension', extension: '' },
        'video',
      ),
    ).toBe('Missing file extension. Accepts: .mp4, .webm, .mov, .m4v, .mkv.');
  });

  test('wrong-extension with a concrete extension → unsupported-extension message', () => {
    expect(
      mediaUrlValidationMessage(
        { valid: false, reason: 'wrong-extension', extension: 'html' },
        'image',
      ),
    ).toContain('Unsupported extension .html');
  });

  test('no user-facing message contains an internal ticket ID', () => {
    const cases: Parameters<typeof mediaUrlValidationMessage>[0][] = [
      { valid: false, reason: 'invalid-url' },
      { valid: false, reason: 'embed-provider', provider: 'youtube' },
      { valid: false, reason: 'embed-provider', provider: 'vimeo' },
      { valid: false, reason: 'embed-provider', provider: 'loom' },
      { valid: false, reason: 'data-uri' },
      { valid: false, reason: 'wrong-extension', extension: '' },
      { valid: false, reason: 'wrong-extension', extension: 'html' },
    ];
    for (const kind of ['video', 'audio', 'image'] as const) {
      for (const c of cases) {
        expect(mediaUrlValidationMessage(c, kind)).not.toMatch(/PRD-\d+/);
      }
    }
  });
});
