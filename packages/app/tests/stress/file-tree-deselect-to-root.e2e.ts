import type { Page } from '@playwright/test';
import { expect, resetContentToFixtureBaseline, test } from './_helpers';

const SIDEBAR = '[data-slot="sidebar-container"]';
const TREE_SCROLL = '[data-slot="collapsible-content"] [data-file-tree-virtualized-scroll]';

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

    await page.goto('/#/folder/note');
    const sidebar = page.locator(SIDEBAR);
    const selectedNote = sidebar.getByRole('treeitem', {
      name: 'note.md',
      exact: true,
      selected: true,
    });
    await expect(selectedNote).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(/folder\/note$/, { timeout: 10_000 });

    await selectedNote.click();
    const focusedRow = page.locator('[data-item-path="folder/note.md"][data-item-focused="true"]');
    await expect(focusedRow).toHaveCount(1, { timeout: 10_000 });
    const ringColorBefore = await focusedRow.evaluate((el) =>
      getComputedStyle(el).getPropertyValue('--trees-focus-ring-color').trim(),
    );
    expect(ringColorBefore).not.toBe('transparent');
    expect(ringColorBefore.length).toBeGreaterThan(0);

    await clickEmptyTreeArea(page);

    await expect(
      sidebar.getByRole('treeitem', { name: 'note.md', exact: true, selected: true }),
    ).toHaveCount(0, { timeout: 10_000 });
    await expect(async () => {
      const ringColorAfter = await page
        .locator('[data-item-path="folder/note.md"][data-item-focused="true"]')
        .evaluate((el) => getComputedStyle(el).getPropertyValue('--trees-focus-ring-color').trim());
      expect(ringColorAfter).toBe('transparent');
    }).toPass({ timeout: 10_000 });
    await expect(sidebar.getByRole('treeitem', { name: 'note.md', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/folder\/note$/);

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

    const names = await createFileAndGetDocName(page, workerServer.baseURL, 'created-in-folder');
    expect(names).toContain('folder/created-in-folder');
    expect(names).not.toContain('created-in-folder');
  });
});
