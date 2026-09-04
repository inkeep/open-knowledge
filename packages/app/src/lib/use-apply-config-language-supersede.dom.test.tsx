import type { LanguagePreference } from '@inkeep/open-knowledge-core';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { dynamicActivate } from './activate-locale';
import { i18n } from './i18n';
import { LANGUAGE_CACHE_STORAGE_KEY, useApplyConfigLanguage } from './use-apply-config-language';

const COLD_LOCALE = 'hi';
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

    expect(i18n.locale).toBe('en');

    rendered.unmount();

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
  test('paints the language that won, not the one still arriving', async () => {
    await dynamicActivate('en');

    let rendered!: ReturnType<typeof render>;
    act(() => {
      rendered = render(<LanguageHarness preference={OTHER_COLD_LOCALE} />);
    });
    expect(i18n.locale).toBe('en');

    await act(async () => {
      rendered.rerender(<LanguageHarness preference="es" />);
    });
    await waitFor(() => {
      expect(i18n.locale).toBe('es');
    });

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
