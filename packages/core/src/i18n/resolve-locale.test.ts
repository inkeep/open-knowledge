import { describe, expect, test } from 'vitest';
import { asBcp47Tag, type Bcp47Tag } from './bcp47.ts';
import { AUTO_DETECTABLE_LOCALES, SUPPORTED_LOCALES, type SupportedLocale } from './locales.ts';
import { type LocaleResolution, resolveLocale } from './resolve-locale.ts';

/**
 * Build the shape a signal provider hands the resolver. Throws rather than
 * skipping, so a typo in a case table below surfaces as a failing fixture
 * instead of silently shortening the preference list under test.
 */
function preferences(...values: readonly string[]): readonly Bcp47Tag[] {
  return values.map((value) => {
    const tag = asBcp47Tag(value);
    if (tag === null) throw new Error(`test fixture is not a BCP 47 tag: ${value}`);
    return tag;
  });
}

/** Resolve with only a platform signal, against the full enumerated set. */
function fromSystem(...values: readonly string[]): LocaleResolution {
  return resolveLocale({
    override: undefined,
    storedPreference: undefined,
    preferenceList: preferences(...values),
    supportedLocales: SUPPORTED_LOCALES,
  });
}

describe('resolveLocale negotiation', () => {
  const table = [
    { request: ['zh-TW'], expected: 'zh-Hant' },
    { request: ['zh-HK'], expected: 'zh-Hant' },
    { request: ['zh-CN'], expected: 'zh-Hans' },
    { request: ['zh'], expected: 'zh-Hans' },
    { request: ['zh-SG'], expected: 'zh-Hans' },
    { request: ['zh-Hans-FI'], expected: 'zh-Hans' },
    { request: ['es-419'], expected: 'es' },
    { request: ['es-MX', 'en-US'], expected: 'es' },
    { request: ['fr-CA', 'es-ES'], expected: 'fr' },
    { request: ['pt-PT'], expected: 'pt-BR' },
    { request: ['ja', 'ko', 'en'], expected: 'ko' },
    { request: ['ko-KR'], expected: 'ko' },
    { request: ['ja'], expected: 'en' },
  ] as const satisfies readonly { request: readonly string[]; expected: SupportedLocale }[];

  for (const { request, expected } of table) {
    test(`[${request.join(', ')}] resolves to ${expected}`, () => {
      expect(fromSystem(...request).locale).toBe(expected);
    });
  }

  test('the first supported entry wins, even when a later one is also supported', () => {
    expect(fromSystem('fr-CA', 'es-ES').locale).toBe('fr');
    expect(fromSystem('es-ES', 'fr-CA').locale).toBe('es');
  });

  test('an unsupported leading entry is skipped rather than ending the walk', () => {
    expect(fromSystem('ja', 'en').source).toBe('system');
  });

  // The requested side must be maximized at all: `zh-TW` carries no script, so
  // a matcher comparing raw tags finds no `zh-TW` catalog and serves English to
  // a reader who asked for Chinese.
  test('a region-only Chinese request finds its script', () => {
    expect(fromSystem('zh-TW').locale).toBe('zh-Hant');
    expect(fromSystem('zh-CN').locale).toBe('zh-Hans');
  });

  // The supported side must be maximized too, and Latin-script requests are the
  // only rows that prove it. A matcher that reduces the request but compares it
  // against the raw catalog list still gets every Chinese row right, because
  // `zh-Hans` and `zh-Hant` reduce to themselves — while sending es, fr, pt-BR
  // and id to English, since a reduced `es-Latn` no longer equals a raw `es`.
  test('every Latin-script locale is reachable through a region tag', () => {
    expect(fromSystem('es-419').locale).toBe('es');
    expect(fromSystem('pt-PT').locale).toBe('pt-BR');
    expect(fromSystem('fr-CA').locale).toBe('fr');
    expect(fromSystem('id-ID').locale).toBe('id');
    expect(fromSystem('en-GB').locale).toBe('en');
  });

  test('a Korean region tag folds to the language catalog', () => {
    expect(fromSystem('ko-KR').locale).toBe('ko');
  });

  test('a platform signal cannot land on a locale held out of auto-detection', () => {
    // An Arabic OS with nothing stored. `ar` has a catalog and is still in
    // `supportedLocales`, so the only thing keeping it off the screen is the
    // narrower set the platform tier negotiates over.
    expect(
      resolveLocale({
        override: undefined,
        storedPreference: undefined,
        preferenceList: preferences('ar-EG'),
        supportedLocales: SUPPORTED_LOCALES,
        autoDetectableLocales: AUTO_DETECTABLE_LOCALES,
      }),
    ).toEqual({ locale: 'en', source: 'fallback' });
  });

  test('the walk continues past a held-out locale rather than ending at it', () => {
    // Falling straight to English here would be the wrong repair: this reader
    // named a second language the app can serve properly.
    expect(
      resolveLocale({
        override: undefined,
        storedPreference: undefined,
        preferenceList: preferences('ur-PK', 'fr-CA'),
        supportedLocales: SUPPORTED_LOCALES,
        autoDetectableLocales: AUTO_DETECTABLE_LOCALES,
      }),
    ).toEqual({ locale: 'fr', source: 'system' });
  });

  test('a held-out locale is still reachable by asking for it', () => {
    // Both tiers above the platform signal negotiate over the full supported
    // set, which is what keeps a translator able to run the app in the language
    // they are checking.
    expect(
      resolveLocale({
        override: undefined,
        storedPreference: 'ar',
        preferenceList: preferences('fr-CA'),
        supportedLocales: SUPPORTED_LOCALES,
        autoDetectableLocales: AUTO_DETECTABLE_LOCALES,
      }),
    ).toEqual({ locale: 'ar', source: 'explicit' });

    expect(
      resolveLocale({
        override: preferences('ur')[0],
        storedPreference: undefined,
        preferenceList: preferences('fr-CA'),
        supportedLocales: SUPPORTED_LOCALES,
        autoDetectableLocales: AUTO_DETECTABLE_LOCALES,
      }),
    ).toEqual({ locale: 'ur', source: 'override' });
  });

  test('an absent auto-detectable set means the whole supported set', () => {
    // A surface with no chrome to lay out has nothing to hold back, so the
    // default has to stay permissive rather than inheriting the chrome's list.
    expect(fromSystem('ar-EG')).toEqual({ locale: 'ar', source: 'system' });
  });

  test('the supported set is taken from the argument, not from the enumerated list', () => {
    expect(
      resolveLocale({
        override: undefined,
        storedPreference: undefined,
        preferenceList: preferences('es-MX'),
        supportedLocales: ['en', 'fr'],
      }),
    ).toEqual({ locale: 'en', source: 'fallback' });
  });
});

describe('resolveLocale tiers', () => {
  test('an override beats a saved choice', () => {
    expect(
      resolveLocale({
        override: preferences('fr')[0],
        storedPreference: 'es',
        preferenceList: preferences('hi'),
        supportedLocales: SUPPORTED_LOCALES,
      }),
    ).toEqual({ locale: 'fr', source: 'override' });
  });

  test('a saved choice beats the platform signal', () => {
    expect(
      resolveLocale({
        override: undefined,
        storedPreference: 'es',
        preferenceList: preferences('hi'),
        supportedLocales: SUPPORTED_LOCALES,
      }),
    ).toEqual({ locale: 'es', source: 'explicit' });
  });

  test('the platform signal beats the fallback', () => {
    expect(fromSystem('hi')).toEqual({ locale: 'hi', source: 'system' });
  });

  test('nothing at all lands on the fallback', () => {
    expect(
      resolveLocale({
        override: undefined,
        storedPreference: undefined,
        preferenceList: [],
        supportedLocales: SUPPORTED_LOCALES,
      }),
    ).toEqual({ locale: 'en', source: 'fallback' });
  });

  test('an override is negotiated like any other tag', () => {
    expect(
      resolveLocale({
        override: preferences('zh-TW')[0],
        storedPreference: undefined,
        preferenceList: [],
        supportedLocales: SUPPORTED_LOCALES,
      }),
    ).toEqual({ locale: 'zh-Hant', source: 'override' });
  });

  test('an override naming an unsupported language falls through instead of forcing the fallback', () => {
    expect(
      resolveLocale({
        override: preferences('ja')[0],
        storedPreference: 'es',
        preferenceList: preferences('hi'),
        supportedLocales: SUPPORTED_LOCALES,
      }),
    ).toEqual({ locale: 'es', source: 'explicit' });
  });

  test("an unset preference follows the platform exactly like 'system'", () => {
    const platform = preferences('zh-CN');
    const unset = resolveLocale({
      override: undefined,
      storedPreference: undefined,
      preferenceList: platform,
      supportedLocales: SUPPORTED_LOCALES,
    });
    const sentinel = resolveLocale({
      override: undefined,
      storedPreference: 'system',
      preferenceList: platform,
      supportedLocales: SUPPORTED_LOCALES,
    });
    expect(unset).toEqual({ locale: 'zh-Hans', source: 'system' });
    expect(sentinel).toEqual(unset);
  });

  // A hand-edited config, or a locale withdrawn after someone had already
  // chosen it. Boot must not fail, and the stored value is nobody's to rewrite.
  test('a saved choice with no catalog behind it falls through rather than being served', () => {
    expect(
      resolveLocale({
        override: undefined,
        storedPreference: 'bn',
        preferenceList: preferences('fr-CA'),
        supportedLocales: ['en', 'fr'],
      }),
    ).toEqual({ locale: 'fr', source: 'system' });
  });
});

describe('resolveLocale hostile input', () => {
  // Values no provider should produce, in the shape a buggy or lying provider
  // would produce them. The double cast is the point: it defeats the brand so
  // the runtime guarantee can be exercised on its own.
  const hostile = [
    '',
    '   ',
    'not a locale',
    'zh_CN.UTF-8',
    '!!!',
    'x'.repeat(200),
    '-',
    'en-',
    'C',
    'POSIX',
    'πλ',
    null,
    undefined,
    123,
  ];

  for (const value of hostile) {
    test(`${JSON.stringify(value)} in the platform signal resolves to the fallback`, () => {
      expect(
        resolveLocale({
          override: undefined,
          storedPreference: undefined,
          preferenceList: [value as unknown as Bcp47Tag],
          supportedLocales: SUPPORTED_LOCALES,
        }),
      ).toEqual({ locale: 'en', source: 'fallback' });
    });

    test(`${JSON.stringify(value)} as an override is ignored`, () => {
      expect(
        resolveLocale({
          override: value as unknown as Bcp47Tag,
          storedPreference: 'es',
          preferenceList: [],
          supportedLocales: SUPPORTED_LOCALES,
        }),
      ).toEqual({ locale: 'es', source: 'explicit' });
    });
  }

  test('a usable tag still resolves when a malformed one precedes it', () => {
    expect(
      resolveLocale({
        override: undefined,
        storedPreference: undefined,
        preferenceList: ['zh_TW.UTF-8' as unknown as Bcp47Tag, ...preferences('fr-CA')],
        supportedLocales: SUPPORTED_LOCALES,
      }),
    ).toEqual({ locale: 'fr', source: 'system' });
  });
});

describe('asBcp47Tag', () => {
  test('canonicalizes a well-formed tag', () => {
    expect(asBcp47Tag('ZH-hans-cn')).toBe('zh-Hans-CN');
    expect(asBcp47Tag('es-419')).toBe('es-419');
  });

  test('refuses POSIX locale ids and other non-tags', () => {
    for (const value of ['zh_TW.UTF-8', 'es_ES@euro', 'C', '', 'not a locale', '!!!']) {
      expect(asBcp47Tag(value)).toBeNull();
    }
  });

  // The one hostile input that does not announce itself: `Intl` accepts `POSIX`
  // and silently yields `posix`, a syntactically valid tag with no language
  // behind it. Rejecting it belongs to the POSIX conversion, so the sanctioned
  // constructor lets it through — and the matcher has to be the backstop.
  test("'POSIX' canonicalizes without throwing, and still matches no catalog", () => {
    expect(asBcp47Tag('POSIX')).toBe('posix');
    expect(fromSystem('POSIX')).toEqual({ locale: 'en', source: 'fallback' });
  });
});
