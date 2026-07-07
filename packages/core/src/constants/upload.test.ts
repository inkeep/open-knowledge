import { describe, expect, test } from 'bun:test';
import {
  ASSET_EXTENSIONS,
  AUDIO_EXTENSIONS,
  FILE_ATTACHMENT_EXTENSIONS,
  IMAGE_EXTENSIONS,
  INLINE_RENDERABLE_EXTENSIONS,
  LINKABLE_ASSET_EXTENSIONS,
  mediaKindForSidebarAssetExtension,
  TEXT_VIEWER_FALLBACK_EXTENSIONS,
  VIDEO_EXTENSIONS,
  WIKI_EMBED_EXTENSIONS,
} from './upload.ts';

describe('upload extension sets', () => {
  test('VIDEO_EXTENSIONS contains expected browser-renderable containers', () => {
    expect(VIDEO_EXTENSIONS.has('mp4')).toBe(true);
    expect(VIDEO_EXTENSIONS.has('webm')).toBe(true);
    expect(VIDEO_EXTENSIONS.has('mov')).toBe(true);
    expect(VIDEO_EXTENSIONS.has('m4v')).toBe(true);
    expect(VIDEO_EXTENSIONS.has('mkv')).toBe(true);
  });

  test('AUDIO_EXTENSIONS contains expected browser-renderable codecs', () => {
    expect(AUDIO_EXTENSIONS.has('mp3')).toBe(true);
    expect(AUDIO_EXTENSIONS.has('wav')).toBe(true);
    expect(AUDIO_EXTENSIONS.has('ogg')).toBe(true);
    expect(AUDIO_EXTENSIONS.has('m4a')).toBe(true);
    expect(AUDIO_EXTENSIONS.has('flac')).toBe(true);
    expect(AUDIO_EXTENSIONS.has('aac')).toBe(true);
    expect(AUDIO_EXTENSIONS.has('opus')).toBe(true);
  });

  test('VIDEO_EXTENSIONS and AUDIO_EXTENSIONS are disjoint from IMAGE_EXTENSIONS', () => {
    for (const ext of VIDEO_EXTENSIONS) {
      expect(IMAGE_EXTENSIONS.has(ext)).toBe(false);
    }
    for (const ext of AUDIO_EXTENSIONS) {
      expect(IMAGE_EXTENSIONS.has(ext)).toBe(false);
    }
  });

  test('VIDEO_EXTENSIONS and AUDIO_EXTENSIONS are disjoint from each other', () => {
    for (const ext of VIDEO_EXTENSIONS) {
      expect(AUDIO_EXTENSIONS.has(ext)).toBe(false);
    }
  });

  // Partition guard — defense against drift between dispatch surfaces
  // (pickInsertShape, handlers.wikiLinkEmbed). If a new extension lands in
  // WIKI_EMBED_EXTENSIONS without a matching home in IMAGE / VIDEO / AUDIO
  // / FILE_ATTACHMENT, this fails loudly so the dispatch tables stay in
  // sync.
  //
  // FILE_ATTACHMENT_EXTENSIONS — the
  // `WikiEmbedFile` compat dispatches block-context wiki-embeds whose
  // extension lives in that set to the `File` canonical (Notion-style
  // inline-row chrome). The dispatch ladder
  // (`markdown/index.ts:wikiLinkEmbed`) is now image → video → audio
  // → file → text+link fallback. PDF lives inside FILE_ATTACHMENT
  // (the wikilink form renders as a File row alongside docx / zip /
  // …); the pdfjs canvas viewer is reachable via the `<Pdf>` JSX form
  // rather than auto-routed from `![[doc.pdf]]`.
  test('IMAGE ∪ VIDEO ∪ AUDIO ∪ FILE_ATTACHMENT === WIKI_EMBED_EXTENSIONS (set equality)', () => {
    const union = new Set<string>([
      ...IMAGE_EXTENSIONS,
      ...VIDEO_EXTENSIONS,
      ...AUDIO_EXTENSIONS,
      ...FILE_ATTACHMENT_EXTENSIONS,
    ]);

    // ⊆ direction: union subset of WIKI_EMBED_EXTENSIONS
    for (const ext of union) {
      expect(WIKI_EMBED_EXTENSIONS.has(ext)).toBe(true);
    }

    // ⊇ direction: WIKI_EMBED_EXTENSIONS subset of union
    for (const ext of WIKI_EMBED_EXTENSIONS) {
      expect(union.has(ext)).toBe(true);
    }

    // Same cardinality (defense against duplicates inside individual sets)
    expect(union.size).toBe(WIKI_EMBED_EXTENSIONS.size);
  });

  // FILE_ATTACHMENT_EXTENSIONS must be disjoint from the inline-media
  // sets (image / video / audio) — the dispatch ladder stops at the
  // first matching branch, so an overlapping ext would render through
  // whichever tier ran first, which is a class of confusion this test
  // prevents. PDF is INTENTIONALLY a member of FILE_ATTACHMENT (the
  // wikilink/drop form treats it like any other downloadable file); the
  // explicit `<Pdf>` JSX is a separate authoring path with its own
  // canonical and is unaffected.
  test('FILE_ATTACHMENT_EXTENSIONS is disjoint from IMAGE / VIDEO / AUDIO', () => {
    for (const ext of FILE_ATTACHMENT_EXTENSIONS) {
      expect(IMAGE_EXTENSIONS.has(ext)).toBe(false);
      expect(VIDEO_EXTENSIONS.has(ext)).toBe(false);
      expect(AUDIO_EXTENSIONS.has(ext)).toBe(false);
    }
  });

  // Every type OK lets you embed/link (`![[file.ext]]`) MUST be one OK admits
  // into the file index and serves — otherwise the link resolves against a set
  // that omits it and renders as a "non-existent" redlink while /api/asset 404s.
  // ASSET_EXTENSIONS is the serve/index/link-resolution predicate;
  // WIKI_EMBED_EXTENSIONS is the embed/link predicate. The latter must be a
  // subset of the former.
  test('WIKI_EMBED_EXTENSIONS ⊆ ASSET_EXTENSIONS (embeddable ⇒ servable + resolvable)', () => {
    for (const ext of WIKI_EMBED_EXTENSIONS) {
      expect(ASSET_EXTENSIONS.has(ext)).toBe(true);
    }
  });

  // User-authored files linked by their own bare extension (not droppable
  // embeds, so absent from WIKI_EMBED) still must resolve + serve.
  test('ASSET_EXTENSIONS admits user-linked non-embed types (html/htm/gpx)', () => {
    expect(ASSET_EXTENSIONS.has('html')).toBe(true);
    expect(ASSET_EXTENSIONS.has('htm')).toBe(true);
    expect(ASSET_EXTENSIONS.has('gpx')).toBe(true);
  });
});

describe('mediaKindForSidebarAssetExtension', () => {
  // Pins the central dispatch function called by `DocumentContext` when
  // building sidebar asset rows. The classifier returns the discriminant
  // that `AssetPreview` switches on to pick a render component.

  test.each([
    ['png', 'image'],
    ['jpg', 'image'],
    ['jpeg', 'image'],
    ['gif', 'image'],
    ['webp', 'image'],
    ['avif', 'image'],
    ['mp4', 'video'],
    ['webm', 'video'],
    ['mov', 'video'],
    ['m4v', 'video'],
    ['mp3', 'audio'],
    ['wav', 'audio'],
    ['ogg', 'audio'],
    ['m4a', 'audio'],
    ['flac', 'audio'],
    ['aac', 'audio'],
    ['opus', 'audio'],
    ['pdf', 'pdf'],
  ] as const)('classifies %s → %s', (ext, expected) => {
    expect(mediaKindForSidebarAssetExtension(ext)).toBe(expected);
  });

  test.each([
    ['json', 'text'],
    ['toml', 'text'],
    ['lock', 'text'],
  ] as const)('classifies %s → %s (text-data formats)', (ext, expected) => {
    expect(mediaKindForSidebarAssetExtension(ext)).toBe(expected);
  });

  test.each([
    ['base', 'text'],
    ['canvas', 'text'],
  ] as const)('classifies %s → %s (text-viewer fallback set)', (ext, expected) => {
    expect(mediaKindForSidebarAssetExtension(ext)).toBe(expected);
  });

  test('base and canvas are absent from ASSET_EXTENSIONS and INLINE_RENDERABLE_EXTENSIONS', () => {
    // These extensions resolve to mediaKind:'text' via TEXT_VIEWER_FALLBACK_EXTENSIONS
    // rather than the inline-text set, so the serve/XSS boundary (ASSET_EXTENSIONS +
    // INLINE_RENDERABLE_EXTENSIONS) is unchanged — /api/asset keeps returning 415 for them.
    expect(ASSET_EXTENSIONS.has('base')).toBe(false);
    expect(ASSET_EXTENSIONS.has('canvas')).toBe(false);
    expect(INLINE_RENDERABLE_EXTENSIONS.has('base')).toBe(false);
    expect(INLINE_RENDERABLE_EXTENSIONS.has('canvas')).toBe(false);
  });

  test('TEXT_VIEWER_FALLBACK_EXTENSIONS contains exactly base and canvas', () => {
    expect(TEXT_VIEWER_FALLBACK_EXTENSIONS.has('base')).toBe(true);
    expect(TEXT_VIEWER_FALLBACK_EXTENSIONS.has('canvas')).toBe(true);
    // Size pin guards accidental widening of the text-viewer-only path, which
    // bypasses the XSS/serve boundary that ASSET_EXTENSIONS enforces.
    expect(TEXT_VIEWER_FALLBACK_EXTENSIONS.size).toBe(2);
  });

  describe('LINKABLE_ASSET_EXTENSIONS', () => {
    test('is a strict superset of ASSET_EXTENSIONS', () => {
      for (const ext of ASSET_EXTENSIONS) {
        expect(LINKABLE_ASSET_EXTENSIONS.has(ext)).toBe(true);
      }
      expect(LINKABLE_ASSET_EXTENSIONS.size).toBeGreaterThan(ASSET_EXTENSIONS.size);
    });

    test('contains base and canvas (text-viewer-fallback members)', () => {
      expect(LINKABLE_ASSET_EXTENSIONS.has('base')).toBe(true);
      expect(LINKABLE_ASSET_EXTENSIONS.has('canvas')).toBe(true);
    });

    test('size equals ASSET_EXTENSIONS + TEXT_VIEWER_FALLBACK_EXTENSIONS', () => {
      expect(LINKABLE_ASSET_EXTENSIONS.size).toBe(
        ASSET_EXTENSIONS.size + TEXT_VIEWER_FALLBACK_EXTENSIONS.size,
      );
    });
  });

  test('lock files dispatch to TextViewer regardless of stem prefix', () => {
    // `lock` is the file extension — covers `bun.lock`, `Cargo.lock`,
    // `Gemfile.lock`, OK's own `.ok/local/server.lock`, etc. The
    // dispatch keys off the extension only; the stem prefix is
    // irrelevant.
    expect(mediaKindForSidebarAssetExtension('lock')).toBe('text');
    expect(mediaKindForSidebarAssetExtension('.lock')).toBe('text');
    expect(mediaKindForSidebarAssetExtension('LOCK')).toBe('text');
  });

  test.each([
    'csv',
    'docx',
    'zip',
    'mkv', // in INLINE_RENDERABLE_EXTENSIONS but excluded from sidebar video set
    'svg', // intentionally excluded from sidebar image set (XSS posture)
    'tiff',
  ])('returns null for non-sidebar-renderable extension %s', (ext) => {
    expect(mediaKindForSidebarAssetExtension(ext)).toBeNull();
  });

  test('normalizes leading dot + case', () => {
    expect(mediaKindForSidebarAssetExtension('.MP3')).toBe('audio');
    expect(mediaKindForSidebarAssetExtension('.PDF')).toBe('pdf');
    expect(mediaKindForSidebarAssetExtension('.PnG')).toBe('image');
    expect(mediaKindForSidebarAssetExtension('PDF')).toBe('pdf');
  });
});
