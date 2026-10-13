import type { Page } from '@playwright/test';
import { expect, servedModuleRoute, servedModuleUrl, test } from './_helpers';

const REQUESTED = 'es';

const CATALOG_SOURCE = `src/locales/${REQUESTED}/messages.json`;

async function withholdCatalog(page: Page): Promise<{ release: () => Promise<void> }> {
  await page.route(servedModuleRoute(CATALOG_SOURCE), (route) => route.abort('failed'));
  return {
    release: async () => {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
    },
  };
}

const reloadAction = (page: Page) => page.getByRole('button', { name: 'Reload' });

test.describe('a locale catalog that cannot be fetched', () => {
  test.use({ locale: 'es-ES' });

  test('leaves the app readable and offers a way to retry', async ({ page }) => {
    await withholdCatalog(page);
    await page.goto('/');

    await expect(reloadAction(page)).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });

  test('the offered retry completes the switch once the catalog can be fetched', async ({
    page,
  }) => {
    const withheld = await withholdCatalog(page);
    await page.goto('/');
    await expect(reloadAction(page)).toBeVisible();

    await withheld.release();
    await reloadAction(page).click();

    await expect(page.locator('html')).toHaveAttribute('lang', REQUESTED);
    await expect(reloadAction(page)).toBeHidden();
  });

  test('retrying in place would not have worked, which is why it reloads', async ({ page }) => {
    const withheld = await withholdCatalog(page);
    await page.goto('/');
    await expect(reloadAction(page)).toBeVisible();
    await withheld.release();

    const outcome = await page.evaluate(async (url) => {
      const refetched = await fetch(url);
      try {
        await import(url);
        return { refetched: refetched.status, reimported: 'resolved' };
      } catch {
        return { refetched: refetched.status, reimported: 'rejected' };
      }
    }, servedModuleUrl(CATALOG_SOURCE));

    expect(outcome).toEqual({ refetched: 200, reimported: 'rejected' });
  });
});
