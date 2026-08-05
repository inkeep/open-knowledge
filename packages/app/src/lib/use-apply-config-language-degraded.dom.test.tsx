/**
 * The two ways the language setting can be unusable without anything having
 * gone wrong with a catalog: the saved value names a language this build cannot
 * serve, and the config it lives in never arrives at all.
 *
 * Both have to end in a working app. A language preference is the one setting
 * whose failure could plausibly be argued into a blocking error — you cannot
 * show a message in a language you failed to load — and that argument is wrong
 * in both directions. There is always a language to fall back through to, and
 * the user did not ask to be stopped.
 *
 * The toaster is mounted so "says nothing" is a claim about the screen rather
 * than about which functions were called.
 */

import type { LanguagePreference } from '@inkeep/open-knowledge-core';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Toaster } from '@/components/ui/sonner';
import { dynamicActivate } from './activate-locale';
import { i18n } from './i18n';
import { showLocaleLoadFailureNotice } from './locale-load-failure-notice';
import { LANGUAGE_CACHE_STORAGE_KEY, useApplyConfigLanguage } from './use-apply-config-language';

/**
 * A saved value this build has no catalog for.
 *
 * Reachable in the field and unreachable through the type: config is a file on
 * disk, so it can be hand-edited, and it can also be written by a build that
 * knows a language this one does not. The cast is the point of the test.
 */
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

/**
 * Sonner exposes no role that survives its own markup churn, so count its
 * documented styling hook instead. The positive control below is what keeps
 * that from silently becoming a query that can never match.
 */
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
    // Without this, every "says nothing" assertion in this file would pass on a
    // query that had quietly stopped matching anything at all.
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

    // Waiting for the paint rather than reading straight after the render, so
    // the effect has demonstrably settled. That is also what gives the notice
    // assertion below its teeth: a settled effect has had every chance to
    // raise one.
    await waitFor(() => {
      expect(painted()).toEqual({ lang: 'fr', dir: 'ltr' });
    });
    expect(i18n.locale).toBe('fr');
    // Not a failure the user caused or can act on, and the app is fully usable
    // in the language it landed on. Complaining would be noise.
    expect(noticeCount()).toBe(0);

    Reflect.deleteProperty(globalThis.navigator, 'languages');
  });

  test('keeps the saved value as written, so it works again when the build does', async () => {
    await renderHarness(UNSERVEABLE, true);

    // Rewriting it to whatever it resolved to today would quietly convert an
    // upgrade-and-downgrade into a permanent loss of the user's choice.
    await waitFor(() => {
      expect(cached()).toMatchObject({ pref: UNSERVEABLE });
    });
  });
});

describe('config that never arrives', () => {
  test('leaves the language the previous session painted alone, and says nothing', async () => {
    // The server being down is not information about what language to use, and
    // the cached paint is the best answer available until config says otherwise.
    document.documentElement.lang = 'zh-Hans';
    document.documentElement.dir = 'ltr';

    await renderHarness(undefined, false);
    // A real module load rather than a bare microtask: the thing being ruled
    // out here is a module load, and a promise tick would settle first, leaving
    // the assertions holding only by being early.
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
