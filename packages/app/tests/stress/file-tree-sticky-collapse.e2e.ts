import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

const CHILD_COUNT = 60;

function uniqueStamp(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e8).toString(36)}`;
}

const sidebar = (page: Page) => page.locator('[data-slot="sidebar-container"]');

const pinnedHeader = (page: Page) => sidebar(page).locator('[data-file-tree-sticky-row="true"]');

test('clicking a pinned folder header collapses the folder', async ({ page, api }) => {
  const folder = `sticky-collapse-${uniqueStamp()}`;

  await api.seedDocs(
    Array.from({ length: CHILD_COUNT }, (_, index) => ({
      name: `${folder}/child-${String(index).padStart(3, '0')}`,
      markdown: `# child ${index}\n`,
    })),
  );

  await page.goto(`/#/${folder}/`);
  await page.waitForLoadState('domcontentloaded');

  const folderRow = sidebar(page).getByRole('treeitem', { name: folder, exact: true });
  await expect(folderRow).toBeVisible({ timeout: 30_000 });

  if ((await folderRow.getAttribute('aria-expanded')) !== 'true') {
    await folderRow.focus();
    await folderRow.press('ArrowRight');
  }
  await expect(folderRow).toHaveAttribute('aria-expanded', 'true');

  await expect(async () => {
    await sidebar(page).hover();
    await page.mouse.wheel(0, 400);
    await expect(pinnedHeader(page)).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });

  await pinnedHeader(page).click();

  await expect(folderRow).toHaveAttribute('aria-expanded', 'false');
  await expect(pinnedHeader(page)).toHaveCount(0);
});
