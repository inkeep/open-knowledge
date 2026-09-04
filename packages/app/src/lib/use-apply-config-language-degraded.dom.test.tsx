import type { LanguagePreference } from '@inkeep/open-knowledge-core';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Toaster } from '@/components/ui/sonner';
import { dynamicActivate } from './activate-locale';
import { i18n } from './i18n';
import { showLocaleLoadFailureNotice } from './locale-load-failure-notice';
import { LANGUAGE_CACHE_STORAGE_KEY, useApplyConfigLanguage } from './use-apply-config-language';

const UNSERVEABLE = 'ja' as LanguagePreference;

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

function tree(preference: LanguagePreference | undefined, userConfigSynced: boolean) {
  return (
    <>
      <Toaster closeButton />
      <LanguageHarness preference={preference} userConfigSynced={userConfigSynced} />
    </>
  );
}

async function renderHarness(
  preference: LanguagePreference | undefined,
  userConfigSynced: boolean,
) {
  let rendered!: ReturnType<typeof render>;
  await act(async () => {
    rendered = render(tree(preference, userConfigSynced));
  });
  return rendered;
}

const painted = () => ({
  lang: document.documentElement.getAttribute('lang'),
  dir: document.documentElement.getAttribute('dir'),
});

const cached = () =>
  JSON.parse(localStorage.getItem(LANGUAGE_CACHE_STORAGE_KEY) ?? 'null') as unknown;

const noticeCount = () => document.querySelectorAll('[data-sonner-toast]').length;

beforeAll(async () => {
  await dynamicActivate('fr');
});

beforeEach(async () => {
  await act(async () => {
    await dynamicActivate('en');
  });
  document.documentElement.removeAttribute('lang');
  document.documentElement.removeAttribute('dir');
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('the detector the suites below rely on', () => {
  test('sees a notice when there is one to see', async () => {
    await renderHarness(undefined, false);
    expect(noticeCount()).toBe(0);

    showLocaleLoadFailureNotice({ locale: 'es', reload: () => {} });
    await screen.findByRole('button', { name: /reload/i });

    expect(noticeCount()).toBe(1);
  });
});

describe('a saved language this build cannot serve', () => {
  test('resolves on through the normal chain instead of blocking the app', async () => {
    Object.defineProperty(globalThis.navigator, 'languages', {
      value: ['fr-CA'],
      configurable: true,
    });

    await renderHarness(UNSERVEABLE, true);

    await waitFor(() => {
      expect(painted()).toEqual({ lang: 'fr', dir: 'ltr' });
    });
    expect(i18n.locale).toBe('fr');
    expect(noticeCount()).toBe(0);

    Reflect.deleteProperty(globalThis.navigator, 'languages');
  });

  test('keeps the saved value as written, so it works again when the build does', async () => {
    await renderHarness(UNSERVEABLE, true);

    await waitFor(() => {
      expect(cached()).toMatchObject({ pref: UNSERVEABLE });
    });
  });
});

describe('config that never arrives', () => {
  test('leaves the language the previous session painted alone, and says nothing', async () => {
    document.documentElement.lang = 'zh-Hans';
    document.documentElement.dir = 'ltr';

    await renderHarness(undefined, false);
    await act(async () => {
      await import('@/locales/ur/messages.json');
    });

    expect(painted()).toEqual({ lang: 'zh-Hans', dir: 'ltr' });
    expect(i18n.locale).toBe('en');
    expect(noticeCount()).toBe(0);
  });

  test('reconciles as soon as config does arrive', async () => {
    document.documentElement.lang = 'zh-Hans';

    const { rerender } = await renderHarness(undefined, false);
    await act(async () => {
      rerender(tree('fr', true));
    });

    expect(i18n.locale).toBe('fr');
    expect(painted()).toEqual({ lang: 'fr', dir: 'ltr' });
  });
});
