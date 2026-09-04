import { readdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

async function deletePathIfExists(baseURL: string, kind: 'file' | 'folder', path: string) {
  const response = await fetch(`${baseURL}/api/delete-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, path }),
  });
  if (response.ok || response.status === 404) return;
  throw new Error(`delete-path failed for ${kind}:${path}: ${response.status}`);
}

async function clearVisibleContentEntries(baseURL: string, contentDir: string): Promise<void> {
  for (const entry of readdirSync(contentDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      await deletePathIfExists(baseURL, 'folder', entry.name);
      continue;
    }
    const docPath = entry.name.replace(/\.(md|mdx)$/i, '');
    if (docPath !== entry.name) {
      await deletePathIfExists(baseURL, 'file', docPath);
    }
  }
}

test.beforeEach(async ({ api, workerServer }) => {
  await clearVisibleContentEntries(workerServer.baseURL, workerServer.contentDir);
  const folderResponse = await fetch(`${workerServer.baseURL}/api/create-folder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'sidebar-folder' }),
  });
  if (!folderResponse.ok && folderResponse.status !== 409) {
    throw new Error(`create-folder failed for sidebar-folder: ${folderResponse.status}`);
  }
  await api.createPage('test-doc.md');
  await api.createPage('sidebar-folder/nested-doc.md');
});

const sidebar = (page: Page) => page.locator('[data-slot="sidebar-container"]');
const fileRow = (page: Page, fileName: string) =>
  sidebar(page).getByRole('treeitem', { name: fileName, exact: true });
const folderRow = (page: Page) =>
  sidebar(page).getByRole('treeitem', { name: 'sidebar-folder', exact: true });
const selectedRow = (page: Page) => sidebar(page).locator('[aria-selected="true"]');

async function gotoAndAwaitTree(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState('domcontentloaded');
  await expect(sidebar(page).getByRole('treeitem').first()).toBeVisible({ timeout: 30_000 });
}

async function expandFolder(page: Page) {
  await folderRow(page).focus();
  await folderRow(page).press('ArrowRight');
}

async function collapseFolder(page: Page) {
  await folderRow(page).focus();
  await folderRow(page).press('ArrowLeft');
}

test('direct URL load reveals nested doc on first paint', async ({ page }) => {
  await gotoAndAwaitTree(page, `/#/sidebar-folder/nested-doc`);
  await fileRow(page, 'nested-doc.md').waitFor({ state: 'visible', timeout: 15_000 });

  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'true');

  await expect(selectedRow(page)).toHaveCount(1);
  await expect(selectedRow(page)).toHaveAttribute('aria-label', 'nested-doc.md');
});

test('hash navigation reveals nested doc (simulates graph/wikilink click)', async ({ page }) => {
  await gotoAndAwaitTree(page, '/');
  await fileRow(page, 'test-doc.md').click({ timeout: 10_000 });

  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'false');

  await page.evaluate(() => {
    window.location.hash = '#/sidebar-folder/nested-doc';
  });

  await fileRow(page, 'nested-doc.md').waitFor({ state: 'visible', timeout: 10_000 });
  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'true');

  await expect(selectedRow(page)).toHaveCount(1);
  await expect(selectedRow(page)).toHaveAttribute('aria-label', 'nested-doc.md');
});

test('active-doc ancestor stays expanded despite chevron clicks (Model A ancestor priority)', async ({
  page,
}) => {
  await gotoAndAwaitTree(page, `/#/sidebar-folder/nested-doc`);
  await fileRow(page, 'nested-doc.md').waitFor({ state: 'visible', timeout: 15_000 });

  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'true');

  await collapseFolder(page);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let frames = 5;
        const tick = () => {
          if (--frames <= 0) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(fileRow(page, 'nested-doc.md')).toBeVisible();
});

declare global {
  interface Window {
    __ariaFlippedToTrue?: boolean;
    __ariaObsCleanup?: () => void;
  }
}

test('activation auto-expands prior-collapsed non-ancestor folder (D1)', async ({ page }) => {
  await gotoAndAwaitTree(page, `/#/test-doc`);
  await fileRow(page, 'test-doc.md').waitFor({ state: 'visible', timeout: 15_000 });

  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'false');
  await expandFolder(page);
  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'true');
  await collapseFolder(page);
  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'false');

  await page.evaluate(() => {
    window.location.hash = '#/sidebar-folder/nested-doc';
  });
  await fileRow(page, 'nested-doc.md').waitFor({ state: 'visible', timeout: 10_000 });
  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'true');
});

test('user-expanded non-ancestor folder persists across navigation (D4)', async ({ page }) => {
  await gotoAndAwaitTree(page, `/#/test-doc`);
  await fileRow(page, 'test-doc.md').waitFor({ state: 'visible', timeout: 15_000 });

  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'false');
  await expandFolder(page);
  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'true');

  await page.evaluate(() => {
    window.location.hash = '#/sidebar-folder/nested-doc';
  });
  await fileRow(page, 'nested-doc.md').waitFor({ state: 'visible', timeout: 10_000 });
  await page.evaluate(() => {
    window.location.hash = '#/test-doc';
  });
  await fileRow(page, 'test-doc.md').waitFor({ state: 'visible', timeout: 10_000 });

  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'true');
});

test('exactly one selected row, matching activeDocName (D9)', async ({ page }) => {
  await gotoAndAwaitTree(page, `/#/sidebar-folder/nested-doc`);
  await fileRow(page, 'nested-doc.md').waitFor({ state: 'visible', timeout: 15_000 });

  await expect(selectedRow(page)).toHaveCount(1);
  await expect(selectedRow(page)).toHaveAttribute('aria-label', 'nested-doc.md');

  await page.evaluate(() => {
    window.location.hash = '#/test-doc';
  });
  await fileRow(page, 'test-doc.md').waitFor({ state: 'visible', timeout: 10_000 });

  await expect(selectedRow(page)).toHaveCount(1);
  await expect(selectedRow(page)).toHaveAttribute('aria-label', 'test-doc.md');
});

test('activation does not steal focus from the editor', async ({ page }) => {
  await gotoAndAwaitTree(page, `/#/test-doc`);
  await fileRow(page, 'test-doc.md').waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)', { timeout: 15_000 });

  await page.locator('.ProseMirror:not(.composer-prosemirror)').focus();
  const editorFocused = await page.evaluate(() =>
    document.activeElement?.classList.contains('ProseMirror'),
  );
  expect(editorFocused).toBe(true);

  await page.evaluate(() => {
    window.location.hash = '#/sidebar-folder/nested-doc';
  });
  await fileRow(page, 'nested-doc.md').waitFor({ state: 'visible', timeout: 10_000 });

  const focusInSidebar = await page.evaluate(() => {
    const active = document.activeElement;
    return !!active?.closest('[data-slot="sidebar-container"]');
  });
  expect(focusInSidebar).toBe(false);
});

test('hovering a sidebar row surfaces its full relative path as a title (VS Code parity)', async ({
  page,
}) => {
  await gotoAndAwaitTree(page, `/#/sidebar-folder/nested-doc`);
  await fileRow(page, 'nested-doc.md').waitFor({ state: 'visible', timeout: 15_000 });
  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'true');

  await fileRow(page, 'nested-doc.md').hover();
  await expect(fileRow(page, 'nested-doc.md')).toHaveAttribute(
    'title',
    'sidebar-folder/nested-doc.md',
  );

  await folderRow(page).hover();
  await expect(folderRow(page)).toHaveAttribute('title', 'sidebar-folder');
});

test('sidebar full-path title is eager (no hover needed) and reaches the floating action overlay', async ({
  page,
}) => {
  await gotoAndAwaitTree(page, `/#/sidebar-folder/nested-doc`);
  await fileRow(page, 'nested-doc.md').waitFor({ state: 'visible', timeout: 15_000 });
  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'true');

  await expect(fileRow(page, 'nested-doc.md')).toHaveAttribute(
    'title',
    'sidebar-folder/nested-doc.md',
  );
  await expect(folderRow(page)).toHaveAttribute('title', 'sidebar-folder');
  await expect(fileRow(page, 'test-doc.md')).toHaveAttribute('title', 'test-doc.md');

  const contextMenuAnchor = sidebar(page).locator('[data-type="context-menu-anchor"]');
  await folderRow(page).hover();
  await expect(contextMenuAnchor).toHaveAttribute('title', 'sidebar-folder');
  await fileRow(page, 'nested-doc.md').hover();
  await expect(contextMenuAnchor).toHaveAttribute('title', 'sidebar-folder/nested-doc.md');
});
