/**
 * Language picker E2E.
 *
 * The jsdom tier already drives the real Radix Select and asserts the exact
 * config patch. What only a browser shows is the rest of the chain: the patch
 * reaching the user-config document, coming back through ConfigProvider, the
 * resolved locale landing on `<html>`, and the chrome coming back in the picked
 * language — which no unit tier can show, since they alias the Lingui macros to
 * an English passthrough.
 *
 * Implementation under test:
 *   - packages/app/src/components/settings/LanguageSelect.tsx
 *   - packages/app/src/components/settings/settings-fields.ts
 *   - packages/app/src/lib/use-apply-config-language.ts
 *
 * Runnable via `pnpm exec playwright test tests/stress/language-picker.e2e.ts`;
 * wired into the CI `test:e2e` subset (packages/app/package.json).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

// The picker writes a USER-scope preference, which lands in `~/.ok/global.yml`.
// Node resolves `homedir()` from `HOME` on POSIX, so pointing the dev server at
// a throwaway home keeps the test off the developer's own global config.
const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'ok-language-home-'));

test.use({ workerServerEnv: { HOME: ISOLATED_HOME } });

// The row's own label is translated, so the control this test drives renames
// itself as a side effect of the thing under test. Matching all four keeps the
// locator valid whichever language the previous test left behind.
const TRIGGER_NAME = /Language|Idioma|语言|언어/;

// The language names are endonyms and read the same in every locale; the
// sentinel is ordinary copy and does not.
const SYSTEM_OPTION = /^(System|Sistema|跟随系统|시스템)$/;

async function openLanguagePicker(page: Page) {
  await page.goto('/#settings');
  await expect(page.getByTestId('settings-dialog')).toBeVisible({ timeout: 10_000 });
  const trigger = page.getByRole('combobox', { name: TRIGGER_NAME });
  await expect(trigger).toBeVisible({ timeout: 10_000 });
  await trigger.click();
  await expect(page.getByRole('listbox')).toBeVisible();
  return trigger;
}

test.describe('language picker', () => {
  test('picking a language activates it and persists the choice', async ({ page }) => {
    // The whole file shares one server, and therefore one stored preference, so
    // each test drives itself to a known starting language rather than assuming
    // one — otherwise a retry would resume from the value its first attempt left.
    await openLanguagePicker(page);
    await page.getByRole('option', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en', { timeout: 10_000 });

    const trigger = await openLanguagePicker(page);
    await page.getByRole('option', { name: 'español' }).click();

    // Config round-trip plus a catalog chunk fetch, so `lang` is the far end of
    // the whole chain rather than an optimistic paint.
    await expect(page.locator('html')).toHaveAttribute('lang', 'es', { timeout: 10_000 });
    await expect(trigger).toHaveText('español');

    // The far end of the chain: the words themselves. `lang` alone would still
    // be right if the catalog never loaded.
    await expect(page.getByRole('button', { name: 'Preferencias' })).toBeVisible({
      timeout: 10_000,
    });

    // A reload proves the preference reached disk rather than living in the tab.
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'es', { timeout: 10_000 });
  });

  test('picking Korean activates it and persists the choice', async ({ page }) => {
    // Normalize through English first: the picker label is translated, so this
    // keeps the endonym selection independent of the preference left by a prior
    // test or retry.
    await openLanguagePicker(page);
    await page.getByRole('option', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en', { timeout: 10_000 });

    const trigger = await openLanguagePicker(page);
    await page.getByRole('option', { name: '한국어' }).click();

    await expect(page.locator('html')).toHaveAttribute('lang', 'ko', { timeout: 10_000 });
    await expect(trigger).toHaveText('한국어');
    await expect(page.getByRole('button', { name: '환경설정' })).toBeVisible({
      timeout: 10_000,
    });

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko', { timeout: 10_000 });
  });

  test('picking System hands the language back to the browser', async ({ page }) => {
    await openLanguagePicker(page);
    await page.getByRole('option', { name: '简体中文' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans', { timeout: 10_000 });

    const trigger = await openLanguagePicker(page);
    await page.getByRole('option', { name: SYSTEM_OPTION }).click();

    await expect(page.locator('html')).toHaveAttribute('lang', 'en', { timeout: 10_000 });
    await expect(trigger).toHaveText('System');
  });

  // The literal list is the point: it is what a user sees, spelled the way they
  // see it, and it is the one place a promotion has to be stated rather than
  // derived. Deriving the names from `Intl.DisplayNames` here would only agree
  // with the component for the same reason, and say nothing.
  test('offers every locale whose layout is finished, each named in itself', async ({ page }) => {
    // Drive to English first: the sentinel's label is translated, so the exact
    // list below only holds in one locale and this test would otherwise pass or
    // fail on whatever the test before it left stored.
    await openLanguagePicker(page);
    await page.getByRole('option', { name: SYSTEM_OPTION }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en', { timeout: 10_000 });

    await openLanguagePicker(page);
    // `ar` and `ur` are absent: enumerated, complete, and held back until the
    // chrome lays out right to left.
    await expect(page.getByRole('option')).toHaveText([
      'System',
      'English',
      '简体中文',
      '繁體中文',
      'हिन्दी',
      'español',
      'français',
      'বাংলা',
      'português (Brasil)',
      'Indonesia',
      '한국어',
    ]);
  });
});
