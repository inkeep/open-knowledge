import { describe, expect, test } from 'bun:test';
import {
  ALLOWED_AUDIO_MIME_TYPES,
  ALLOWED_IMAGE_MIME_TYPES,
  ALLOWED_PDF_MIME_TYPES,
  ALLOWED_VIDEO_MIME_TYPES,
} from '@inkeep/open-knowledge-core';
import { filterAssetsByAccept } from './filter-assets-by-accept.ts';

const PATHS = [
  'assets/photo.png',
  'assets/photo.jpg',
  'assets/clip.mp4',
  'assets/clip.webm',
  'assets/song.mp3',
  'assets/song.wav',
  'docs/handbook.pdf',
  'docs/notes.txt',
  'assets/icon.svg',
  'docs/spec.docx',
];

describe('filterAssetsByAccept', () => {
  test('image accept → only raster image extensions (png/jpg/...) — svg excluded', () => {
    // `mediaKindForSidebarAssetExtension('svg') → null` by design in OK
    // (SIDEBAR_IMAGE_EXTENSIONS is raster-only).
    const out = filterAssetsByAccept(PATHS, ALLOWED_IMAGE_MIME_TYPES);
    expect(out.sort()).toEqual(['assets/photo.jpg', 'assets/photo.png'].sort());
  });

  test('video accept → only video extensions (mp4/webm)', () => {
    const out = filterAssetsByAccept(PATHS, ALLOWED_VIDEO_MIME_TYPES);
    expect(out.sort()).toEqual(['assets/clip.mp4', 'assets/clip.webm'].sort());
  });

  test('audio accept → only audio extensions (mp3/wav)', () => {
    const out = filterAssetsByAccept(PATHS, ALLOWED_AUDIO_MIME_TYPES);
    expect(out.sort()).toEqual(['assets/song.mp3', 'assets/song.wav'].sort());
  });

  test('pdf accept → only pdf', () => {
    const out = filterAssetsByAccept(PATHS, ALLOWED_PDF_MIME_TYPES);
    expect(out).toEqual(['docs/handbook.pdf']);
  });

  test('wildcard ["*/*"] → every path (File descriptor case — svg admitted as raw file)', () => {
    // The File descriptor uses `accept: ['*/*']` and is the one path where
    // svg / docx / text files re-enter the autocomplete — the wildcard
    // doesn't go through `mediaKindForSidebarAssetExtension` at all.
    const out = filterAssetsByAccept(PATHS, ['*/*']);
    expect(out.sort()).toEqual([...PATHS].sort());
  });

  test('mixed accept (image + video) → union of kinds', () => {
    const out = filterAssetsByAccept(PATHS, [
      ...ALLOWED_IMAGE_MIME_TYPES,
      ...ALLOWED_VIDEO_MIME_TYPES,
    ]);
    expect(out.sort()).toEqual(
      ['assets/clip.mp4', 'assets/clip.webm', 'assets/photo.jpg', 'assets/photo.png'].sort(),
    );
  });

  test('wildcard mixed into a list → short-circuits to all', () => {
    // Defensive: a future descriptor that says `accept: ['image/*', '*/*']` is
    // semantically equivalent to "any file" — short-circuit so the wider
    // wildcard wins regardless of order.
    const out = filterAssetsByAccept(PATHS, ['image/png', '*/*']);
    expect(out.sort()).toEqual([...PATHS].sort());
  });

  test('unknown MIME types → silently drop those entries from the kind set', () => {
    // `application/x-custom` doesn't map to any kind, so the resulting
    // wanted-kinds set is empty and zero assets match. The function never
    // throws; the caller's UI just shows an empty list.
    expect(filterAssetsByAccept(PATHS, ['application/x-custom'])).toEqual([]);
  });

  test('mixed known + unknown MIME → known kinds still match', () => {
    expect(filterAssetsByAccept(PATHS, ['image/png', 'application/x-custom']).sort()).toEqual(
      ['assets/photo.jpg', 'assets/photo.png'].sort(),
    );
  });

  test('svg paths excluded from image-accept (raster-only sidebar extensions)', () => {
    // Encodes the OK design decision documented in `upload.ts` —
    // `SIDEBAR_IMAGE_EXTENSIONS = ['png','jpg','jpeg','gif','webp','avif']`,
    // intentionally omitting svg even though `image/svg+xml` is in
    // `ALLOWED_IMAGE_MIME_TYPES`. The autocomplete consumer inherits this:
    // svg uploads are admitted, but svg paths don't surface in the
    // image-src autocomplete list. If that decision is ever revisited,
    // widen `SIDEBAR_IMAGE_EXTENSIONS` rather than carving an exception here.
    expect(filterAssetsByAccept(['logo.svg', 'banner.png'], ALLOWED_IMAGE_MIME_TYPES)).toEqual([
      'banner.png',
    ]);
  });

  test('empty accept list → empty result (no kinds wanted)', () => {
    expect(filterAssetsByAccept(PATHS, [])).toEqual([]);
  });

  test('preserves input order (no implicit sort)', () => {
    // Stable order so caller-side ranking is predictable. Input order also
    // happens to be the order `usePageList().assetPaths` reports paths in,
    // which `SrcAutocomplete` reuses as the fallback ranking when the
    // user's query is empty.
    const ordered = ['z.png', 'a.png', 'm.png'];
    expect(filterAssetsByAccept(ordered, ALLOWED_IMAGE_MIME_TYPES)).toEqual([
      'z.png',
      'a.png',
      'm.png',
    ]);
  });

  test('files with no extension are skipped', () => {
    expect(filterAssetsByAccept(['README', 'LICENSE'], ALLOWED_IMAGE_MIME_TYPES)).toEqual([]);
  });

  test('case-insensitive extension matching', () => {
    expect(filterAssetsByAccept(['assets/PHOTO.PNG'], ALLOWED_IMAGE_MIME_TYPES)).toEqual([
      'assets/PHOTO.PNG',
    ]);
  });
});
