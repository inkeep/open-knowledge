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

test.describe('command-palette — selection follows the query (real cmdk)', () => {
  test('a query that ranks a better row above the still-matching selection moves the selection to the top', async ({
    page,
    api,
  }) => {
    await api.seedDocs(SEED_DOCS);
    await page.goto('/');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    const list = await openPalette(page);
    const input = page.locator('[data-slot="command-input"]');
    const sidebarRow = page.getByTestId('command-palette-toggle-sidebar');

    await input.fill('sidebar');
    await expect(list.locator('[cmdk-item]').first()).toHaveAttribute(
      'data-testid',
      'command-palette-toggle-sidebar',
    );
    await expect(sidebarRow).toHaveAttribute('aria-selected', 'true');

    await input.fill('show');
    await expect(sidebarRow).toBeVisible({ timeout: 5_000 });
    const topRow = list.locator('[cmdk-item]').first();
    await expect(topRow).not.toHaveAttribute('data-testid', 'command-palette-toggle-sidebar');
    await expect(topRow).toHaveAttribute('aria-selected', 'true');
    await expect(sidebarRow).toHaveAttribute('aria-selected', 'false');
    await expect(input).toHaveAttribute(
      'aria-activedescendant',
      (await topRow.getAttribute('id')) ?? '',
    );
  });

  test('typing a query that hides the selected row selects the first remaining row, and Enter runs it', async ({
    page,
    api,
  }) => {
    await api.seedDocs(SEED_DOCS);
    await page.goto('/');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    const list = await openPalette(page);
    const firstRow = list.locator('[cmdk-item]').first();
    await expect(firstRow).toHaveAttribute('aria-selected', 'true');
    const firstRowTestId = await firstRow.getAttribute('data-testid');
    expect(firstRowTestId).not.toBe('command-palette-toggle-sidebar');

    await page.keyboard.type('sidebar');
    const row = page.getByTestId('command-palette-toggle-sidebar');
    await expect(row).toContainText('Hide sidebar', { timeout: 5_000 });
    await expect(list.locator(`[data-testid="${firstRowTestId}"]`)).toHaveCount(0);
    await expect(list.locator('[cmdk-item]').first()).toHaveAttribute(
      'data-testid',
      'command-palette-toggle-sidebar',
    );
    await expect(row).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('Enter');
    await expect(list).toBeHidden({ timeout: 5_000 });

    await openPalette(page);
    await page.keyboard.type('sidebar');
    await expect(page.getByTestId('command-palette-toggle-sidebar')).toContainText('Show sidebar', {
      timeout: 5_000,
    });
  });
});
