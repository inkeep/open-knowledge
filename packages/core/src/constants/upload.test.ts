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

  test('IMAGE ∪ VIDEO ∪ AUDIO ∪ FILE_ATTACHMENT === WIKI_EMBED_EXTENSIONS (set equality)', () => {
    const union = new Set<string>([
      ...IMAGE_EXTENSIONS,
      ...VIDEO_EXTENSIONS,
      ...AUDIO_EXTENSIONS,
      ...FILE_ATTACHMENT_EXTENSIONS,
    ]);

    for (const ext of union) {
      expect(WIKI_EMBED_EXTENSIONS.has(ext)).toBe(true);
    }

    for (const ext of WIKI_EMBED_EXTENSIONS) {
      expect(union.has(ext)).toBe(true);
    }

    expect(union.size).toBe(WIKI_EMBED_EXTENSIONS.size);
  });

  test('FILE_ATTACHMENT_EXTENSIONS is disjoint from IMAGE / VIDEO / AUDIO', () => {
    for (const ext of FILE_ATTACHMENT_EXTENSIONS) {
      expect(IMAGE_EXTENSIONS.has(ext)).toBe(false);
      expect(VIDEO_EXTENSIONS.has(ext)).toBe(false);
      expect(AUDIO_EXTENSIONS.has(ext)).toBe(false);
    }
  });

  test('WIKI_EMBED_EXTENSIONS ⊆ ASSET_EXTENSIONS (embeddable ⇒ servable + resolvable)', () => {
    for (const ext of WIKI_EMBED_EXTENSIONS) {
      expect(ASSET_EXTENSIONS.has(ext)).toBe(true);
    }
  });

  test('ASSET_EXTENSIONS admits user-linked non-embed types (html/htm/gpx)', () => {
    expect(ASSET_EXTENSIONS.has('html')).toBe(true);
    expect(ASSET_EXTENSIONS.has('htm')).toBe(true);
    expect(ASSET_EXTENSIONS.has('gpx')).toBe(true);
  });
});

describe('mediaKindForSidebarAssetExtension', () => {

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
    expect(ASSET_EXTENSIONS.has('base')).toBe(false);
    expect(ASSET_EXTENSIONS.has('canvas')).toBe(false);
    expect(INLINE_RENDERABLE_EXTENSIONS.has('base')).toBe(false);
    expect(INLINE_RENDERABLE_EXTENSIONS.has('canvas')).toBe(false);
  });

  test('TEXT_VIEWER_FALLBACK_EXTENSIONS contains exactly base and canvas', () => {
    expect(TEXT_VIEWER_FALLBACK_EXTENSIONS.has('base')).toBe(true);
    expect(TEXT_VIEWER_FALLBACK_EXTENSIONS.has('canvas')).toBe(true);
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
