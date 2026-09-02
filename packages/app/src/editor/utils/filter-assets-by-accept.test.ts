import {
  ALLOWED_AUDIO_MIME_TYPES,
  ALLOWED_IMAGE_MIME_TYPES,
  ALLOWED_PDF_MIME_TYPES,
  ALLOWED_VIDEO_MIME_TYPES,
} from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
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
    const out = filterAssetsByAccept(PATHS, ['image/png', '*/*']);
    expect(out.sort()).toEqual([...PATHS].sort());
  });

  test('unknown MIME types → silently drop those entries from the kind set', () => {
    expect(filterAssetsByAccept(PATHS, ['application/x-custom'])).toEqual([]);
  });

  test('mixed known + unknown MIME → known kinds still match', () => {
    expect(filterAssetsByAccept(PATHS, ['image/png', 'application/x-custom']).sort()).toEqual(
      ['assets/photo.jpg', 'assets/photo.png'].sort(),
    );
  });

  test('svg paths excluded from image-accept (raster-only sidebar extensions)', () => {
    expect(filterAssetsByAccept(['logo.svg', 'banner.png'], ALLOWED_IMAGE_MIME_TYPES)).toEqual([
      'banner.png',
    ]);
  });

  test('empty accept list → empty result (no kinds wanted)', () => {
    expect(filterAssetsByAccept(PATHS, [])).toEqual([]);
  });

  test('preserves input order (no implicit sort)', () => {
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
