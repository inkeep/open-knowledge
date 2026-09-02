import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

const STORAGE_KEY = 'ok-language-v1';

interface CachedLanguage {
  pref: string;
  locale: string;
  dir: string;
}

async function seedLanguageCache(page: Page, entry: CachedLanguage): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key as string, value as string);
    },
    [STORAGE_KEY, JSON.stringify(entry)],
  );
}

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
    await page.goto('/');

    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe(
      JSON.stringify({ pref: 'system', locale: 'en', dir: 'ltr' }),
    );
  });
});
