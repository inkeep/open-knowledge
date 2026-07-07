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
 * Click the sidebar's empty filler below the sections — the deselect-to-root hit
 * target. The file tree is sized flush to its rows (no empty space of its own),
 * so the leftover sidebar space below Files + Skills owns this gesture.
 */
async function clickEmptyTreeArea(page: Page): Promise<void> {
  const filler = page.locator('[data-sidebar-empty-deselect]');
  await expect(filler).toBeVisible();
  const box = await filler.boundingBox();
  if (!box) throw new Error('sidebar deselect filler has no bounding box');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
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
  // prior spec's docs pile up in this worker's tree. A full tree fills the
  // sidebar and shrinks the empty deselect filler to nothing (it flex-grows only
  // into leftover space), pushing `clickEmptyTreeArea`'s target out of view.
  // Start each test from the boot-seeded baseline instead.
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
