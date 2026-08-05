/**
 * Covers the pseudolocale where it meets the configured language: the hook that
 * owns what the interface speaks has to hand over to the instrument, and has to
 * take the language back the moment the request is gone.
 *
 * Its own file rather than a case in `use-apply-config-language.dom.test.tsx`
 * because these tests move `location` and leave the pseudo catalog in the
 * singleton, and a fresh module registry per file is what keeps that from
 * reaching the tests next door.
 */

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

// Warm so that handing the language back is synchronous inside `act`, which is
// what lets the assertions after it be assertions rather than a bet on how long
// a chunk takes.
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
    // A reviewer sweeping for unwrapped strings wants the marking on screen from
    // the first frame, and has no use for a preference they are overriding.
    requestPseudoLocale();

    await renderHarness('es', false);

    await waitFor(() => {
      expect(i18n.locale).toBe('pseudo');
    });
  });

  test('a shipped build speaks the configured language even when handed the parameter', async () => {
    // The alternative is worse than reaching the instrument: a build that took
    // the branch and found nothing to activate would sit on the bootstrap
    // catalog whatever the user had chosen.
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

    // Neither the document nor the cache the pre-paint script reads: a marked-up
    // `en` is not a language, and painting the next load with it would strand
    // whoever opened the app next in it.
    expect(document.documentElement.getAttribute('lang')).toBeNull();
    expect(localStorage.getItem(LANGUAGE_CACHE_STORAGE_KEY)).toBeNull();

    history.replaceState(null, '', '/');
    await act(async () => {
      rerender(<LanguageHarness preference="zh-Hans" userConfigSynced />);
    });

    expect(i18n.locale).toBe('zh-Hans');
  });
});
