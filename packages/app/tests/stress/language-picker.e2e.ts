import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, SETTINGS_PANEL_TIMEOUT_MS, test } from './_helpers';

const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'ok-language-home-'));

test.use({ workerServerEnv: { HOME: ISOLATED_HOME } });

const TRIGGER_NAME = /Language|Idioma|语言|언어/;

const SYSTEM_OPTION = /^(System|Sistema|跟随系统|시스템)$/;

async function openLanguagePicker(page: Page) {
  await page.goto('/#settings');
  await expect(page.getByTestId('settings-dialog')).toBeVisible({ timeout: 10_000 });
  const trigger = page.getByRole('combobox', { name: TRIGGER_NAME });
  await expect(trigger).toBeVisible({ timeout: SETTINGS_PANEL_TIMEOUT_MS });
  await trigger.click();
  await expect(page.getByRole('listbox')).toBeVisible();
  return trigger;
}

test.describe('language picker', () => {
  test('picking a language activates it and persists the choice', async ({ page }) => {
    await openLanguagePicker(page);
    await page.getByRole('option', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en', { timeout: 10_000 });

    const trigger = await openLanguagePicker(page);
    await page.getByRole('option', { name: 'español' }).click();

    await expect(page.locator('html')).toHaveAttribute('lang', 'es', { timeout: 10_000 });
    await expect(trigger).toHaveText('español');

    await expect(page.getByTestId('settings-sidebar-item-preferences')).toHaveText('Preferencias', {
      timeout: 10_000,
    });

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'es', { timeout: 10_000 });
  });

  test('picking Korean activates it and persists the choice', async ({ page }) => {
    await openLanguagePicker(page);
    await page.getByRole('option', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en', { timeout: 10_000 });

    const trigger = await openLanguagePicker(page);
    await page.getByRole('option', { name: '한국어' }).click();

    await expect(page.locator('html')).toHaveAttribute('lang', 'ko', { timeout: 10_000 });
    await expect(trigger).toHaveText('한국어');
    await expect(page.getByTestId('settings-sidebar-item-preferences')).toHaveText('환경설정', {
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

  test('offers every locale whose layout is finished, each named in itself', async ({ page }) => {
    await openLanguagePicker(page);
    await page.getByRole('option', { name: SYSTEM_OPTION }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en', { timeout: 10_000 });

    await openLanguagePicker(page);
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
