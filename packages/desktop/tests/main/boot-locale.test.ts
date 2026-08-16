import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  describeDesktopLanguage,
  readStoredLanguagePreference,
  resolveDesktopLocale,
  resolveDesktopLocaleForPushed,
  resolveDesktopLocaleFrom,
} from '../../src/main/boot-locale.ts';

/**
 * The disk half runs against a real `~/.ok/global.yml` in a throwaway home, not
 * a stubbed reader: reading a user preference off disk is a capability main did
 * not have before this, so the thing worth proving is that the file main writes
 * from Settings is the file main reads at boot.
 */
let home = '';

function writeUserConfig(body: string): void {
  mkdirSync(join(home, '.ok'), { recursive: true });
  writeFileSync(join(home, '.ok', 'global.yml'), body, 'utf8');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ok-boot-locale-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('readStoredLanguagePreference', () => {
  test('reads appearance.language out of the user config', () => {
    writeUserConfig('appearance:\n  language: zh-Hant\n');
    expect(readStoredLanguagePreference(home)).toBe('zh-Hant');
  });

  test('preserves the system sentinel rather than resolving it', () => {
    writeUserConfig('appearance:\n  language: system\n');
    expect(readStoredLanguagePreference(home)).toBe('system');
  });

  test('reads system when no config file exists at all', () => {
    expect(readStoredLanguagePreference(home)).toBe('system');
  });

  test('reads system when the config is unparseable, and leaves the file alone', () => {
    const body = ':::not yaml at all\n  - [\n';
    writeUserConfig(body);
    expect(readStoredLanguagePreference(home)).toBe('system');
    // Building a menu must not rename the user's config out from under them,
    // which is what `readConfigSafely` does by default on a corrupt file.
    // Asserting the bytes rather than a second read: a sidelined file also
    // reads as `'system'`, so the return value alone cannot tell them apart.
    expect(readFileSync(join(home, '.ok', 'global.yml'), 'utf8')).toBe(body);
    expect(readdirSync(join(home, '.ok'))).toEqual(['global.yml']);
  });

  // Main has no DevTools. Degrading quietly here leaves an English menu bar
  // over a translated app with nothing anywhere saying why, which is a support
  // call that ends in someone opening the `.app` bundle by hand.
  test('says so when the config is unreadable', () => {
    const said: string[] = [];
    writeUserConfig(':::not yaml at all\n  - [\n');
    expect(readStoredLanguagePreference(home, (message) => said.push(message))).toBe('system');
    expect(said).not.toEqual([]);
    expect(said.join('\n')).toContain(join(home, '.ok', 'global.yml'));
  });

  test('stays quiet when the config is fine', () => {
    const said: string[] = [];
    writeUserConfig('appearance:\n  language: es\n');
    expect(readStoredLanguagePreference(home, (message) => said.push(message))).toBe('es');
    expect(said).toEqual([]);
  });
});

describe('resolveDesktopLocale', () => {
  test('a stored choice wins over the OS languages', () => {
    writeUserConfig('appearance:\n  language: es\n');
    expect(
      resolveDesktopLocale({
        homedir: home,
        preferredSystemLanguages: () => ['fr-FR'],
        env: {},
      }),
    ).toBe('es');
  });

  test('the system sentinel follows the OS preferred-language list', () => {
    writeUserConfig('appearance:\n  language: system\n');
    expect(
      resolveDesktopLocale({
        homedir: home,
        preferredSystemLanguages: () => ['zh-TW', 'en-US'],
        env: {},
      }),
    ).toBe('zh-Hant');
  });

  test('an unset preference behaves like the system sentinel', () => {
    expect(
      resolveDesktopLocale({
        homedir: home,
        preferredSystemLanguages: () => ['es-MX'],
        env: {},
      }),
    ).toBe('es');
  });

  test('OK_LANG outranks both the stored choice and the OS', () => {
    writeUserConfig('appearance:\n  language: es\n');
    expect(
      resolveDesktopLocale({
        homedir: home,
        preferredSystemLanguages: () => ['fr-FR'],
        env: { OK_LANG: 'zh-Hant' },
      }),
    ).toBe('zh-Hant');
  });

  test('OK_LANG reaches an enumerated locale the picker does not offer', () => {
    expect(
      resolveDesktopLocale({
        homedir: home,
        preferredSystemLanguages: () => [],
        env: { OK_LANG: 'bn' },
      }),
    ).toBe('bn');
  });

  test('a garbage OK_LANG falls through instead of throwing', () => {
    writeUserConfig('appearance:\n  language: es\n');
    expect(
      resolveDesktopLocale({
        homedir: home,
        preferredSystemLanguages: () => ['fr-FR'],
        env: { OK_LANG: 'zh_TW.UTF-8' },
      }),
    ).toBe('es');
  });

  test('falls back to English when nothing matches', () => {
    expect(
      resolveDesktopLocale({
        homedir: home,
        preferredSystemLanguages: () => ['ja-JP'],
        env: {},
      }),
    ).toBe('en');
  });

  // The menu bar sits over the same chrome the renderer does, and that chrome
  // does not lay out right-to-left yet. An Arabic OS must not be enough on its
  // own to put someone there.
  test('an OS language whose layout is unfinished is not guessed into', () => {
    expect(
      resolveDesktopLocale({
        homedir: home,
        preferredSystemLanguages: () => ['ar-EG'],
        env: {},
      }),
    ).toBe('en');
  });

  test('but asking for that language by name still reaches it', () => {
    writeUserConfig('appearance:\n  language: ar\n');
    expect(
      resolveDesktopLocale({
        homedir: home,
        preferredSystemLanguages: () => ['en-US'],
        env: {},
      }),
    ).toBe('ar');
    expect(
      resolveDesktopLocale({
        homedir: home,
        preferredSystemLanguages: () => ['en-US'],
        env: { OK_LANG: 'ur' },
      }),
    ).toBe('ur');
  });
});

describe('resolveDesktopLocaleFrom', () => {
  test('re-resolves a pushed preference without touching disk', () => {
    expect(
      resolveDesktopLocaleFrom({
        storedPreference: 'system',
        override: undefined,
        preferredSystemLanguages: ['zh-Hans-FI'],
      }),
    ).toBe('zh-Hans');
    expect(
      resolveDesktopLocaleFrom({
        storedPreference: 'zh-Hant',
        override: undefined,
        preferredSystemLanguages: ['en-US'],
      }),
    ).toBe('zh-Hant');
  });

  test('an empty OS list still resolves rather than throwing', () => {
    expect(
      resolveDesktopLocaleFrom({
        storedPreference: 'system',
        override: undefined,
        preferredSystemLanguages: [],
      }),
    ).toBe('en');
  });

  // The live-rebuild path re-resolves without re-reading disk, so it needs the
  // same guard as boot rather than inheriting it by accident.
  test('holds back the unfinished-layout locales on the pushed path too', () => {
    expect(
      resolveDesktopLocaleFrom({
        storedPreference: 'system',
        override: undefined,
        preferredSystemLanguages: ['ur-PK', 'es-ES'],
      }),
    ).toBe('es');
    expect(
      resolveDesktopLocaleFrom({
        storedPreference: 'ur',
        override: undefined,
        preferredSystemLanguages: ['en-US'],
      }),
    ).toBe('ur');
  });
});

describe('resolveDesktopLocaleForPushed', () => {
  /**
   * The regression this exists for: the renderer pushes the instant the config
   * document changes, but that document reaches `~/.ok/global.yml` through
   * debounced persistence. A menu rebuild that re-read the file at push time
   * answered with the language the user had just left, so the native menu bar
   * appeared not to follow the setting until the next reload re-pushed.
   */
  test('answers with the pushed preference while disk still holds the previous one', () => {
    writeUserConfig('appearance:\n  language: zh-Hans\n');
    const deps = { preferredSystemLanguages: () => ['en-US'], env: {} as NodeJS.ProcessEnv };

    // What the disk-reading path still sees at this instant — the stale value
    // that used to reach the menu.
    expect(resolveDesktopLocale({ homedir: home, ...deps })).toBe('zh-Hans');
    expect(resolveDesktopLocaleForPushed('es', deps)).toBe('es');
  });

  test('keeps the system sentinel following the OS rather than freezing a tag', () => {
    writeUserConfig('appearance:\n  language: es\n');
    expect(
      resolveDesktopLocaleForPushed('system', {
        preferredSystemLanguages: () => ['zh-TW'],
        env: {} as NodeJS.ProcessEnv,
      }),
    ).toBe('zh-Hant');
  });

  test('the override tier still outranks a pushed preference', () => {
    expect(
      resolveDesktopLocaleForPushed('es', {
        preferredSystemLanguages: () => ['en-US'],
        env: { OK_LANG: 'fr' } as NodeJS.ProcessEnv,
      }),
    ).toBe('fr');
  });
});

describe('describeDesktopLanguage', () => {
  const OS_LIST = ['en-US'];
  const deps = {
    preferredSystemLanguages: () => OS_LIST,
    env: {} as NodeJS.ProcessEnv,
  };

  test('reports the stored choice unresolved, beside what it resolved to', () => {
    writeUserConfig('appearance:\n  language: zh-Hant\n');

    expect(describeDesktopLanguage({ homedir: home, pushedPreference: null, ...deps })).toEqual({
      preference: 'zh-Hant',
      locale: 'zh-Hant',
      source: 'explicit',
      systemLanguages: OS_LIST,
    });
  });

  /**
   * `'system'` is the default and the most common stored value, so a bundle
   * carrying only the preference would say nothing about most reports. The
   * resolved locale plus the tier that decided is what makes it diagnosable.
   */
  test('a system preference carries the resolved locale and the list it matched', () => {
    const language = describeDesktopLanguage({
      homedir: home,
      pushedPreference: null,
      preferredSystemLanguages: () => ['es-ES', 'en-US'],
      env: {} as NodeJS.ProcessEnv,
    });

    expect(language.preference).toBe('system');
    expect(language.locale).toBe('es');
    expect(language.source).toBe('system');
    expect(language.systemLanguages).toEqual(['es-ES', 'en-US']);
  });

  /**
   * The same debounced-persistence window `resolveDesktopLocaleForPushed`
   * exists for. A report filed inside it is exactly the report claiming that
   * changing the language did not take — recording the stale on-disk value
   * would corroborate a bug that is not there and hide the one that is.
   */
  test('prefers the pushed preference over the value still on disk', () => {
    writeUserConfig('appearance:\n  language: zh-Hans\n');

    const language = describeDesktopLanguage({
      homedir: home,
      pushedPreference: 'fr',
      ...deps,
    });

    expect(language.preference).toBe('fr');
    expect(language.locale).toBe('fr');
  });

  test('an override is named as the tier that decided, keeping the stored choice visible', () => {
    writeUserConfig('appearance:\n  language: es\n');

    const language = describeDesktopLanguage({
      homedir: home,
      pushedPreference: null,
      preferredSystemLanguages: () => OS_LIST,
      env: { OK_LANG: 'fr' } as NodeJS.ProcessEnv,
    });

    expect(language.locale).toBe('fr');
    expect(language.source).toBe('override');
    expect(language.preference).toBe('es');
  });

  test('a corrupt user config degrades to system rather than throwing', () => {
    writeUserConfig('appearance: [not\n  valid: yaml\n');

    expect(() =>
      describeDesktopLanguage({ homedir: home, pushedPreference: null, ...deps }),
    ).not.toThrow();
    expect(
      describeDesktopLanguage({ homedir: home, pushedPreference: null, ...deps }).preference,
    ).toBe('system');
  });
});
