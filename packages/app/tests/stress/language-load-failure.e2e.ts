/**
 * A locale catalog that genuinely fails to arrive, in a real browser.
 *
 * `src/lib/use-apply-config-language-load-failure.dom.test.tsx` covers what the
 * app does about it. Two things only a browser shows, and both are why this
 * file exists:
 *
 *   - the thing being refused is a real network fetch of a real separate file,
 *     where a test runner resolves modules its own way;
 *   - a document that has failed to fetch a module keeps refusing that URL from
 *     memory, so the offered retry has to be a reload. Nothing short of a real
 *     page can demonstrate either half of that.
 *
 * The switch is driven by the browser's own language rather than by a setting,
 * because a boot into a non-English locale is a switch like any other and needs
 * no UI that does not exist yet.
 *
 * Implementation under test:
 *   - packages/app/src/lib/activate-locale.ts
 *   - packages/app/src/lib/use-apply-config-language.ts
 *   - packages/app/src/lib/locale-load-failure-notice.ts
 */

import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

/** The language the browser asks for, and whose catalog these tests control. */
const REQUESTED = 'es';

const CATALOG_ROUTE = `**/locales/${REQUESTED}/messages.json*`;

/** Refuse the catalog until the returned `release` is called. */
async function withholdCatalog(page: Page): Promise<{ release: () => Promise<void> }> {
  await page.route(CATALOG_ROUTE, (route) => route.abort('failed'));
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
    // Still the language it booted in: nothing half-applied, nothing blank.
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
    // The load-bearing browser fact behind the choice of action. If a future
    // engine stops remembering failed module fetches, this goes red and the
    // notice can go back to switching in place.
    const withheld = await withholdCatalog(page);
    await page.goto('/');
    await expect(reloadAction(page)).toBeVisible();
    await withheld.release();

    const outcome = await page.evaluate(async () => {
      const url = '/src/locales/es/messages.json?import';
      const refetched = await fetch(url);
      try {
        await import(/* @vite-ignore */ url);
        return { refetched: refetched.status, reimported: 'resolved' };
      } catch {
        return { refetched: refetched.status, reimported: 'rejected' };
      }
    });

    // The network is fine and the module still will not load.
    expect(outcome).toEqual({ refetched: 200, reimported: 'rejected' });
  });
});
