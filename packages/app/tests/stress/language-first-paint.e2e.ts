/**
 * Language first-paint E2E.
 *
 * Covers the user-observable half of the no-flash requirement: a returning user
 * gets their own language and reading direction on the first frame, rather than
 * the default one that then corrects itself once config arrives.
 *
 * Implementation under test:
 *   - packages/app/index.html (inline language FOUC script)
 *   - packages/app/src/lib/use-apply-config-language.ts (the cache writer)
 *
 * `src/lib/language-fouc-prepaint.dom.test.ts` already runs that script's logic
 * over the writer's real output. What only a browser can show is that the
 * script is positioned to run before the application does — so each test here
 * aborts the entry module, leaving the inline script as the only thing that
 * could have touched `<html>`.
 */

import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

const STORAGE_KEY = 'ok-language-v1';

interface CachedLanguage {
  pref: string;
  locale: string;
  dir: string;
}

/**
 * Seed the cache the way a previous session would have left it.
 *
 * `addInitScript` runs before any script on the page, so the entry is in place
 * by the time the pre-paint script reads it — which is the state under test.
 */
async function seedLanguageCache(page: Page, entry: CachedLanguage): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key as string, value as string);
    },
    [STORAGE_KEY, JSON.stringify(entry)],
  );
}

/**
 * Load the app with its entry module blocked, and wait only for the document to
 * commit. Nothing from `src/` can run, so the assertions that follow are about
 * the pre-paint script alone.
 */
async function gotoWithoutApp(page: Page): Promise<void> {
  await page.route('**/src/main.tsx', (route) => route.abort());
  await page.goto('/', { waitUntil: 'commit' });
}

test.describe('language first paint', () => {
  test('paints the cached language before the app bundle runs', async ({ page }) => {
    await seedLanguageCache(page, { pref: 'zh-Hans', locale: 'zh-Hans', dir: 'ltr' });
    await gotoWithoutApp(page);

    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  });

  test('paints right-to-left before anything can lay out the other way', async ({ page }) => {
    // A late direction flip moves the entire layout rather than one word, which
    // is why direction is cached beside the locale instead of derived on mount.
    await seedLanguageCache(page, { pref: 'ar', locale: 'ar', dir: 'rtl' });
    await gotoWithoutApp(page);

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
  });

  test('a system preference paints the language it last resolved to', async ({ page }) => {
    await seedLanguageCache(page, { pref: 'system', locale: 'ur', dir: 'rtl' });
    await gotoWithoutApp(page);

    await expect(page.locator('html')).toHaveAttribute('lang', 'ur');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });

  test('a first-ever launch paints the bootstrap language', async ({ page }) => {
    await gotoWithoutApp(page);

    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });

  test('the running app puts the active language on the document', async ({ page }) => {
    // With the entry module allowed to run, the config effect is what sets the
    // attributes — and it agrees with the pre-paint script rather than fighting
    // it, which is what makes a reload flash-free.
    await page.goto('/');

    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe(
      JSON.stringify({ pref: 'system', locale: 'en', dir: 'ltr' }),
    );
  });
});
