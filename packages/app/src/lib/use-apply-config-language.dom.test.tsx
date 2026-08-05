/**
 * Covers the config-to-Lingui seam end to end: a stored preference reaches the
 * real `i18n` singleton through the real catalog loader, with nothing stubbed
 * between them.
 *
 * jsdom rather than the node unit tier because the hook is an effect, and the
 * ambient `navigator` rather than an injected list because ambient reads are
 * what the shipped hook does — a test that handed the provider its answer would
 * prove only that the resolver works, which the resolver's own tests cover.
 *
 * Every locale these tests reach for is loaded once up front, which makes
 * activation synchronous inside `act` (`dynamicActivate` only awaits when it has
 * to fetch). That is what lets the "nothing happened" assertions be real
 * assertions rather than a bet on how long a chunk takes: had the effect fired,
 * the locale would already have changed by the time they run. One test
 * deliberately keeps its catalog cold to cover the fetching path through the
 * hook.
 */

import {
  LAYOUT_DEFERRED_LOCALES,
  type LanguagePreference,
  PICKER_LOCALES,
} from '@inkeep/open-knowledge-core';
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
// Held cold on purpose — see the fetching-path test at the bottom.
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

/**
 * Replace the ambient browser language list for one test.
 *
 * Defines an own property over whatever `navigator` exposes — jsdom serves
 * `languages` from the prototype, so restoring means deleting the own property
 * rather than writing an old value back.
 */
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

// The Lingui singleton, the stubbed navigator, the `<html>` attributes and the
// cache all outlive a render, so each test puts them back before the next one
// reads them.
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
    // Taiwan reports a region, not a script. Landing on Simplified here would be
    // the wrong language in the same writing system's clothing.
    stubBrowserLanguages(['zh-TW']);

    await renderHarness('system', true);

    expect(i18n.locale).toBe('zh-Hant');
  });

  test('no saved language behaves exactly like following the browser', async () => {
    stubBrowserLanguages(['fr-CA', 'en-US']);

    await renderHarness(undefined, true);

    expect(i18n.locale).toBe('fr');
  });

  test('a language nobody has reviewed yet still activates', async () => {
    // The picker withholds these; a stored value must not, or a translator
    // cannot run the app in the language they are translating.
    expect(PICKER_LOCALES).not.toContain('zh-Hant');

    await renderHarness('zh-Hant', true);

    expect(i18n.locale).toBe('zh-Hant');
  });

  test('the bootstrap catalog stands until the user layer has loaded', async () => {
    // An absent preference and an unloaded one look identical on the value
    // alone. Acting on the unloaded one activates the browser's language on
    // every boot and then corrects it, which anyone who chose a language other
    // than their OS one sees as a flash.
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
    // The chrome still uses physical margins and insets, so right-to-left is
    // visibly wrong. An Arabic browser with nothing stored is a guess, and this
    // is not a guess worth making on someone's behalf.
    expect(LAYOUT_DEFERRED_LOCALES).toContain('ar');
    stubBrowserLanguages(['ar-EG', 'fr-CA']);

    await renderHarness('system', true);

    expect(i18n.locale).toBe('fr');
    expect(painted()).toEqual({ lang: 'fr', dir: 'ltr' });
  });

  test('asking for one of those languages by name still works', async () => {
    // The way a translator checks their own catalog, and the reason the guard
    // above lives on the platform tier rather than on the supported set.
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
    // `dir` is what the pre-paint script replays on the next load, so a locale
    // that activates without it would paint one left-to-right frame every
    // launch. Driven through the hook rather than through `applyLanguageToDom`
    // so the direction is derived on the same path a user takes.
    await renderHarness('ar', true);

    expect(i18n.locale).toBe('ar');
    expect(painted()).toEqual({ lang: 'ar', dir: 'rtl' });
    expect(cached()).toEqual({ pref: 'ar', locale: 'ar', dir: 'rtl' });
  });

  test('following the system caches the sentinel, not the locale it resolved to', async () => {
    stubBrowserLanguages(['zh-TW']);

    await renderHarness('system', true);

    // Storing `zh-Hant` as the preference would look like a deliberate pick and
    // stop tracking the OS from the next launch on.
    expect(cached()).toEqual({ pref: 'system', locale: 'zh-Hant', dir: 'ltr' });
  });

  test('an unset preference caches the sentinel too', async () => {
    stubBrowserLanguages(['fr-CA']);

    await renderHarness(undefined, true);

    expect(cached()).toEqual({ pref: 'system', locale: 'fr', dir: 'ltr' });
  });

  test('config wins over what the last session cached', async () => {
    // The previous session's paint, still on the document from pre-paint.
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

    // Overwriting here would repaint in the browser's language and then correct
    // itself, which is the flash the cache exists to prevent.
    expect(painted()).toEqual({ lang: 'zh-Hans', dir: 'ltr' });
  });

  test('no `storage` listener is registered for the language cache', () => {
    // All OK windows share one localStorage. A listener here would let one
    // window's write re-enter this effect in every other window and be echoed
    // back — the multi-window storm the theme bridge documents.
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

    // Only this test's own listener saw it: nothing in the module graph reacted
    // by rewriting the cache.
    expect(delivered).toBe(1);
    expect(cached()).toEqual({ pref: 'es', locale: 'es', dir: 'ltr' });
    expect(before).toBeNull();
  });
});
