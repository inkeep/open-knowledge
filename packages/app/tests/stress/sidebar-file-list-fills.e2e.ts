import type { Page } from '@playwright/test';
import { FILE_TREE_DENSITY_OPTIONS } from '../../src/components/file-tree-density';
import { expect, resetContentToFixtureBaseline, test } from './_helpers';

const SIDEBAR = '[data-slot="sidebar-container"]';
const FOOTER = '[data-slot="sidebar-footer"]';
const TREE_SCROLL =
  '[data-slot="sidebar-group"] [data-slot="collapsible-content"] [data-file-tree-virtualized-scroll]';

const ROW_HEIGHT = FILE_TREE_DENSITY_OPTIONS.itemHeight;

async function lowestRowBottom(page: Page): Promise<number> {
  return page
    .locator(TREE_SCROLL)
    .evaluate((el) =>
      Array.from(el.querySelectorAll('[data-item-path]')).reduce(
        (lowest, row) => Math.max(lowest, row.getBoundingClientRect().bottom),
        el.getBoundingClientRect().top,
      ),
    );
}

async function boxOf(page: Page, selector: string) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} has no bounding box`);
  return box;
}

test.describe('sidebar file list fills the body', () => {
  test.beforeEach(async ({ workerServer }) => {
    await resetContentToFixtureBaseline(workerServer.baseURL, workerServer.contentDir);
  });

  test('a short tree leaves its slack inside the scroll region, not below it', async ({
    page,
    api,
  }) => {
    await api.seedDocs([{ name: 'folder/note', markdown: '# Note\n' }]);
    await page.goto('/#/folder/note');
    await expect(page.locator(SIDEBAR).getByRole('treeitem', { name: 'note.md' })).toBeVisible({
      timeout: 20_000,
    });

    await expect(page.locator('[data-sidebar-empty-deselect]')).toHaveCount(0);

    const scroll = await boxOf(page, TREE_SCROLL);
    const dockCount = await page.getByTestId('skills-dock').count();
    const below = await boxOf(page, dockCount > 0 ? '[data-testid="skills-dock"]' : FOOTER);
    expect(below.y - (scroll.y + scroll.height)).toBeLessThan(ROW_HEIGHT);

    const slack = scroll.y + scroll.height - (await lowestRowBottom(page));
    expect(slack).toBeGreaterThan(ROW_HEIGHT);
  });

  test('a tree taller than the pane scrolls inside it rather than growing', async ({
    page,
    api,
  }) => {
    const names = Array.from({ length: 60 }, (_, i) => `bulk-${String(i).padStart(3, '0')}`);
    await api.seedDocs(names.map((name) => ({ name, markdown: `# ${name}\n` })));
    await page.goto('/#/bulk-000');

    const sidebar = page.locator(SIDEBAR);
    await expect(sidebar.getByRole('treeitem', { name: 'bulk-000.md' })).toBeVisible({
      timeout: 20_000,
    });

    await expect(async () => {
      const overflows = await page
        .locator(TREE_SCROLL)
        .evaluate((el) => el.scrollHeight > el.clientHeight);
      expect(overflows).toBe(true);
    }).toPass({ timeout: 15_000 });

    const scroll = await boxOf(page, TREE_SCROLL);
    const footer = await boxOf(page, FOOTER);
    expect(scroll.y + scroll.height).toBeLessThanOrEqual(footer.y + 1);
  });

  test('a tall Conflicts section cannot squeeze the file list away', async ({ page, api }) => {
    await page.route('**/api/sync/conflicts', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          conflicts: Array.from({ length: 25 }, (_, i) => ({
            file: `folder/conflicted-doc-number-${i}.md`,
            detectedAt: '2026-08-05T00:00:00.000Z',
          })),
        }),
      });
    });

    await api.seedDocs([{ name: 'folder/note', markdown: '# Note\n' }]);
    await page.goto('/#/folder/note');
    await expect(page.locator(SIDEBAR).getByRole('treeitem', { name: 'note.md' })).toBeVisible({
      timeout: 20_000,
    });

    await expect(async () => {
      const pane = await boxOf(page, TREE_SCROLL);
      expect(pane.height).toBeGreaterThan(ROW_HEIGHT * 4);
      const bodyScrolls = await page
        .locator('[data-slot="sidebar-content"]')
        .evaluate((el) => el.scrollHeight > el.clientHeight);
      expect(bodyScrolls).toBe(true);
    }).toPass({ timeout: 15_000 });
  });

  test('a round trip through Skills mode leaves the file list correctly sized', async ({
    page,
    api,
  }) => {
    await api.seedDocs([{ name: 'folder/note', markdown: '# Note\n' }]);
    await page.goto('/#/folder/note');
    await expect(page.locator(SIDEBAR).getByRole('treeitem', { name: 'note.md' })).toBeVisible({
      timeout: 20_000,
    });
    const before = await boxOf(page, TREE_SCROLL);

    const dock = page.getByTestId('skills-dock');
    const dockTrigger = dock.getByRole('button', { name: 'Skills Studio', exact: true });
    await dockTrigger.click();
    await expect(page.locator(TREE_SCROLL)).toHaveCount(1, { timeout: 10_000 });
    await dockTrigger.click();

    await expect(page.locator(SIDEBAR).getByRole('treeitem', { name: 'note.md' })).toBeVisible({
      timeout: 20_000,
    });
    const after = await boxOf(page, TREE_SCROLL);
    expect(Math.abs(after.height - before.height)).toBeLessThan(ROW_HEIGHT);
  });
});
