import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced as waitForProvider } from './_helpers';

const sourceToggle = (page: Page) => page.getByRole('radio', { name: 'Markdown source' });
const visualToggle = (page: Page) => page.getByRole('radio', { name: 'Visual editor' });

test.describe('FR-7a: source-mode toggle disabled during disconnect', () => {
  let docName: string;

  test.beforeEach(async ({ page, api }) => {
    docName = `test-fr7a-${randomUUID().slice(0, 8)}`;
    await api.createPage(`${docName}.md`);
    await page.goto(`/#/${docName}`);
    await waitForProvider(page);
    await page.waitForSelector('.ProseMirror');
  });

  test('connected state: source toggle is interactive', async ({ page }) => {
    await expect(visualToggle(page)).toBeEnabled();
    await expect(sourceToggle(page)).toBeEnabled();
  });

  test('disconnected state: source toggle becomes disabled', async ({ page }) => {
    await page.evaluate(() => {
      window.__activeProvider?.disconnect();
    });

    await expect(sourceToggle(page)).toBeDisabled({ timeout: 15_000 });

    await expect(visualToggle(page)).toBeEnabled();
  });

  test('reconnect re-enables source toggle without page reload', async ({ page }) => {
    await expect(sourceToggle(page)).toBeEnabled();

    await page.evaluate(() => {
      window.__activeProvider?.disconnect();
    });
    await expect(sourceToggle(page)).toBeDisabled({ timeout: 15_000 });

    await page.evaluate(() => {
      window.__activeProvider?.connect();
    });

    await expect(sourceToggle(page)).toBeEnabled({ timeout: 30_000 });
  });

  test('disconnected state: tooltip text matches spec', async ({ page }) => {
    await page.evaluate(() => {
      window.__activeProvider?.disconnect();
    });
    await expect(sourceToggle(page)).toBeDisabled({ timeout: 15_000 });

    const toggleWrapper = sourceToggle(page).locator('..');
    await toggleWrapper.hover();

    const tooltipPattern = /Source mode requires a live connection/i;
    await expect(page.getByRole('tooltip').filter({ hasText: tooltipPattern })).toBeVisible({
      timeout: 5_000,
    });
  });
});
