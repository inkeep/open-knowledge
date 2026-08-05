/**
 * What happens to the interface when the catalog for the language the user
 * asked for never arrives.
 *
 * A catalog is a separate file fetched at switch time, so "the connection
 * dropped" reaches the app as a rejected dynamic import. Refusing to serve one
 * specific chunk is the faithful way to reproduce that here — it is the same
 * boundary the network is, not a stand-in for one of our own modules. Every
 * other participant is real: the Lingui singleton, the loader, the effect, the
 * toaster.
 *
 * Its own file because the premise is that a catalog has never been fetched,
 * and `activate-locale` remembers what it has loaded for the lifetime of a
 * module registry. Vitest gives each file a fresh one.
 *
 * Within the file a catalog is spendable only once, so every test below takes a
 * language nothing else here touches. A shared one would make these pass or
 * fail by declaration order, and a spent one passes for the wrong reason — the
 * catalog answers from memory and the refusal is never consulted.
 *
 * In each test the notice appearing is itself the proof that the load really
 * rejected; nothing else here shows it. What the notice's own action does is
 * `tests/stress/language-load-failure.e2e.ts`, since it reloads.
 */

import type { LanguagePreference, SupportedLocale } from '@inkeep/open-knowledge-core';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Toaster } from '@/components/ui/sonner';
import { dynamicActivate } from './activate-locale';
import { i18n } from './i18n';
import { LANGUAGE_CACHE_STORAGE_KEY, useApplyConfigLanguage } from './use-apply-config-language';

/** The language the user is reading when the failed switch is attempted. */
const READING = 'es';
/** The language a test switches to when it needs one that simply works. */
const WORKING = 'fr';

/** How many more times each controlled catalog refuses to be served. */
const refusals = new Map<SupportedLocale, number>();

function refuseWhilePending(locale: SupportedLocale): boolean {
  const left = refusals.get(locale) ?? 0;
  if (left <= 0) return false;
  refusals.set(locale, left - 1);
  return true;
}

const CHUNK_UNREACHABLE = 'Failed to fetch dynamically imported module';

vi.doMock('@/locales/zh-Hans/messages.json', async () => {
  if (refuseWhilePending('zh-Hans')) throw new Error(CHUNK_UNREACHABLE);
  return await vi.importActual('@/locales/zh-Hans/messages.json');
});
vi.doMock('@/locales/zh-Hant/messages.json', async () => {
  if (refuseWhilePending('zh-Hant')) throw new Error(CHUNK_UNREACHABLE);
  return await vi.importActual('@/locales/zh-Hant/messages.json');
});
vi.doMock('@/locales/hi/messages.json', async () => {
  if (refuseWhilePending('hi')) throw new Error(CHUNK_UNREACHABLE);
  return await vi.importActual('@/locales/hi/messages.json');
});
vi.doMock('@/locales/bn/messages.json', async () => {
  if (refuseWhilePending('bn')) throw new Error(CHUNK_UNREACHABLE);
  return await vi.importActual('@/locales/bn/messages.json');
});
vi.doMock('@/locales/id/messages.json', async () => {
  if (refuseWhilePending('id')) throw new Error(CHUNK_UNREACHABLE);
  return await vi.importActual('@/locales/id/messages.json');
});
vi.doMock('@/locales/pt-BR/messages.json', async () => {
  if (refuseWhilePending('pt-BR')) throw new Error(CHUNK_UNREACHABLE);
  return await vi.importActual('@/locales/pt-BR/messages.json');
});

function LanguageHarness({ preference }: { preference: LanguagePreference }) {
  useApplyConfigLanguage({ preference, userConfigSynced: true });
  return null;
}

function tree(preference: LanguagePreference) {
  return (
    <>
      <Toaster closeButton />
      <LanguageHarness preference={preference} />
    </>
  );
}

async function renderHarness(preference: LanguagePreference) {
  let rendered!: ReturnType<typeof render>;
  await act(async () => {
    rendered = render(tree(preference));
  });
  return rendered;
}

const awaitNotice = () => screen.findByRole('button', { name: /reload/i });
const noticeCount = () => document.querySelectorAll('[data-sonner-toast]').length;

const painted = () => ({
  lang: document.documentElement.getAttribute('lang'),
  dir: document.documentElement.getAttribute('dir'),
});

const cached = () =>
  JSON.parse(localStorage.getItem(LANGUAGE_CACHE_STORAGE_KEY) ?? 'null') as unknown;

beforeEach(async () => {
  // Put the app where a user is mid-session: reading one language, with the
  // document and the cache already describing it.
  await act(async () => {
    await dynamicActivate(READING);
  });
  document.documentElement.lang = READING;
  document.documentElement.dir = 'ltr';
  localStorage.setItem(
    LANGUAGE_CACHE_STORAGE_KEY,
    JSON.stringify({ pref: READING, locale: READING, dir: 'ltr' }),
  );
  refusals.clear();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute('lang');
  document.documentElement.removeAttribute('dir');
});

describe('a catalog that never arrives', () => {
  test('leaves the interface in the language the user was already reading', async () => {
    refusals.set('zh-Hans', 1);

    await renderHarness('zh-Hans');
    await awaitNotice();

    // Reverting the whole screen to English here is the failure this guards
    // against: to someone mid-sentence in Spanish it reads as lost work rather
    // than as a network hiccup.
    expect(i18n.locale).toBe(READING);
    expect(painted()).toEqual({ lang: READING, dir: 'ltr' });
  });

  test('does not seed the next launch with a language that never loaded', async () => {
    refusals.set('zh-Hant', 1);

    await renderHarness('zh-Hant');
    await awaitNotice();

    expect(cached()).toEqual({ pref: READING, locale: READING, dir: 'ltr' });
  });

  test('two languages failing in a row leave one notice, not a pile', async () => {
    refusals.set('hi', 1);
    refusals.set('bn', 1);

    const { rerender } = await renderHarness('hi');
    await awaitNotice();
    await act(async () => {
      rerender(tree('bn'));
    });
    await act(async () => {
      await import('@/locales/bn/messages.json');
    });

    await waitFor(() => {
      expect(noticeCount()).toBe(1);
    });
    expect(i18n.locale).toBe(READING);
  });

  test('a failure the user has already moved past says nothing', async () => {
    refusals.set('id', 1);

    const { rerender } = await renderHarness('id');
    await act(async () => {
      rerender(tree(WORKING));
    });

    await waitFor(() => {
      expect(i18n.locale).toBe(WORKING);
    });
    expect(noticeCount()).toBe(0);
  });

  test('a different language that works clears the notice about the one that did not', async () => {
    refusals.set('pt-BR', 1);

    const { rerender } = await renderHarness('pt-BR');
    await awaitNotice();

    await act(async () => {
      rerender(tree(WORKING));
    });

    // Picking another language recovers in place — it is a different catalog at
    // a different address, so none of what stopped the first one applies. What
    // must not survive it is the complaint about the first one, sitting over an
    // interface that has already moved on.
    await waitFor(() => {
      expect(i18n.locale).toBe(WORKING);
    });
    await waitFor(() => {
      expect(noticeCount()).toBe(0);
    });
    expect(painted()).toEqual({ lang: WORKING, dir: 'ltr' });
  });
});
