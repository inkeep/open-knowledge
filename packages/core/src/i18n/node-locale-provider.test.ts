import { afterEach, describe, expect, test, vi } from 'vitest';
import { type LanguagePreference, SUPPORTED_LOCALES } from './locales.ts';
import { type LocaleEnvironment, readNodeLocaleSignal } from './node-locale-provider.ts';
import { type LocaleResolution, resolveLocale } from './resolve-locale.ts';

/** The ordered preference list an environment yields, as plain strings. */
function preferencesFor(env: LocaleEnvironment): readonly string[] {
  return [...readNodeLocaleSignal(env).preferenceList];
}

/** Run an environment through the provider and the shared policy, end to end. */
function resolveFor(
  env: LocaleEnvironment,
  storedPreference?: LanguagePreference,
): LocaleResolution {
  return resolveLocale({
    ...readNodeLocaleSignal(env),
    storedPreference,
    supportedLocales: SUPPORTED_LOCALES,
  });
}

describe('POSIX locale id conversion', () => {
  test('strips the codeset suffix', () => {
    expect(preferencesFor({ LANG: 'zh_TW.UTF-8' })).toEqual(['zh-TW']);
  });

  test('strips the modifier suffix', () => {
    expect(preferencesFor({ LANG: 'es_ES@euro' })).toEqual(['es-ES']);
  });

  test('strips a codeset and a modifier together', () => {
    expect(preferencesFor({ LANG: 'sr_RS.UTF-8@latin' })).toEqual(['sr-RS']);
  });

  test('maps the POSIX underscore separator to a hyphen', () => {
    expect(preferencesFor({ LANG: 'pt_BR' })).toEqual(['pt-BR']);
  });

  test('passes through a value that is already a language tag', () => {
    expect(preferencesFor({ LANG: 'fr' })).toEqual(['fr']);
  });

  // `C` and `POSIX` name the scripting locale, not a language. `POSIX` is the
  // one that hides: it canonicalizes to a meaningless `posix` instead of
  // failing, so rejecting both by name is what keeps it out of the matcher.
  test('the C locale is no signal at all', () => {
    expect(preferencesFor({ LANG: 'C' })).toEqual([]);
  });

  test('the POSIX locale is no signal at all', () => {
    expect(preferencesFor({ LANG: 'POSIX' })).toEqual([]);
  });

  test('a value that names no language yields no signal', () => {
    expect(preferencesFor({ LANG: 'not a locale' })).toEqual([]);
  });
});

describe('setlocale precedence', () => {
  test('LC_ALL outranks both LC_MESSAGES and LANG', () => {
    expect(
      preferencesFor({ LC_ALL: 'fr_FR.UTF-8', LC_MESSAGES: 'de_DE.UTF-8', LANG: 'es_ES.UTF-8' }),
    ).toEqual(['fr-FR']);
  });

  test('LC_MESSAGES outranks LANG', () => {
    expect(preferencesFor({ LC_MESSAGES: 'de_DE.UTF-8', LANG: 'es_ES.UTF-8' })).toEqual(['de-DE']);
  });

  test('an empty variable is skipped rather than read as a signal', () => {
    expect(preferencesFor({ LC_ALL: '', LC_MESSAGES: '   ', LANG: 'fr_FR.UTF-8' })).toEqual([
      'fr-FR',
    ]);
  });

  // The first variable that is SET wins, even when its value names no language.
  // Falling through to a weaker variable here would invert POSIX precedence and
  // translate a session the user explicitly asked to keep untranslated.
  test('a set-but-unusable stronger variable is not overridden by a weaker one', () => {
    expect(preferencesFor({ LC_ALL: 'C', LANG: 'fr_FR.UTF-8' })).toEqual([]);
  });

  test('an environment with no locale variables yields no signal', () => {
    expect(preferencesFor({})).toEqual([]);
  });
});

describe('the GNU LANGUAGE list', () => {
  test('contributes its entries, in order, ahead of the message locale', () => {
    expect(preferencesFor({ LANGUAGE: 'zh_CN:zh:en', LANG: 'zh_CN.UTF-8' })).toEqual([
      'zh-CN',
      'zh',
      'en',
      'zh-CN',
    ]);
  });

  test('drops entries that name no language and keeps the rest in order', () => {
    expect(preferencesFor({ LANGUAGE: 'fr_FR:C::!!!:de_DE', LANG: 'en_US.UTF-8' })).toEqual([
      'fr-FR',
      'de-DE',
      'en-US',
    ]);
  });

  // LANGUAGE is not part of the setlocale chain: it layers on top of the
  // message category and gettext ignores it outright when that category is C.
  test('is ignored entirely when the message locale is C', () => {
    expect(preferencesFor({ LANGUAGE: 'fr_FR:de_DE', LC_ALL: 'C' })).toEqual([]);
  });

  test('is ignored entirely when no message locale is set', () => {
    expect(preferencesFor({ LANGUAGE: 'fr_FR:de_DE' })).toEqual([]);
  });

  test('is ignored entirely when the message locale names no language', () => {
    expect(preferencesFor({ LANGUAGE: 'fr_FR', LANG: 'not a locale' })).toEqual([]);
  });
});

describe('the OK_LANG override', () => {
  test('is reported as the override tier rather than folded into the signal', () => {
    const signal = readNodeLocaleSignal({ OK_LANG: 'es', LANG: 'fr_FR.UTF-8' });
    expect(signal.override).toBe('es');
    expect([...signal.preferenceList]).toEqual(['fr-FR']);
  });

  test('wins over both the environment signal and a saved choice', () => {
    expect(resolveFor({ OK_LANG: 'ar', LANG: 'fr_FR.UTF-8' }, 'es')).toEqual({
      locale: 'ar',
      source: 'override',
    });
  });

  test('is negotiated like any other tag, so a region tag reaches its script', () => {
    expect(resolveFor({ OK_LANG: 'zh-TW' }).locale).toBe('zh-Hant');
  });

  test('falls through to the environment when it is not a language tag', () => {
    expect(resolveFor({ OK_LANG: 'not a locale', LANG: 'fr_FR.UTF-8' })).toEqual({
      locale: 'fr',
      source: 'system',
    });
  });

  test('falls through when it names a language with no catalog', () => {
    expect(resolveFor({ OK_LANG: 'ja', LANG: 'fr_FR.UTF-8' }).locale).toBe('fr');
  });

  test('is absent when unset or empty', () => {
    expect(readNodeLocaleSignal({}).override).toBeUndefined();
    expect(readNodeLocaleSignal({ OK_LANG: '  ' }).override).toBeUndefined();
  });
});

describe('POSIX environment to activated locale', () => {
  const table = [
    { env: { LANG: 'zh_TW.UTF-8' }, expected: 'zh-Hant' },
    { env: { LANG: 'es_ES@euro' }, expected: 'es' },
    { env: { LANG: 'C' }, expected: 'en' },
    { env: { LANG: 'POSIX' }, expected: 'en' },
  ] as const satisfies readonly { env: LocaleEnvironment; expected: string }[];

  for (const { env, expected } of table) {
    test(`LANG=${env.LANG} activates ${expected}`, () => {
      expect(resolveFor(env).locale).toBe(expected);
    });
  }

  test('the scripting locale reaches the fallback rather than a signal match', () => {
    expect(resolveFor({ LANG: 'POSIX' }).source).toBe('fallback');
  });
});

describe('hostile environments', () => {
  const values = [
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
    '@',
    '.',
    ':::',
  ];

  for (const value of values) {
    test(`a value of ${JSON.stringify(value)} resolves without throwing`, () => {
      for (const variable of ['OK_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE']) {
        expect(() => resolveFor({ [variable]: value })).not.toThrow();
      }
    });
  }
});

describe('the ambient environment', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // The default argument is the only line an injected environment never runs,
  // and it is the one every real caller takes.
  test('is read when no environment is supplied', () => {
    for (const variable of ['OK_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANGUAGE']) {
      vi.stubEnv(variable, undefined);
    }
    vi.stubEnv('LANG', 'fr_FR.UTF-8');

    const signal = readNodeLocaleSignal();
    expect(signal.override).toBeUndefined();
    expect([...signal.preferenceList]).toEqual(['fr-FR']);
  });
});

describe('module placement', () => {
  // The renderer bundles the root barrel, and nothing in CI catches a
  // `process.env` read that reaches it — the failure surfaces as a blank
  // editor window at runtime.
  test('the Node provider ships from the Node-only sub-export and not the browser-safe barrel', async () => {
    const nodeOnly = await import('../server.ts');
    expect(Object.keys(nodeOnly)).toContain('readNodeLocaleSignal');

    const browserSafe = await import('../index.ts');
    expect(Object.keys(browserSafe)).not.toContain('readNodeLocaleSignal');
  });
});
