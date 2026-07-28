import { File, Film, ImageIcon, Volume2 } from 'lucide-react';
import { describe, expect, test } from 'vitest';
import { lucideIconToSvgString } from '@/editor/registry/lucide-svg';
import {
  fileEntryPathIconToSvgString,
  MARKDOWN_FILE_ICON_PATH_D,
  MARKDOWN_FILE_ICON_VIEWBOX,
} from './file-entry-icon';

describe('fileEntryPathIconToSvgString', () => {
  test('uses the media-specific lucide icon for video assets', () => {
    expect(fileEntryPathIconToSvgString('clips/demo.mp4')).toBe(lucideIconToSvgString(Film));
  });

  test('uses the media-specific lucide icon for audio assets', () => {
    expect(fileEntryPathIconToSvgString('audio/theme.mp3')).toBe(lucideIconToSvgString(Volume2));
  });

  test('keeps the image asset icon mapping', () => {
    expect(fileEntryPathIconToSvgString('assets/photo.png')).toBe(lucideIconToSvgString(ImageIcon));
  });

  test('keeps the custom markdown icon mapping', () => {
    expect(fileEntryPathIconToSvgString('notes.md')).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="0.75rem" height="0.75rem"' +
        ` viewBox="${MARKDOWN_FILE_ICON_VIEWBOX}" fill="currentColor" aria-hidden="true">` +
        `<path d="${MARKDOWN_FILE_ICON_PATH_D}"/></svg>`,
    );
  });

  test('keeps generic files on the fallback file icon', () => {
    expect(fileEntryPathIconToSvgString('data/example.csv')).toBe(lucideIconToSvgString(File));
  });
});
