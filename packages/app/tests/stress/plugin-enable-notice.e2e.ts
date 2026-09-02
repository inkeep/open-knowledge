import type { Page } from '@playwright/test';
import { expect, setPluginEnabled, test, waitForSettingsPanel } from './_helpers';

async function openProjectPluginsViaHashPush(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate(() => {
    window.location.hash = '#settings/plugins-manage';
  });

  await waitForSettingsPanel(page, 'settings-plugins-manage');
}

test.setTimeout(180_000);

test.describe('plugin enable → settings notice', () => {
  test.afterEach(async ({ page }) => {
    await openProjectPluginsViaHashPush(page);
    await setPluginEnabled(page, 'markdownlint', false);
  });

  test('the enable notice is clickable under the modal dialog and lands on the plugin panel', async ({
    page,
  }) => {
    await openProjectPluginsViaHashPush(page);
    await setPluginEnabled(page, 'markdownlint', false);

    await setPluginEnabled(page, 'markdownlint', true);

    const notice = page.locator('[data-sonner-toast]').filter({ hasText: 'markdownlint enabled' });
    await expect(notice).toBeVisible({ timeout: 5_000 });
    const openSettings = notice.getByRole('button', { name: 'Open settings' });
    await expect(openSettings).toBeVisible();

    await openSettings.click();

    await expect(page.getByTestId('settings-dialog')).toBeVisible();
    await expect(page.getByTestId('settings-plugin-markdownlint')).toBeVisible({ timeout: 5_000 });
    expect(await page.evaluate(() => window.location.hash)).toBe('#settings/plugin:markdownlint');
  });

  test('the notice still lands the user on the panel after Settings is closed', async ({
    page,
  }) => {
    await openProjectPluginsViaHashPush(page);
    await setPluginEnabled(page, 'markdownlint', false);

    await setPluginEnabled(page, 'markdownlint', true);
    const notice = page.locator('[data-sonner-toast]').filter({ hasText: 'markdownlint enabled' });
    await expect(notice).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-dialog')).toHaveCount(0, { timeout: 5_000 });

    await notice.getByRole('button', { name: 'Open settings' }).click();

    await expect(page.getByTestId('settings-dialog')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('settings-plugin-markdownlint')).toBeVisible({ timeout: 5_000 });
  });

  test('each plugin panel links its docs', async ({ page }) => {
    await openProjectPluginsViaHashPush(page);
    await setPluginEnabled(page, 'markdownlint', true);

    const pluginItem = page.getByTestId('settings-sidebar-item-plugin:markdownlint');
    await expect(pluginItem).toBeVisible({ timeout: 15_000 });
    await pluginItem.click();
    const docs = page.getByTestId('settings-plugin-markdownlint-title-docs-link');
    await expect(docs).toBeVisible({ timeout: 5_000 });
    await expect(docs).toHaveAttribute(
      'href',
      'https://openknowledge.ai/docs/advanced/content-rules/markdownlint',
    );
  });
});

test.describe('plugin enable notice — repeat use while Settings is open', () => {
  test.afterEach(async ({ page }) => {
    await openProjectPluginsViaHashPush(page);
    await setPluginEnabled(page, 'markdownlint', false);
  });

  test('one Escape closes Settings after the notice navigated in-dialog', async ({ page }) => {
    await openProjectPluginsViaHashPush(page);
    await setPluginEnabled(page, 'markdownlint', false);
    await setPluginEnabled(page, 'markdownlint', true);

    const notice = page.locator('[data-sonner-toast]').filter({ hasText: 'markdownlint enabled' });
    await notice.getByRole('button', { name: 'Open settings' }).click();
    await expect(page.getByTestId('settings-plugin-markdownlint')).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings-dialog')).toHaveCount(0, { timeout: 5_000 });
  });
});
