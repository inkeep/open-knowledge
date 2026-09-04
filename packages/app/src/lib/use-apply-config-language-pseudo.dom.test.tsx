import type { LanguagePreference } from '@inkeep/open-knowledge-core';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { dynamicActivate } from './activate-locale';
import { i18n } from './i18n';
import { LANGUAGE_CACHE_STORAGE_KEY, useApplyConfigLanguage } from './use-apply-config-language';

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

async function renderHarness(preference: LanguagePreference, userConfigSynced: boolean) {
  let rendered!: ReturnType<typeof render>;
  await act(async () => {
    rendered = render(
      <LanguageHarness preference={preference} userConfigSynced={userConfigSynced} />,
    );
  });
  return rendered;
}

function requestPseudoLocale(): void {
  history.replaceState(null, '', '/?lang=pseudo');
}

beforeAll(async () => {
  for (const locale of ['es', 'zh-Hans'] as const) await dynamicActivate(locale);
  await dynamicActivate('en');
});

afterEach(async () => {
  cleanup();
  vi.unstubAllEnvs();
  history.replaceState(null, '', '/');
  document.documentElement.removeAttribute('lang');
  document.documentElement.removeAttribute('dir');
  localStorage.clear();
  await dynamicActivate('en');
});

describe('useApplyConfigLanguage — pseudolocale', () => {
  test('a requested pseudolocale outranks the configured language', async () => {
    requestPseudoLocale();

    await renderHarness('es', true);

    await waitFor(() => {
      expect(i18n.locale).toBe('pseudo');
    });
  });

  test('the instrument does not wait for the config layer to load', async () => {
    requestPseudoLocale();

    await renderHarness('es', false);

    await waitFor(() => {
      expect(i18n.locale).toBe('pseudo');
    });
  });

  test('a shipped build speaks the configured language even when handed the parameter', async () => {
    vi.stubEnv('PROD', true);
    requestPseudoLocale();

    await renderHarness('es', true);

    expect(i18n.locale).toBe('es');
  });

  test('it leaves nothing behind, so the next load speaks the configured language', async () => {
    requestPseudoLocale();
    const { rerender } = await renderHarness('es', true);
    await waitFor(() => {
      expect(i18n.locale).toBe('pseudo');
    });

    expect(document.documentElement.getAttribute('lang')).toBeNull();
    expect(localStorage.getItem(LANGUAGE_CACHE_STORAGE_KEY)).toBeNull();

    history.replaceState(null, '', '/');
    await act(async () => {
      rerender(<LanguageHarness preference="zh-Hans" userConfigSynced />);
    });

    expect(i18n.locale).toBe('zh-Hans');
  });
});
