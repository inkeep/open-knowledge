/**
 * Covers one behavior: an in-flight catalog load whose effect is torn down
 * before it lands must not stamp `<html>` or the pre-paint cache.
 *
 * It lives in its own file because its premise is that a catalog is **not
 * loaded yet**, and `activate-locale.ts` records loaded catalogs in module
 * state that outlives a test. Any sibling test that reaches for the same locale
 * warms it, after which the load resolves synchronously, the teardown never
 * races anything, and this passes just as happily with the guard deleted.
 * Vitest gives each file its own module registry, which is what keeps the
 * locale genuinely cold; the assertion below fails loudly if it ever is not.
 */

import type { LanguagePreference } from '@inkeep/open-knowledge-core';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { dynamicActivate } from './activate-locale';
import { i18n } from './i18n';
import { LANGUAGE_CACHE_STORAGE_KEY, useApplyConfigLanguage } from './use-apply-config-language';

const COLD_LOCALE = 'hi';
// A second cold locale, because the test above warms `hi` and this file's whole
// premise is a load that is still in flight.
const OTHER_COLD_LOCALE = 'bn';

function LanguageHarness({ preference = COLD_LOCALE }: { preference?: LanguagePreference }) {
  useApplyConfigLanguage({ preference, userConfigSynced: true });
  return null;
}

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('lang');
  document.documentElement.removeAttribute('dir');
  localStorage.clear();
});

describe('useApplyConfigLanguage — a torn-down load', () => {
  test('does not paint the language it was fetching', async () => {
    let rendered!: ReturnType<typeof render>;
    act(() => {
      rendered = render(<LanguageHarness />);
    });

    // A dynamic import cannot resolve inside a synchronous `act`, so an
    // unactivated locale here proves the fetch is still in flight — and that a
    // warmed catalog has not quietly made the teardown below a no-op.
    expect(i18n.locale).toBe('en');

    rendered.unmount();

    // Drive the same catalog to completion rather than guessing how long its
    // chunk takes. The effect started its load first, so by the time this one
    // resolves the effect's continuation has already had its turn — which is
    // what makes the assertions below real rather than a race the test wins.
    await act(async () => {
      await dynamicActivate(COLD_LOCALE);
    });
    expect(i18n.locale).toBe(COLD_LOCALE);

    expect(document.documentElement.getAttribute('lang')).toBeNull();
    expect(document.documentElement.getAttribute('dir')).toBeNull();
    expect(localStorage.getItem(LANGUAGE_CACHE_STORAGE_KEY)).toBeNull();
  });
});

describe('useApplyConfigLanguage — a language changed mid-load', () => {
  // The user-facing shape of the same guard, and the one people actually reach:
  // clicking through the picker faster than the network answers. The unmount
  // case above cannot see a regression that leaves the guard latched, because
  // there is no second activation for it to block.
  test('paints the language that won, not the one still arriving', async () => {
    // The test above leaves its own locale active, so start from a known one
    // rather than inheriting whatever ran first.
    await dynamicActivate('en');

    let rendered!: ReturnType<typeof render>;
    act(() => {
      rendered = render(<LanguageHarness preference={OTHER_COLD_LOCALE} />);
    });
    // Same premise as above: a dynamic import cannot resolve inside a
    // synchronous `act`, so an unchanged locale here proves the fetch is still
    // in flight and the switch below genuinely overlaps it.
    expect(i18n.locale).toBe('en');

    await act(async () => {
      rendered.rerender(<LanguageHarness preference="es" />);
    });
    await waitFor(() => {
      expect(i18n.locale).toBe('es');
    });

    // Drive the abandoned locale all the way to done, so its continuation has
    // had its turn before the assertions below rather than after them.
    await act(async () => {
      await dynamicActivate(OTHER_COLD_LOCALE);
    });

    expect(document.documentElement.getAttribute('lang')).toBe('es');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
    expect(JSON.parse(localStorage.getItem(LANGUAGE_CACHE_STORAGE_KEY) ?? 'null')).toEqual({
      pref: 'es',
      locale: 'es',
      dir: 'ltr',
    });
  });
});
