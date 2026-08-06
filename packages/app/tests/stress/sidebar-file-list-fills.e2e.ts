/**
 * The file list owns the sidebar body: it fills the space between the chrome row
 * and the footer rather than being sized to its own rows with a spacer beneath.
 *
 * Guards the layout half of the deselect-to-root gesture — that there IS empty
 * area under the last row to click. The gesture's behavior is covered by
 * `file-tree-deselect-to-root.e2e.ts`; this file only pins the geometry that
 * makes it reachable, plus the two states that geometry can regress in: a tree
 * longer than the pane, and a round trip through Skills mode.
 *
 * There is no visual-snapshot coverage of the sidebar, so these measurements are
 * the only automated guard on the result.
 */
import type { Page } from '@playwright/test';
import { FILE_TREE_DENSITY_OPTIONS } from '../../src/components/file-tree-density';
import { expect, resetContentToFixtureBaseline, test } from './_helpers';

const SIDEBAR = '[data-slot="sidebar-container"]';
const FOOTER = '[data-slot="sidebar-footer"]';
/**
 * Scoped to the Files collapsible on purpose: the Skills tree is also a Pierre
 * tree and carries the same `data-file-tree-virtualized-scroll` internally, so
 * the bare attribute matches whichever tree is mounted. Skills renders no
 * Collapsible, which makes this ancestor the file list's unique handle.
 */
const TREE_SCROLL = '[data-slot="collapsible-content"] [data-file-tree-virtualized-scroll]';

/**
 * The grid every row is placed on, read from the source rather than copied, so
 * a density change moves these tolerances with it. Two of the three uses below
 * are lower bounds (`slack > ROW_HEIGHT`, and the mode-switch height delta), and
 * a stale-smaller copy would quietly weaken them.
 */
const ROW_HEIGHT = FILE_TREE_DENSITY_OPTIONS.itemHeight;

/**
 * Bottom edge of the lowest rendered row. Rows are absolutely positioned by the
 * virtualizer, so DOM order is not visual order.
 */
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

    // The spacer that used to own this gesture is gone.
    await expect(page.locator('[data-sidebar-empty-deselect]')).toHaveCount(0);

    // The pane reaches the footer: whatever room is left over sits INSIDE the
    // scroll region (clickable) rather than as a gap beneath it. One row of
    // tolerance absorbs the sidebar's own padding.
    const scroll = await boxOf(page, TREE_SCROLL);
    const footer = await boxOf(page, FOOTER);
    expect(footer.y - (scroll.y + scroll.height)).toBeLessThan(ROW_HEIGHT);

    // And that leftover room is real — this is what the deselect click aims at.
    const slack = scroll.y + scroll.height - (await lowestRowBottom(page));
    expect(slack).toBeGreaterThan(ROW_HEIGHT);
  });

  test('a tree taller than the pane scrolls inside it rather than growing', async ({
    page,
    api,
  }) => {
    // Comfortably more rows than any plausible viewport holds.
    const names = Array.from({ length: 60 }, (_, i) => `bulk-${String(i).padStart(3, '0')}`);
    await api.seedDocs(names.map((name) => ({ name, markdown: `# ${name}\n` })));
    await page.goto('/#/bulk-000');

    const sidebar = page.locator(SIDEBAR);
    await expect(sidebar.getByRole('treeitem', { name: 'bulk-000.md' })).toBeVisible({
      timeout: 20_000,
    });

    // Gate on the overflow before measuring anything. `bulk-000.md` becoming
    // visible only means the listing started rendering — the virtualizer sizes
    // its scroll region across later frames, so reading geometry right after the
    // first row is a race, and an under-filled region reads as "does not
    // overflow" for reasons that have nothing to do with the layout.
    await expect(async () => {
      const overflows = await page
        .locator(TREE_SCROLL)
        .evaluate((el) => el.scrollHeight > el.clientHeight);
      expect(overflows).toBe(true);
    }).toPass({ timeout: 15_000 });

    // With the overflow established, the pane still sits inside the sidebar
    // rather than growing to fit the rows and pushing the footer off-screen —
    // the regression a plain `flex-1` without `min-h-0` in the chain produces.
    //
    // How many rows the region renders, and the Show All truncation affordance,
    // are the tree's own concern — covered by `FileTree.showall-*.dom.test.tsx`.
    const scroll = await boxOf(page, TREE_SCROLL);
    const footer = await boxOf(page, FOOTER);
    expect(scroll.y + scroll.height).toBeLessThanOrEqual(footer.y + 1);
  });

  test('a tall Conflicts section cannot squeeze the file list away', async ({ page, api }) => {
    // ConflictsSection is the one sibling that shares the sidebar body with the
    // file list. It renders one unbounded row per conflict with no cap and no
    // internal scroll, so it cannot yield space — which makes the file list the
    // only item the flex shrink algorithm can take from. Without the min-height
    // floor on the Files section, 15 conflicts left an 89px sliver here and 25
    // left nothing at all.
    //
    // Stubbed at the network boundary rather than seeded: conflicts come from
    // the sync engine's in-memory state, so there is no file to plant.
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
      // Several rows still visible, not a sliver and not zero.
      expect(pane.height).toBeGreaterThan(ROW_HEIGHT * 4);
      // And the overflow goes where it went before this change: the sidebar
      // body scrolls, rather than the file list absorbing all of it.
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

    // Skills replaces the file list entirely, then hands the body back.
    await page.getByTestId('sidebar-skills-toggle').click();
    await expect(page.locator(TREE_SCROLL)).toHaveCount(0, { timeout: 10_000 });
    await page.getByTestId('sidebar-files-toggle').click();

    await expect(page.locator(SIDEBAR).getByRole('treeitem', { name: 'note.md' })).toBeVisible({
      timeout: 20_000,
    });
    const after = await boxOf(page, TREE_SCROLL);
    expect(Math.abs(after.height - before.height)).toBeLessThan(ROW_HEIGHT);
  });
});
