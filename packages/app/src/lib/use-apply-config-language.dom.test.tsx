import { LAYOUT_DEFERRED_LOCALES, type LanguagePreference } from '@inkeep/open-knowledge-core';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { dynamicActivate } from './activate-locale';
import { i18n } from './i18n';
import {
  applyLanguageToDom,
  LANGUAGE_CACHE_STORAGE_KEY,
  useApplyConfigLanguage,
} from './use-apply-config-language';

const WARM_LOCALES = ['es', 'zh-Hans', 'zh-Hant', 'fr', 'ar'] as const;
const COLD_LOCALE = 'hi';

function LanguageHarness({
  preference,
  userConfigSynced,
}: {
  preference: LanguagePreference | undefined;
  userConfigSynced: boolean;
}) {
  useApplyConfigLanguage({ preference, userConfigSynced });
  return null;
}

let restoreBrowserLanguages: (() => void) | null = null;

function stubBrowserLanguages(languages: readonly string[]): void {
  const nav: object = globalThis.navigator;
  const previous = Object.getOwnPropertyDescriptor(nav, 'languages');
  Object.defineProperty(nav, 'languages', { value: languages, configurable: true });
  restoreBrowserLanguages = () => {
    if (previous === undefined) Reflect.deleteProperty(nav, 'languages');
    else Object.defineProperty(nav, 'languages', previous);
  };
}

async function renderHarness(
  preference: LanguagePreference | undefined,
  userConfigSynced: boolean,
) {
  let rendered!: ReturnType<typeof render>;
  await act(async () => {
    rendered = render(
      <LanguageHarness preference={preference} userConfigSynced={userConfigSynced} />,
    );
  });
  return rendered;
}

beforeAll(async () => {
  for (const locale of WARM_LOCALES) await dynamicActivate(locale);
  await dynamicActivate('en');
});

afterEach(async () => {
  cleanup();
  restoreBrowserLanguages?.();
  restoreBrowserLanguages = null;
  document.documentElement.removeAttribute('lang');
  document.documentElement.removeAttribute('dir');
  localStorage.clear();
  await dynamicActivate('en');
});

const painted = () => ({
  lang: document.documentElement.getAttribute('lang'),
  dir: document.documentElement.getAttribute('dir'),
});

const cached = () =>
  JSON.parse(localStorage.getItem(LANGUAGE_CACHE_STORAGE_KEY) ?? 'null') as unknown;

describe('useApplyConfigLanguage', () => {
  test('a saved language becomes the active catalog, over what the browser asks for', async () => {
    stubBrowserLanguages(['fr-CA', 'en-US']);

    await renderHarness('es', true);

    expect(i18n.locale).toBe('es');
  });

  test("'system' follows the browser, script and all", async () => {
    stubBrowserLanguages(['zh-TW']);

    await renderHarness('system', true);

    expect(i18n.locale).toBe('zh-Hant');
  });

  test('no saved language behaves exactly like following the browser', async () => {
    stubBrowserLanguages(['fr-CA', 'en-US']);

    await renderHarness(undefined, true);

    expect(i18n.locale).toBe('fr');
  });

  test('the bootstrap catalog stands until the user layer has loaded', async () => {
    stubBrowserLanguages(['fr-CA', 'en-US']);

    const { rerender } = await renderHarness('es', false);
    expect(i18n.locale).toBe('en');

    await act(async () => {
      rerender(<LanguageHarness preference="es" userConfigSynced />);
    });
    expect(i18n.locale).toBe('es');
  });

  test('changing the saved language switches in place', async () => {
    const { rerender } = await renderHarness('es', true);
    expect(i18n.locale).toBe('es');

    await act(async () => {
      rerender(<LanguageHarness preference="zh-Hans" userConfigSynced />);
    });

    expect(i18n.locale).toBe('zh-Hans');
  });

  test('a catalog that is not in memory yet is fetched and then activated', async () => {
    await renderHarness(COLD_LOCALE, true);

    await waitFor(() => {
      expect(i18n.locale).toBe(COLD_LOCALE);
    });
  });

  test('the browser alone cannot put the chrome in a language it cannot lay out', async () => {
    expect(LAYOUT_DEFERRED_LOCALES).toContain('ar');
    stubBrowserLanguages(['ar-EG', 'fr-CA']);

    await renderHarness('system', true);

    expect(i18n.locale).toBe('fr');
    expect(painted()).toEqual({ lang: 'fr', dir: 'ltr' });
  });

  test('asking for one of those languages by name still works', async () => {
    stubBrowserLanguages(['en-US']);

    await renderHarness('ar', true);

    expect(i18n.locale).toBe('ar');
  });
});

describe('useApplyConfigLanguage — first paint', () => {
  test('the active language reaches `<html>`, so the next load starts there', async () => {
    await renderHarness('zh-Hans', true);

    expect(painted()).toEqual({ lang: 'zh-Hans', dir: 'ltr' });
    expect(cached()).toEqual({ pref: 'zh-Hans', locale: 'zh-Hans', dir: 'ltr' });
  });

  test('a right-to-left language reaches `<html>` with its direction', async () => {
    await renderHarness('ar', true);

    expect(i18n.locale).toBe('ar');
    expect(painted()).toEqual({ lang: 'ar', dir: 'rtl' });
    expect(cached()).toEqual({ pref: 'ar', locale: 'ar', dir: 'rtl' });
  });

  test('following the system caches the sentinel, not the locale it resolved to', async () => {
    stubBrowserLanguages(['zh-TW']);

    await renderHarness('system', true);

    expect(cached()).toEqual({ pref: 'system', locale: 'zh-Hant', dir: 'ltr' });
  });

  test('an unset preference caches the sentinel too', async () => {
    stubBrowserLanguages(['fr-CA']);

    await renderHarness(undefined, true);

    expect(cached()).toEqual({ pref: 'system', locale: 'fr', dir: 'ltr' });
  });

  test('config wins over what the last session cached', async () => {
    applyLanguageToDom({ preference: 'ar', locale: 'ar' });
    expect(painted()).toEqual({ lang: 'ar', dir: 'rtl' });

    await renderHarness('es', true);

    expect(painted()).toEqual({ lang: 'es', dir: 'ltr' });
    expect(cached()).toEqual({ pref: 'es', locale: 'es', dir: 'ltr' });
  });

  test('the pre-paint values stand until the user layer has loaded', async () => {
    applyLanguageToDom({ preference: 'zh-Hans', locale: 'zh-Hans' });
    stubBrowserLanguages(['fr-CA']);

    await renderHarness('zh-Hans', false);

    expect(painted()).toEqual({ lang: 'zh-Hans', dir: 'ltr' });
  });

  test('no `storage` listener is registered for the language cache', () => {
    const before = window.localStorage.getItem(LANGUAGE_CACHE_STORAGE_KEY);
    let delivered = 0;
    const count = () => {
      delivered += 1;
    };
    window.addEventListener('storage', count);
    try {
      applyLanguageToDom({ preference: 'es', locale: 'es' });
      window.dispatchEvent(
        new StorageEvent('storage', { key: LANGUAGE_CACHE_STORAGE_KEY, newValue: 'x' }),
      );
    } finally {
      window.removeEventListener('storage', count);
    }

    expect(delivered).toBe(1);
    expect(cached()).toEqual({ pref: 'es', locale: 'es', dir: 'ltr' });
    expect(before).toBeNull();
  });
});
