/**
 * Clicking the file tree's empty space "deselects" the active item *for
 * creation purposes*: New File / New Folder then land at the project root,
 * while the editor keeps showing whatever was open (the main view is
 * untouched). Selecting a row — or navigating elsewhere — re-couples creation
 * to the active item.
 *
 * Drives the real browser path: open a nested doc (so the create target is its
 * folder), click the empty tree area, and assert (a) the row deselects, (b) the
 * editor tab is unchanged, (c) a freshly created file lands at the root. A
 * contrast case pins the default — without the empty-space click, creation
 * still lands inside the active folder.
 */
import type { Page } from '@playwright/test';
import { expect, resetContentToFixtureBaseline, test } from './_helpers';

const SIDEBAR = '[data-slot="sidebar-container"]';
/**
 * Scoped to the Files collapsible on purpose: the Skills tree is also a Pierre
 * tree and carries the same `data-file-tree-virtualized-scroll` internally, so
 * the bare attribute names "a tree's scroll region", not "the file list's".
 * Only one is mounted at a time today, which makes the bare form correct by
 * luck rather than by construction. Skills renders no Collapsible, so this
 * ancestor is the file list's unambiguous handle.
 */
const TREE_SCROLL = '[data-slot="collapsible-content"] [data-file-tree-virtualized-scroll]';

/**
 * Click the empty area below the last row, inside the tree's own scroll region —
 * the deselect-to-root hit target. The pane fills the sidebar body, so a tree
 * shorter than the pane leaves clickable slack under its rows.
 *
 * Rows are absolutely positioned by the virtualizer, so DOM order is not visual
 * order — take the lowest row edge rather than the last row in the document.
 */
async function clickEmptyTreeArea(page: Page): Promise<void> {
  const scroll = page.locator(TREE_SCROLL);
  await expect(scroll).toBeVisible();
  const region = await scroll.evaluate((el) => {
    const scrollRect = el.getBoundingClientRect();
    const lowestRowBottom = Array.from(el.querySelectorAll('[data-item-path]')).reduce(
      (lowest, row) => Math.max(lowest, row.getBoundingClientRect().bottom),
      scrollRect.top,
    );
    return {
      x: scrollRect.left + scrollRect.width / 2,
      top: lowestRowBottom,
      bottom: scrollRect.bottom,
    };
  });
  const slack = region.bottom - region.top;
  if (slack < 4) {
    throw new Error(
      `no empty area below the last row to click (${slack}px) — the tree fills its pane`,
    );
  }
  await page.mouse.click(region.x, (region.top + region.bottom) / 2);
}

/**
 * Create a file through the sidebar's inline New File flow and return the
 * docName it landed at, read from the authoritative `/api/documents` listing.
 * The placeholder is created at the computed parent dir the instant New File is
 * clicked, so the rename only sets the leaf name.
 */
async function createFileAndGetDocName(
  page: Page,
  baseURL: string,
  name: string,
): Promise<string[]> {
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  const input = page.getByRole('textbox', { name: /rename Untitled\.md/i });
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.fill(name);
  await input.press('Enter');

  let names: string[] = [];
  await expect(async () => {
    const docs = await page.evaluate(async (url) => {
      const r = await fetch(`${url}/api/documents`);
      return r.ok ? await r.json() : null;
    }, baseURL);
    names = (docs?.documents ?? [])
      .map((d: { docName?: string; path?: string }) => d.docName ?? d.path ?? '')
      .filter(Boolean);
    expect(names.some((n) => n.endsWith(`/${name}`) || n === name)).toBe(true);
  }).toPass({ timeout: 15_000 });
  return names;
}

test.describe('file-tree deselect-to-root', () => {
  // The worker server is shared across the whole suite and `seedDocs`'
  // `testReset()` only clears the `test-doc` doc, so without this reset every
  // prior spec's docs pile up in this worker's tree. Enough rows fill the tree's
  // scroll region edge to edge, leaving no empty area below the last row for
  // `clickEmptyTreeArea` to aim at. Start each test from the boot-seeded
  // baseline instead.
  test.beforeEach(async ({ workerServer }) => {
    await resetContentToFixtureBaseline(workerServer.baseURL, workerServer.contentDir);
  });

  test('empty-space click deselects the row for creation but leaves the editor view', async ({
    page,
    api,
    workerServer,
  }) => {
    await api.seedDocs([
      { name: 'folder/note', markdown: '# Note\n' },
      { name: 'top', markdown: '# Top\n' },
    ]);

    // Open the nested doc → its folder becomes the create target and its row is
    // selected.
    await page.goto('/#/folder/note');
    const sidebar = page.locator(SIDEBAR);
    const selectedNote = sidebar.getByRole('treeitem', {
      name: 'note.md',
      exact: true,
      selected: true,
    });
    await expect(selectedNote).toBeVisible({ timeout: 20_000 });
    // The editor is showing the nested doc — the route is its hash.
    await expect(page).toHaveURL(/folder\/note$/, { timeout: 10_000 });

    // Click the row so the tree owns DOM focus — that is what paints Pierre's
    // focus ring (the lingering "blue outline" this guards). A programmatic
    // hash-nav open selects but never focuses the row.
    await selectedNote.click();
    const focusedRow = page.locator('[data-item-path="folder/note.md"][data-item-focused="true"]');
    await expect(focusedRow).toHaveCount(1, { timeout: 10_000 });
    // The ring is visible (a real, non-transparent color) before the deselect.
    const ringColorBefore = await focusedRow.evaluate((el) =>
      getComputedStyle(el).getPropertyValue('--trees-focus-ring-color').trim(),
    );
    expect(ringColorBefore).not.toBe('transparent');
    expect(ringColorBefore.length).toBeGreaterThan(0);

    await clickEmptyTreeArea(page);

    // The row is no longer selected …
    await expect(
      sidebar.getByRole('treeitem', { name: 'note.md', exact: true, selected: true }),
    ).toHaveCount(0, { timeout: 10_000 });
    // … and although Pierre keeps the row DOM-focused (roving focus), the focus
    // ring is neutralized — no lingering blue outline.
    await expect(async () => {
      const ringColorAfter = await page
        .locator('[data-item-path="folder/note.md"][data-item-focused="true"]')
        .evaluate((el) => getComputedStyle(el).getPropertyValue('--trees-focus-ring-color').trim());
      expect(ringColorAfter).toBe('transparent');
    }).toPass({ timeout: 10_000 });
    // … but the doc row is still present and the editor still shows it (the
    // route never changed — the empty-space click did not navigate).
    await expect(sidebar.getByRole('treeitem', { name: 'note.md', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/folder\/note$/);

    // New File now lands at the project root, not inside `folder/`.
    const names = await createFileAndGetDocName(page, workerServer.baseURL, 'created-at-root');
    expect(names).toContain('created-at-root');
    expect(names).not.toContain('folder/created-at-root');
  });

  test('without the empty-space click, New File still lands in the active folder', async ({
    page,
    api,
    workerServer,
  }) => {
    await api.seedDocs([
      { name: 'folder/note', markdown: '# Note\n' },
      { name: 'top', markdown: '# Top\n' },
    ]);

    await page.goto('/#/folder/note');
    const sidebar = page.locator(SIDEBAR);
    await expect(
      sidebar.getByRole('treeitem', { name: 'note.md', exact: true, selected: true }),
    ).toBeVisible({ timeout: 20_000 });

    // No empty-space click — creation should follow the active folder.
    const names = await createFileAndGetDocName(page, workerServer.baseURL, 'created-in-folder');
    expect(names).toContain('folder/created-in-folder');
    expect(names).not.toContain('created-in-folder');
  });
});
