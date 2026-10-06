import { randomUUID } from 'node:crypto';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DocumentListSuccessSchema } from '@inkeep/open-knowledge-core/schemas/api';
import type { Page } from '@playwright/test';
import { type ApiHelpers, expect, test } from './_helpers';

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

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'wait' });
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

async function focusIsInsideFileTree(page: Page, survivingRowPath: string): Promise<boolean> {
  return page.evaluate((rowPath) => {
    let element: Element | null = document.activeElement;
    while (element?.shadowRoot?.activeElement != null) {
      element = element.shadowRoot.activeElement;
    }
    if (element?.closest('[role="tree"]') == null) return false;
    const root = element.getRootNode();
    if (!(root instanceof ShadowRoot)) return false;
    return root.querySelector(`[data-item-path="${rowPath}"]`) != null;
  }, survivingRowPath);
}

async function focusedRowLabel(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    let element: Element | null = document.activeElement;
    while (element?.shadowRoot?.activeElement != null) {
      element = element.shadowRoot.activeElement;
    }
    return element?.getAttribute('aria-label') ?? null;
  });
}

async function expandFolder(page: Page) {
  await folderRow(page).focus();
  await folderRow(page).press('ArrowRight');
}

async function collapseFolder(page: Page) {
  await folderRow(page).focus();
  await folderRow(page).press('ArrowLeft');
}

async function prepareLateRow(page: Page, api: ApiHelpers, { initiallyVisible = false } = {}) {
  const docName = `zz-late-${randomUUID()}`;
  let includeRow = initiallyVisible;
  await page.route(
    (url) => url.pathname === '/api/documents' && url.searchParams.get('showAll') === 'true',
    async (route) => {
      const response = await route.fetch({
        headers: { ...route.request().headers(), accept: 'application/json' },
      });
      const body = DocumentListSuccessSchema.parse(await response.json());
      await route.fulfill({
        response,
        json: {
          ...body,
          documents: body.documents.filter(
            (entry) => includeRow || entry.kind !== 'document' || entry.docName !== docName,
          ),
        },
      });
    },
  );
  await api.createPage(`${docName}.md`);
  await api.replaceDoc(docName, '# Late row content\n');
  await gotoAndAwaitTree(page, `/#/${docName}`);
  const editor = page.locator('.ProseMirror:not(.composer-prosemirror)');
  await expect(editor).toContainText('Late row content');
  await expect(fileRow(page, `${docName}.md`)).toHaveCount(initiallyVisible ? 1 : 0);
  const tree = sidebar(page)
    .getByRole('tree')
    .filter({ has: page.getByRole('treeitem', { name: 'sidebar-folder', exact: true }) });
  const scroller = tree.locator('[data-file-tree-virtualized-scroll]');
  const viewportHeight = await scroller.evaluate((element) => element.clientHeight);
  const rowHeight = await folderRow(page).evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  const fillerCount = Math.ceil(viewportHeight / rowHeight);
  const fillerNames = Array.from(
    { length: fillerCount },
    (_, index) => `filler-${docName}-${String(index).padStart(String(fillerCount).length, '0')}.md`,
  );
  for (const name of fillerNames) await api.createPage(name);
  await expect(folderRow(page)).toHaveAttribute(
    'aria-setsize',
    String(fillerCount + (initiallyVisible ? 3 : 2)),
  );
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
  });
  return {
    editor,
    scroller,
    row: fileRow(page, `${docName}.md`),
    async arrive() {
      const previousCount = Number(await folderRow(page).getAttribute('aria-setsize'));
      const addedCount = includeRow ? 1 : 2;
      includeRow = true;
      await api.createPage(`arrival-${randomUUID()}.md`);
      await expect(folderRow(page)).toHaveAttribute(
        'aria-setsize',
        String(previousCount + addedCount),
      );
      await expect(fileRow(page, `${docName}.md`)).toHaveAttribute('aria-selected', 'true');
    },
  };
}

test('a late open row preserves file-tree focus and the viewport', async ({ page, api }) => {
  const { scroller, row, arrive } = await prepareLateRow(page, api);
  await folderRow(page).focus();
  await expect(folderRow(page)).toBeFocused();
  const scrollBefore = await scroller.evaluate((element) => element.scrollTop);

  await arrive();

  await expect.soft(folderRow(page)).toBeFocused();
  expect.soft(await scroller.evaluate((element) => element.scrollTop)).toBe(scrollBefore);
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'true');
});

test('a background refresh preserves a viewport scrolled away from the focused open row', async ({
  page,
  api,
}) => {
  const { scroller, row, arrive } = await prepareLateRow(page, api, { initiallyVisible: true });
  await row.focus();
  await expect(row).toBeFocused();
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(row).not.toBeInViewport();
  await expect(row).toBeFocused();
  const scrollBefore = await scroller.evaluate((element) => element.scrollTop);

  await arrive();

  await expect(row).toBeFocused();
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(scrollBefore);
});

test('a late open row is revealed while editor focus remains and becomes the entry row', async ({
  page,
  api,
}) => {
  const { editor, scroller, row, arrive } = await prepareLateRow(page, api);
  await editor.focus();
  await expect(editor).toBeFocused();
  const scrollBefore = await scroller.evaluate((element) => element.scrollTop);

  await arrive();

  await expect(editor).toBeFocused();
  await expect(row).toHaveAttribute('tabindex', '0');
  await expect(row).toBeInViewport();
  expect(await scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(scrollBefore);

  await page.getByRole('button', { name: 'New folder', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(row).toBeFocused();
  await editor.focus();
  await row.click();
  await expect(row).toBeFocused();
});

test('a visibility refresh selects the open MDX row without taking sidebar focus', async ({
  page,
  api,
  workerServer,
}) => {
  const docName = `.late-${randomUUID()}`;
  await api.createPage(`${docName}.mdx`);
  writeFileSync(join(workerServer.contentDir, `${docName}.mdx`), '# Hidden late row\n');
  await gotoAndAwaitTree(page, `/#/${docName}`);
  await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).toContainText(
    'Hidden late row',
  );
  await expect(page.getByTestId('not-in-sidebar-flip-hidden-files')).toBeVisible();
  const requested = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route(
    (url) => url.pathname === '/api/documents' && url.searchParams.get('showAll') === 'true',
    async (route) => {
      requested.resolve();
      await release.promise;
      await route.continue();
    },
  );
  try {
    await page.getByTestId('not-in-sidebar-flip-hidden-files').click();
    await requested.promise;
    await folderRow(page).focus();
    await expect(folderRow(page)).toBeFocused();
    release.resolve();

    await expect(fileRow(page, `${docName}.mdx`)).toHaveAttribute('aria-selected', 'true');
    await expect.soft(folderRow(page)).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect.soft(folderRow(page)).toHaveAttribute('aria-expanded', 'true');
  } finally {
    release.resolve();
    await page.unrouteAll({ behavior: 'wait' });
  }
  await page.getByRole('button', { name: 'Tree view options' }).click();
  await page.getByTestId('tree-options-show-hidden-files').click();
  await expect(page.getByTestId('not-in-sidebar-indicator')).toBeVisible();
  await expect(fileRow(page, `${docName}.mdx`)).toHaveCount(0);
});

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

test('a background page-list change leaves keyboard focus on the row the user focused', async ({
  page,
  api,
}) => {
  await gotoAndAwaitTree(page, `/#/test-doc`);
  await fileRow(page, 'test-doc.md').waitFor({ state: 'visible', timeout: 15_000 });

  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'false');
  await folderRow(page).focus();
  await expect.poll(() => focusedRowLabel(page)).toBe('sidebar-folder');

  await api.createPage('zz-background-doc.md');
  await fileRow(page, 'zz-background-doc.md').waitFor({ state: 'visible', timeout: 15_000 });

  await expect.poll(() => focusedRowLabel(page)).toBe('sidebar-folder');

  await page.keyboard.press('ArrowRight');
  await expect(folderRow(page)).toHaveAttribute('aria-expanded', 'true');
});

test('a background deletion of the focused row leaves keyboard focus inside the tree', async ({
  page,
  workerServer,
}) => {
  await gotoAndAwaitTree(page, `/#/test-doc`);
  await fileRow(page, 'test-doc.md').waitFor({ state: 'visible', timeout: 15_000 });
  await expandFolder(page);
  await fileRow(page, 'nested-doc.md').waitFor({ state: 'visible', timeout: 15_000 });

  await fileRow(page, 'nested-doc.md').focus();
  await expect.poll(() => focusedRowLabel(page)).toBe('nested-doc.md');

  await deletePathIfExists(workerServer.baseURL, 'file', 'sidebar-folder/nested-doc');
  await fileRow(page, 'nested-doc.md').waitFor({ state: 'detached', timeout: 15_000 });

  await expect.poll(() => focusIsInsideFileTree(page, 'sidebar-folder/')).toBe(true);
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
