import { expect, test } from './_helpers';

const SEED_DOCS = [{ name: 'note', markdown: '# note\n\nHello there.\n' }];

async function openPalette(page: import('@playwright/test').Page) {
  await page.keyboard.press('ControlOrMeta+k');
  const list = page.locator('[data-slot="command-list"]');
  await expect(list).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('[data-slot="command-input"]')).toBeFocused();
  return list;
}

test.describe('command-palette — menu-parity backfill (real cmdk)', () => {
  test('a backfilled toggle is search-only, renders in the real list, and dispatches to its handler', async ({
    page,
    api,
  }) => {
    await api.seedDocs(SEED_DOCS);
    await page.goto('/');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    const list = await openPalette(page);
    await expect(page.getByTestId('command-palette-toggle-sidebar')).toHaveCount(0);

    await page.keyboard.type('sidebar');
    const row = page.getByTestId('command-palette-toggle-sidebar');
    await expect(row).toBeVisible({ timeout: 5_000 });
    await expect(row).toContainText('Hide sidebar');

    await row.click();
    await expect(list).toBeHidden({ timeout: 5_000 });

    await openPalette(page);
    await page.keyboard.type('sidebar');
    const rowAfter = page.getByTestId('command-palette-toggle-sidebar');
    await expect(rowAfter).toBeVisible({ timeout: 5_000 });
    await expect(rowAfter).toContainText('Show sidebar');
  });

  test('a multi-word query admits a row whose terms are never adjacent', async ({ page, api }) => {
    await api.seedDocs(SEED_DOCS);
    await page.goto('/');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
    await openPalette(page);

    const row = page.getByTestId('command-palette-toggle-sidebar');
    const input = page.locator('[data-slot="command-input"]');

    const query = async (value: string) => {
      await input.fill(value);
      await expect(input).toHaveValue(value);
    };

    await query('sidebar');
    await expect(row).toBeVisible({ timeout: 5_000 });

    await query('toggle sidebar');
    await expect(row).toBeVisible({ timeout: 5_000 });

    await query('sidebar toggle');
    await expect(row).toBeVisible({ timeout: 5_000 });

    await query('sidebar zzzznomatch');
    await expect(row).toHaveCount(0);

    await query('sidebar');
    await expect(row).toBeVisible({ timeout: 5_000 });
  });
});
