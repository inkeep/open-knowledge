import { languages } from '@excalidraw/excalidraw';
import { SUPPORTED_LOCALES } from '@inkeep/open-knowledge-core';
import { describe, expect, test } from 'vitest';
import {
  BOARD_FALLBACK_LOCALES,
  EXCALIDRAW_FALLBACK_LANG_CODE,
  excalidrawLangCode,
} from './excalidraw-lang.ts';

const offered = new Set(languages.map((language) => language.code));

describe('the Excalidraw language mapping', () => {
  test('this build really does offer the codes the rest of these tests check against', () => {
    expect(offered.size).toBeGreaterThan(15);
    expect(offered.has(EXCALIDRAW_FALLBACK_LANG_CODE)).toBe(true);
  });

  test.each(SUPPORTED_LOCALES)('maps %s to a language this build offers', (locale) => {
    expect(offered.has(excalidrawLangCode(locale))).toBe(true);
  });

  test('falls back only where upstream withholds the language from its own list', () => {
    expect([...BOARD_FALLBACK_LOCALES].sort()).toEqual(['bn', 'hi', 'ur']);

    const languageSubtags = new Set([...offered].map((code) => code.split('-')[0]));
    expect(languageSubtags.has('ko')).toBe(true);

    for (const locale of BOARD_FALLBACK_LOCALES) {
      expect(languageSubtags.has(locale)).toBe(false);
    }
  });

  test('falls back rather than handing the board a code it does not know', () => {
    expect(excalidrawLangCode('kl-GL')).toBe(EXCALIDRAW_FALLBACK_LANG_CODE);
    expect(excalidrawLangCode('')).toBe(EXCALIDRAW_FALLBACK_LANG_CODE);
  });

  test.each([
    'toString',
    'constructor',
    '__proto__',
    'valueOf',
  ])('returns a language code for the inherited key %s rather than something off the prototype', (key) => {
    expect(excalidrawLangCode(key)).toBe(EXCALIDRAW_FALLBACK_LANG_CODE);
  });

  test('keeps the two Chinese scripts on separate catalogs', () => {
    expect(excalidrawLangCode('zh-Hans')).toBe('zh-CN');
    expect(excalidrawLangCode('zh-Hant')).toBe('zh-TW');
  });
});
