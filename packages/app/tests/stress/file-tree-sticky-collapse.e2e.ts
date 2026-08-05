/**
 * Pinned folder header — click to collapse (composition boundary).
 *
 * The DOM suite (`FileTree.preview-tabs.dom.test.tsx`) pins the app-side half
 * against a stubbed Pierre tree: the click-capture handler must stay out of the
 * way on a pinned row. Everything the fix then leans on lives in the real tree
 * and no stub can produce it — the pinned overlay only exists once a real
 * virtualized list scrolls, and the collapse plus canonical-row reveal are the
 * library's own sticky click plan. This file covers that gesture end to end.
 */

import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

/**
 * Children seeded under the fixture folder. The sidebar shows roughly 21 rows
 * at the 26px row height in the 720px-tall viewport, so this leaves the folder
 * header well above the fold once the list is scrolled.
 */
const CHILD_COUNT = 60;

function uniqueStamp(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e8).toString(36)}`;
}

const sidebar = (page: Page) => page.locator('[data-slot="sidebar-container"]');

/**
 * The pinned overlay row. Pierre renders it without `role="treeitem"`, so it
 * never collides with the canonical row's locator even while both are mounted.
 */
const pinnedHeader = (page: Page) => sidebar(page).locator('[data-file-tree-sticky-row="true"]');

test('clicking a pinned folder header collapses the folder', async ({ page, api }) => {
  const folder = `sticky-collapse-${uniqueStamp()}`;

  await api.seedDocs(
    Array.from({ length: CHILD_COUNT }, (_, index) => ({
      name: `${folder}/child-${String(index).padStart(3, '0')}`,
      markdown: `# child ${index}\n`,
    })),
  );

  // Navigating into the folder reveals its row regardless of what earlier
  // specs left in this worker's content tree.
  await page.goto(`/#/${folder}/`);
  await page.waitForLoadState('domcontentloaded');

  const folderRow = sidebar(page).getByRole('treeitem', { name: folder, exact: true });
  await expect(folderRow).toBeVisible({ timeout: 30_000 });

  // Row CLICK navigates to the folder route; ArrowRight is the expand gesture.
  if ((await folderRow.getAttribute('aria-expanded')) !== 'true') {
    await folderRow.focus();
    await folderRow.press('ArrowRight');
  }
  await expect(folderRow).toHaveAttribute('aria-expanded', 'true');

  // Scroll down through the children until the header pins to the top. The
  // overlay only mounts above a non-zero scrollTop, and how far that takes
  // depends on what else the worker's tree holds, so wheel until it appears.
  await expect(async () => {
    await sidebar(page).hover();
    await page.mouse.wheel(0, 400);
    await expect(pinnedHeader(page)).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });

  await pinnedHeader(page).click();

  // Pierre's sticky click plan: collapse the directory, then reveal the
  // canonical row. Collapsed, there is nothing left to pin.
  await expect(folderRow).toHaveAttribute('aria-expanded', 'false');
  await expect(pinnedHeader(page)).toHaveCount(0);
});
