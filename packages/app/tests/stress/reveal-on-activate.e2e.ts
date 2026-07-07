// These tests assert sidebar UI state only. They keep their worker content tree
// small because the sidebar can contain documents left by earlier specs in the
// same worker, and these assertions need the fixture rows to be visible without
// depending on that incidental ordering.
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

async function expandFolder(page: Page) {
  await folderRow(page).focus();
  await folderRow(page).press('ArrowRight');
}

async function collapseFolder(page: Page) {
  await folderRow(page).focus();
  await folderRow(page).press('ArrowLeft');
}

test('direct URL load reveals nested doc on first paint', async ({ page }) => {
  await page.goto(`/#/sidebar-folder/nested-doc`);
  await fileRow(page, 'nested-doc.md').waitFor({ state: 'visible', timeout: 15_000 });

  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'true');

  await expect(selectedRow(page)).toHaveCount(1);
  await expect(selectedRow(page)).toHaveAttribute('aria-label', 'nested-doc.md');
});

test('hash navigation reveals nested doc (simulates graph/wikilink click)', async ({ page }) => {
  await page.goto('/');
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
  // Contract: ancestors of the active doc are UNCONDITIONALLY
  // expanded. Clicking the collapse chevron on an active-doc-ancestor is a
  // no-op for the derived expansion state — userCollapsed is set but the
  // derivation (`ancestors ∪ (userExpanded \ userCollapsed)`) re-adds the
  // ancestor. This matches VS Code / Finder: active file's context is
  // always visible.
  await page.goto(`/#/sidebar-folder/nested-doc`);
  await fileRow(page, 'nested-doc.md').waitFor({ state: 'visible', timeout: 15_000 });

  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'true');

  // Collapse the row. Under Model A ancestor priority, the folder stays
  // expanded because it's the active doc's ancestor.
  await collapseFolder(page);
  // Yield a few frames so any state flip would have committed.
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
  // Folder remains expanded; nested-doc.md still visible in sidebar.
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
  // Under Model A ancestor priority, user-collapse is only honored for
  // non-ancestor folders. This test verifies: user collapses folder while
  // it's NOT an active-doc ancestor, then navigates INTO the folder —
  // activation wins, folder expands automatically.
  await page.goto(`/#/test-doc`);
  await fileRow(page, 'test-doc.md').waitFor({ state: 'visible', timeout: 15_000 });

  // While test-doc is active (sidebar-folder is NOT an ancestor), expand
  // then collapse it — this is a non-ancestor manual collapse, which IS
  // honored.
  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'false');
  await expandFolder(page);
  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'true');
  await collapseFolder(page);
  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'false');

  // Now navigate INTO sidebar-folder. It becomes an ancestor — should
  // auto-expand via ancestor priority, overriding the userCollapsed entry.
  await page.evaluate(() => {
    window.location.hash = '#/sidebar-folder/nested-doc';
  });
  await fileRow(page, 'nested-doc.md').waitFor({ state: 'visible', timeout: 10_000 });
  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'true');
});

test('user-expanded non-ancestor folder persists across navigation (D4)', async ({ page }) => {
  await page.goto(`/#/test-doc`);
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
  await page.goto(`/#/sidebar-folder/nested-doc`);
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
  await page.goto(`/#/test-doc`);
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
  await page.goto(`/#/sidebar-folder/nested-doc`);
  await fileRow(page, 'nested-doc.md').waitFor({ state: 'visible', timeout: 15_000 });
  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'true');

  // The accessible name is just the leaf file name; the hover affordance
  // carries the full relative path so names that middle-truncate in the
  // narrow sidebar stay readable.
  await fileRow(page, 'nested-doc.md').hover();
  await expect(fileRow(page, 'nested-doc.md')).toHaveAttribute(
    'title',
    'sidebar-folder/nested-doc.md',
  );

  // Folder rows carry their directory path the same way, minus the trailing
  // slash that `data-item-path` uses as an internal folder marker.
  await folderRow(page).hover();
  await expect(folderRow(page)).toHaveAttribute('title', 'sidebar-folder');
});

test('sidebar full-path title is eager (no hover needed) and reaches the floating action overlay', async ({
  page,
}) => {
  // Regression guard for the inconsistent hover-path tooltip. The path `title`
  // is a property of the row, stamped eagerly when the tree renders — not
  // opportunistically attached to one sub-element on `mousemove`. And
  // `@pierre/trees` overlays a floating `···` ("Options") trigger on the
  // hovered row's right edge that is a SIBLING of the row, not a descendant —
  // so the row's own `title` doesn't resolve when the cursor rests there; the
  // hovered row's path must also be mirrored onto the
  // `[data-type=context-menu-anchor]` overlay. Both of these failed under the
  // original lazy implementation.
  await page.goto(`/#/sidebar-folder/nested-doc`);
  await fileRow(page, 'nested-doc.md').waitFor({ state: 'visible', timeout: 15_000 });
  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'true');

  // 1. Titles are present without any hover.
  await expect(fileRow(page, 'nested-doc.md')).toHaveAttribute(
    'title',
    'sidebar-folder/nested-doc.md',
  );
  await expect(folderRow(page)).toHaveAttribute('title', 'sidebar-folder');
  await expect(fileRow(page, 'test-doc.md')).toHaveAttribute('title', 'test-doc.md');

  // 2. Hovering a row makes its path resolvable over the floating `···`
  //    action-zone overlay (a sibling of the row, not a descendant).
  const contextMenuAnchor = sidebar(page).locator('[data-type="context-menu-anchor"]');
  await folderRow(page).hover();
  await expect(contextMenuAnchor).toHaveAttribute('title', 'sidebar-folder');
  await fileRow(page, 'nested-doc.md').hover();
  await expect(contextMenuAnchor).toHaveAttribute('title', 'sidebar-folder/nested-doc.md');
});
