import { afterEach, describe, expect, test, vi } from 'vitest';
import { readBrowserLanguages } from './browser-locale-provider.ts';
import { SUPPORTED_LOCALES } from './locales.ts';
import { resolveLocale } from './resolve-locale.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reading the browser language signal', () => {
  test('reports the preference list in the order the browser gave it', () => {
    expect(readBrowserLanguages({ languages: ['fr-CA', 'en-US'] })).toEqual(['fr-CA', 'en-US']);
  });

  test('canonicalizes what the browser reports', () => {
    expect(readBrowserLanguages({ languages: ['ZH-hant-tw'] })).toEqual(['zh-Hant-TW']);
  });

  test('drops entries that are not language tags and keeps the rest in order', () => {
    expect(readBrowserLanguages({ languages: ['en-US', 'not a locale', 'fr-FR'] })).toEqual([
      'en-US',
      'fr-FR',
    ]);
  });

  test('falls back to the singular language when the list is absent', () => {
    expect(readBrowserLanguages({ language: 'es-MX' })).toEqual(['es-MX']);
  });

  test('falls back to the singular language when the list is empty', () => {
    expect(readBrowserLanguages({ languages: [], language: 'es-MX' })).toEqual(['es-MX']);
  });

  test('reports no signal when the browser offers neither', () => {
    expect(readBrowserLanguages({})).toEqual([]);
  });
});

describe('the ambient browser', () => {
  test('is read when no source is supplied', () => {
    vi.stubGlobal('navigator', { languages: ['fr-CA', 'en-US'] });
    expect(readBrowserLanguages()).toEqual(['fr-CA', 'en-US']);
  });

  test('reports no signal when the runtime declares no language on it', () => {
    vi.stubGlobal('navigator', {});
    expect(readBrowserLanguages()).toEqual([]);
  });

  test('reports no signal in a runtime where navigator is not declared at all', () => {
    const declared = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    try {
      Reflect.deleteProperty(globalThis, 'navigator');
      expect(readBrowserLanguages()).toEqual([]);
    } finally {
      if (declared !== undefined) Object.defineProperty(globalThis, 'navigator', declared);
    }
  });
});

describe('browser signal to activated locale', () => {
  const table = [
    { languages: ['zh-TW'], expected: 'zh-Hant' },
    { languages: ['es-MX', 'en-US'], expected: 'es' },
    { languages: ['ja'], expected: 'en' },
    { languages: [], expected: 'en' },
  ] as const satisfies readonly { languages: readonly string[]; expected: string }[];

  for (const { languages, expected } of table) {
    test(`[${languages.join(', ')}] activates ${expected}`, () => {
      const resolution = resolveLocale({
        override: undefined,
        storedPreference: undefined,
        preferenceList: readBrowserLanguages({ languages }),
        supportedLocales: SUPPORTED_LOCALES,
      });
      expect(resolution.locale).toBe(expected);
    });
  }
});
