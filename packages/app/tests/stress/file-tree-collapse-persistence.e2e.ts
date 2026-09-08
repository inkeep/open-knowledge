import type { Locator, Page } from '@playwright/test';
import { expect, test } from './_helpers';

function uniqueStamp(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e8).toString(36)}`;
}

const sidebar = (page: Page) => page.locator('[data-slot="sidebar-container"]');

const treeRow = (page: Page, name: string): Locator =>
  sidebar(page).getByRole('treeitem', { name, exact: true });

async function expandWithKeyboard(row: Locator): Promise<void> {
  await row.focus();
  await row.press('ArrowRight');
}

async function collapseWithKeyboard(row: Locator): Promise<void> {
  await row.focus();
  await row.press('ArrowLeft');
}

test('a collapsed folder stays collapsed when an unrelated folder is expanded', async ({
  page,
  api,
}) => {
  const stamp = uniqueStamp();
  const outer = `collapse-persist-outer-${stamp}`;
  const inner = `collapse-persist-inner-${stamp}`;
  const unrelated = `collapse-persist-other-${stamp}`;

  await api.seedDocs([
    { name: `${outer}/${inner}/leaf`, markdown: '# leaf\n' },
    { name: `${unrelated}/other`, markdown: '# other\n' },
  ]);

  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');

  const outerRow = treeRow(page, outer);
  await expect(outerRow).toBeVisible({ timeout: 30_000 });

  await expandWithKeyboard(outerRow);
  const innerRow = treeRow(page, inner);
  await expect(innerRow).toBeVisible({ timeout: 15_000 });

  await expandWithKeyboard(innerRow);
  await expect(treeRow(page, 'leaf.md')).toBeVisible({ timeout: 15_000 });

  await collapseWithKeyboard(outerRow);
  await expect(outerRow).toHaveAttribute('aria-expanded', 'false');
  await expect(treeRow(page, 'leaf.md')).toBeHidden();

  const unrelatedRow = treeRow(page, unrelated);
  await expandWithKeyboard(unrelatedRow);
  await expect(treeRow(page, 'other.md')).toBeVisible({ timeout: 15_000 });

  await expect(outerRow).toHaveAttribute('aria-expanded', 'false');
  await expect(treeRow(page, 'leaf.md')).toBeHidden();
});
