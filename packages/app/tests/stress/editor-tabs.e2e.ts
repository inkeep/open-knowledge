import { randomUUID } from 'node:crypto';
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import {
  type ApiHelpers,
  createPngBuffer,
  expect,
  REQUIRED_FIXTURE_ENTRY_NAMES,
  test,
  type WorkerServer,
  waitForActiveProviderSynced,
} from './_helpers';

function testId(): string {
  return randomUUID().slice(0, 8);
}

async function seedDocs(
  api: ApiHelpers,
  docs: Array<{ name: string; path: string; markdown: string }>,
) {
  await api.testReset();
  for (const doc of docs) {
    await api.createPage(doc.path);
  }
  for (const doc of docs) {
    await api.replaceDoc(doc.name, doc.markdown);
  }
}

async function seedMarkdownDocs(api: ApiHelpers, docs: Array<{ name: string; markdown: string }>) {
  await seedDocs(
    api,
    docs.map((doc) => ({ ...doc, path: `${doc.name}.md` })),
  );
}

async function seedMdxDocs(api: ApiHelpers, docs: Array<{ name: string; markdown: string }>) {
  await seedDocs(
    api,
    docs.map((doc) => ({ ...doc, path: `${doc.name}.mdx` })),
  );
}

async function deletePathIfExists(
  baseURL: string,
  kind: 'file' | 'folder',
  path: string,
): Promise<void> {
  const response = await fetch(`${baseURL}/api/delete-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, path }),
  });
  if (response.ok || response.status === 404) return;
  throw new Error(`delete-path failed for ${kind}:${path}: ${response.status}`);
}

async function clearVisibleContentEntries(workerServer: WorkerServer): Promise<void> {
  for (const entry of readdirSync(workerServer.contentDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if ((REQUIRED_FIXTURE_ENTRY_NAMES as readonly string[]).includes(entry.name)) continue;
    if (entry.isDirectory()) {
      await deletePathIfExists(workerServer.baseURL, 'folder', entry.name);
      continue;
    }
    const docPath = entry.name.replace(/\.(md|mdx)$/i, '');
    if (docPath !== entry.name) {
      await deletePathIfExists(workerServer.baseURL, 'file', docPath);
      continue;
    }
    rmSync(join(workerServer.contentDir, entry.name), { recursive: true, force: true });
  }
}

async function installLocalTabSession(
  page: Page,
  state: {
    openTabs: string[];
    pinnedTabIds?: string[];
    activeTabId: string | null;
  },
) {
  await page.addInitScript((sessionState) => {
    window.localStorage.setItem(
      `ok-editor-tabs-v1:${window.location.origin}`,
      JSON.stringify({
        updatedAt: '2026-05-12T00:00:00.000Z',
        panes: [
          {
            id: 'pane-main',
            openTabs: sessionState.openTabs,
            pinnedTabIds: sessionState.pinnedTabIds ?? [],
            activeTabId: sessionState.activeTabId,
            size: 100,
          },
        ],
        focusedPaneId: 'pane-main',
      }),
    );
  }, state);
}

function editorTabButtons(page: Page, accessibleLabel: string): Locator {
  return page.getByRole('main').getByRole('button', { name: accessibleLabel, exact: true });
}

function activeEditorTabButtons(page: Page, accessibleLabel: string): Locator {
  return page
    .getByRole('main')
    .locator('[data-active-tab="true"]')
    .getByRole('button', { name: accessibleLabel, exact: true });
}

function editorNewTabButton(page: Page): Locator {
  return page.getByRole('main').getByTestId('editor-new-tab-button');
}

function activateNewTabButtons(page: Page): Locator {
  return page.getByRole('main').getByTestId('editor-new-tab-placeholder-button');
}

function closeNewTabButtons(page: Page): Locator {
  return page.getByRole('main').getByTestId('editor-new-tab-placeholder-close');
}

function sidebarTreeItem(page: Page, accessibleLabel: string): Locator {
  return page
    .locator('[data-slot="sidebar-container"]')
    .getByRole('treeitem', { name: accessibleLabel, exact: true });
}

function editorTabChrome(tabButton: Locator): Locator {
  return tabButton.locator('xpath=ancestor::div[@aria-roledescription="sortable"][1]');
}

async function expectActiveTab(tabButton: Locator) {
  await expect(editorTabChrome(tabButton)).toHaveAttribute('data-active-tab', 'true');
}

async function expectInactiveTab(tabButton: Locator) {
  await expect(editorTabChrome(tabButton)).not.toHaveAttribute('data-active-tab', 'true');
}

async function clickNewTabCloseButton(page: Page, index: number) {
  const tabButton = activateNewTabButtons(page).nth(index);
  const closeButton = closeNewTabButtons(page).nth(index);
  await editorTabChrome(tabButton).hover();
  await closeButton.click();
}

async function expectPersistedTabSession(
  page: Page,
  expected: { openTabs: string[]; activeTabId: string | null },
) {
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem(`ok-editor-tabs-v1:${window.location.origin}`);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as {
          panes?: Array<{ openTabs?: unknown; activeTabId?: unknown }>;
        };
        const pane = parsed.panes?.[0];
        return {
          openTabs: Array.isArray(pane?.openTabs) ? pane.openTabs : null,
          activeTabId: typeof pane?.activeTabId === 'string' ? pane.activeTabId : null,
        };
      }),
    )
    .toEqual(expected);
}

async function expectPersistedPinnedTabs(page: Page, expected: string[]) {
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem(`ok-editor-tabs-v1:${window.location.origin}`);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as { panes?: Array<{ pinnedTabIds?: unknown }> };
        const pinnedTabIds = parsed.panes?.[0]?.pinnedTabIds;
        return Array.isArray(pinnedTabIds) ? pinnedTabIds : null;
      }),
    )
    .toEqual(expected);
}

async function editorTabOrder(page: Page): Promise<string[]> {
  return page
    .locator('[data-editor-pane-focused] [data-editor-pane-tabs] [data-editor-tab-sortable]')
    .evaluateAll((tabEls) =>
      tabEls.flatMap((tabEl) => {
        if (tabEl.querySelector('[data-testid="editor-new-tab-placeholder-button"]')) {
          return ['new-tab'];
        }
        const primaryButton = [...tabEl.querySelectorAll('button[aria-label]')].find(
          (button) =>
            !button.matches(
              '[data-testid="editor-tab-close-button"], [data-testid="editor-tab-unpin-button"]',
            ),
        );
        const label = primaryButton?.getAttribute('aria-label');
        return label ? [label] : [];
      }),
    );
}

async function expectDocumentListContainsAsset(baseURL: string, assetPath: string) {
  await expect
    .poll(
      async () => {
        const response = await fetch(`${baseURL}/api/documents`);
        const body = (await response.json()) as {
          documents?: Array<{ kind?: string; path?: string }>;
        };
        return body.documents?.some((entry) => entry.kind === 'asset' && entry.path === assetPath);
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

async function seedReferencedAssetDoc(
  api: ApiHelpers,
  workerServer: WorkerServer,
  docName: string,
  assetPath: string,
) {
  const markdown = `![Asset tab](${assetPath})\n`;

  await api.testReset();
  writeFileSync(join(workerServer.contentDir, assetPath), createPngBuffer(assetPath));
  await api.createPage(`${docName}.md`);
  await api.replaceDoc(docName, markdown);

  writeFileSync(join(workerServer.contentDir, `${docName}.md`), markdown);
  await api.createPage(`${docName}-asset-index-bump.md`);
  await expectDocumentListContainsAsset(workerServer.baseURL, assetPath);
}

test.describe('Editor tabs', () => {
  test('clicking New tab repeatedly creates multiple blank tabs', async ({ page, api }) => {
    const id = testId();
    const docName = `new-tab-repeat-${id}`;

    await seedMarkdownDocs(api, [{ name: docName, markdown: `# New Tab Repeat ${id}` }]);

    await page.goto(`/#/${docName}`);
    await expect(editorTabButtons(page, `${docName}.md`)).toHaveCount(1, { timeout: 10_000 });

    const newTabButton = editorNewTabButton(page);
    await newTabButton.click();
    await newTabButton.click();
    await newTabButton.click();

    await expect(closeNewTabButtons(page)).toHaveCount(3);
  });

  test('the last blank tab closes for good and leaves the empty state', async ({ page, api }) => {
    await api.testReset();
    await page.goto('/');
    await expect(page.getByTestId('empty-editor-state')).toBeVisible({ timeout: 10_000 });
    await expect(activateNewTabButtons(page)).toHaveCount(0);

    await editorNewTabButton(page).click();
    await expect(activateNewTabButtons(page)).toHaveCount(1);

    await clickNewTabCloseButton(page, 0);

    await expect(activateNewTabButtons(page)).toHaveCount(0);
    await expect(page.getByTestId('empty-editor-state')).toBeVisible();
    await expect(activateNewTabButtons(page)).toHaveCount(0);
  });

  test('closing the last document tab leaves the empty state, not a blank tab', async ({
    page,
    api,
  }) => {
    const id = testId();
    const docName = `last-doc-close-${id}`;
    const label = `${docName}.md`;
    await seedMarkdownDocs(api, [{ name: docName, markdown: `# Last Doc Close ${id}` }]);

    await page.goto(`/#/${docName}`);
    const docTab = editorTabButtons(page, label);
    await expect(docTab).toHaveCount(1, { timeout: 10_000 });

    const chrome = editorTabChrome(docTab.first());
    await chrome.hover();
    await chrome.getByTestId('editor-tab-close-button').click();

    await expect(docTab).toHaveCount(0);
    await expect(page.getByTestId('empty-editor-state')).toBeVisible();
    await expect(activateNewTabButtons(page)).toHaveCount(0);
  });

  test('Skills blank tabs stay independently selectable and close for good', async ({
    page,
    api,
  }) => {
    await api.testReset();
    await page.goto('/#/__skills__');
    const newTabs = activateNewTabButtons(page);
    await expect(newTabs).toHaveCount(1, { timeout: 10_000 });

    await editorNewTabButton(page).click();
    await expect(newTabs).toHaveCount(2);
    await expectActiveTab(newTabs.nth(1));

    await newTabs.nth(0).click();
    await expectActiveTab(newTabs.nth(0));
    await expectInactiveTab(newTabs.nth(1));

    await newTabs.nth(1).click();
    await expectActiveTab(newTabs.nth(1));
    await expectInactiveTab(newTabs.nth(0));

    await clickNewTabCloseButton(page, 0);
    await expect(newTabs).toHaveCount(1);
    await clickNewTabCloseButton(page, 0);

    await expect(newTabs).toHaveCount(0);
    await expect(page.getByTestId('create-view')).toBeVisible();
    await expect(newTabs).toHaveCount(0);
  });

  test('closing multiple new tabs preserves active placeholder and falls back to document tab', async ({
    page,
    api,
  }) => {
    const id = testId();
    const docName = `new-tab-close-${id}`;
    const label = `${docName}.md`;

    await seedMarkdownDocs(api, [{ name: docName, markdown: `# New Tab Close ${id}` }]);

    await page.goto(`/#/${docName}`);
    const docTab = editorTabButtons(page, label);
    await expect(docTab).toHaveCount(1, { timeout: 10_000 });
    await expectActiveTab(docTab.first());

    const newTabButton = editorNewTabButton(page);
    await newTabButton.click();
    await newTabButton.click();
    await newTabButton.click();

    const newTabs = activateNewTabButtons(page);
    await expect(newTabs).toHaveCount(3);
    await expectActiveTab(newTabs.nth(2));
    await expectInactiveTab(docTab.first());

    await newTabs.nth(1).click();
    await expectActiveTab(newTabs.nth(1));

    await clickNewTabCloseButton(page, 0);
    await expect(newTabs).toHaveCount(2);
    await expectActiveTab(newTabs.nth(0));
    await expectInactiveTab(newTabs.nth(1));

    await clickNewTabCloseButton(page, 0);
    await expect(newTabs).toHaveCount(1);
    await expectActiveTab(newTabs.first());

    await clickNewTabCloseButton(page, 0);
    await expect(newTabs).toHaveCount(0);
    await expectActiveTab(docTab.first());
  });

  test('clicking New tab clears the active sidebar file selection', async ({ page, api }) => {
    const id = testId();
    const docName = `new-tab-sidebar-${id}`;
    const label = `${docName}.md`;

    await seedMarkdownDocs(api, [{ name: docName, markdown: `# New Tab Sidebar ${id}` }]);

    await page.goto(`/#/${docName}`);
    const sidebarItem = sidebarTreeItem(page, label);
    await expect(editorTabButtons(page, label)).toHaveCount(1, { timeout: 10_000 });
    await expect(sidebarItem).toHaveAttribute('aria-selected', 'true');

    await editorNewTabButton(page).click();

    await expect(activateNewTabButtons(page)).toHaveCount(1);
    await expect(sidebarItem).not.toHaveAttribute('aria-selected', 'true');
  });

  test('sidebar click fills the active third new tab in place', async ({
    page,
    api,
    workerServer,
  }) => {
    const id = testId();
    const firstDoc = `new-tab-fill-first-${id}`;
    const selectedDoc = `new-tab-fill-selected-${id}`;
    const firstLabel = `${firstDoc}.md`;
    const selectedLabel = `${selectedDoc}.md`;

    await clearVisibleContentEntries(workerServer);
    await seedMarkdownDocs(api, [
      { name: firstDoc, markdown: `# First ${id}` },
      { name: selectedDoc, markdown: `# Selected ${id}` },
    ]);

    await page.goto(`/#/${firstDoc}`);
    const firstTab = editorTabButtons(page, firstLabel);
    await expect(firstTab).toHaveCount(1, { timeout: 10_000 });
    await expectActiveTab(firstTab.first());

    const newTabButton = editorNewTabButton(page);
    await newTabButton.click();
    await newTabButton.click();
    await newTabButton.click();

    const newTabs = activateNewTabButtons(page);
    await expect(newTabs).toHaveCount(3);
    await newTabs.nth(2).click();
    await expectActiveTab(newTabs.nth(2));

    await sidebarTreeItem(page, selectedLabel).click();

    const selectedTab = editorTabButtons(page, selectedLabel);
    await expect(selectedTab).toHaveCount(1, { timeout: 10_000 });
    await expectActiveTab(selectedTab.first());
    await expect(activateNewTabButtons(page)).toHaveCount(2);
    await expect
      .poll(() => editorTabOrder(page))
      .toEqual([firstLabel, 'new-tab', 'new-tab', selectedLabel]);
  });

  test('sidebar folder click opens a preview beside the permanent file tab', async ({
    page,
    api,
    workerServer,
  }) => {
    const id = testId();
    const fileDoc = `folder-click-file-${id}`;
    const folder = `folder-click-${id}`;
    const nestedDoc = `${folder}/nested-${id}`;
    const fileLabel = `${fileDoc}.md`;
    const folderLabel = `${folder}/`;

    await clearVisibleContentEntries(workerServer);
    await seedMarkdownDocs(api, [
      { name: fileDoc, markdown: `# File ${id}` },
      { name: nestedDoc, markdown: `# Nested ${id}` },
    ]);

    await page.goto(`/#/${fileDoc}`);
    const fileTabs = editorTabButtons(page, fileLabel);
    const folderTabs = editorTabButtons(page, folderLabel);
    await expect(fileTabs).toHaveCount(1, { timeout: 10_000 });
    await expectActiveTab(fileTabs.first());

    await sidebarTreeItem(page, folder).click();

    await expect(page).toHaveURL(new RegExp(`#/${folder}/$`));
    await expect(fileTabs).toHaveCount(1);
    await expect(folderTabs).toHaveCount(1);
    await expectActiveTab(folderTabs.first());
    await expect(editorTabChrome(folderTabs.first())).toHaveAttribute('data-preview-tab', 'true');
    await expect.poll(() => editorTabOrder(page)).toEqual([fileLabel, folderLabel]);
  });

  test('sidebar asset click opens a preview beside the permanent file tab', async ({
    page,
    api,
    workerServer,
  }) => {
    const id = testId();
    const docName = `asset-tab-doc-${id}`;
    const docLabel = `${docName}.md`;
    const assetPath = `asset-tab-${id}.png`;

    await clearVisibleContentEntries(workerServer);
    await seedReferencedAssetDoc(api, workerServer, docName, assetPath);

    await page.goto(`/#/${docName}`);
    const docTab = editorTabButtons(page, docLabel);
    await expect(docTab).toHaveCount(1, { timeout: 10_000 });
    await expectActiveTab(docTab.first());

    await sidebarTreeItem(page, assetPath).click();

    const assetTab = editorTabButtons(page, assetPath);
    await expect(docTab).toHaveCount(1);
    await expect(assetTab).toHaveCount(1);
    await expectActiveTab(assetTab.first());
    await expect(editorTabChrome(assetTab.first())).toHaveAttribute('data-preview-tab', 'true');
    await expect.poll(() => editorTabOrder(page)).toEqual([docLabel, assetPath]);
    await expect(page).toHaveURL(new RegExp(`#/__asset__/${assetPath.replace('.', '\\.')}$`));
  });

  test('sidebar folder click focuses the existing folder tab when that folder is already open', async ({
    page,
    api,
  }) => {
    const id = testId();
    const folder = `folder-new-tab-${id}`;
    const nestedDoc = `${folder}/nested-${id}`;
    const folderLabel = `${folder}/`;
    const folderTabId = `\u0000folder:${folder}`;

    await seedMarkdownDocs(api, [{ name: nestedDoc, markdown: `# Nested ${id}` }]);

    await page.goto(`/#/${folder}/`);
    const folderTabs = editorTabButtons(page, folderLabel);
    await expect(folderTabs).toHaveCount(1, { timeout: 10_000 });
    await expectActiveTab(folderTabs.first());

    await editorNewTabButton(page).click();
    await expect(activateNewTabButtons(page)).toHaveCount(1);
    await expectActiveTab(activateNewTabButtons(page).first());

    await sidebarTreeItem(page, folder).click();

    await expect(folderTabs).toHaveCount(1);
    await expect(activateNewTabButtons(page)).toHaveCount(0);
    await expect(activeEditorTabButtons(page, folderLabel)).toHaveCount(1);
    await expect.poll(() => editorTabOrder(page)).toEqual([folderLabel]);
    await expectPersistedTabSession(page, {
      openTabs: [folderTabId],
      activeTabId: folderTabId,
    });
  });

  test('sidebar click focuses the existing foo.md tab instead of duplicating it', async ({
    page,
    api,
  }) => {
    const id = testId();
    const fooDoc = `foo-${id}`;
    const barDoc = `bar-${id}`;
    const fooLabel = `${fooDoc}.md`;
    const barLabel = `${barDoc}.md`;

    await seedMarkdownDocs(api, [
      { name: fooDoc, markdown: `# Foo ${id}` },
      { name: barDoc, markdown: `# Bar ${id}` },
    ]);

    await page.goto(`/#/${fooDoc}`);
    const fooTabs = editorTabButtons(page, fooLabel);
    const barTabs = editorTabButtons(page, barLabel);
    await expect(fooTabs).toHaveCount(1, { timeout: 10_000 });
    await expectActiveTab(fooTabs.first());

    await editorNewTabButton(page).click();
    await sidebarTreeItem(page, barLabel).click();
    await expect(barTabs).toHaveCount(1, { timeout: 10_000 });
    await expectActiveTab(barTabs.first());
    await expectInactiveTab(fooTabs.first());

    await sidebarTreeItem(page, fooLabel).click();

    await expect(fooTabs).toHaveCount(1);
    await expect(barTabs).toHaveCount(1);
    await expectActiveTab(fooTabs.first());
    await expectInactiveTab(barTabs.first());
  });

  test('sidebar click from a restored foo.md/bar.md session focuses the existing foo.md tab', async ({
    page,
    api,
  }) => {
    const id = testId();
    const fooDoc = `foo-restored-${id}`;
    const barDoc = `bar-restored-${id}`;
    const fooLabel = `${fooDoc}.md`;
    const barLabel = `${barDoc}.md`;

    await seedMarkdownDocs(api, [
      { name: fooDoc, markdown: `# Foo Restored ${id}` },
      { name: barDoc, markdown: `# Bar Restored ${id}` },
    ]);

    await installLocalTabSession(page, {
      openTabs: [fooDoc, barDoc],
      activeTabId: barDoc,
    });

    await page.goto(`/#/${barDoc}`);
    const fooTabs = editorTabButtons(page, fooLabel);
    const barTabs = editorTabButtons(page, barLabel);
    await expect(fooTabs).toHaveCount(1, { timeout: 10_000 });
    await expect(barTabs).toHaveCount(1);
    await expectInactiveTab(fooTabs.first());
    await expectActiveTab(barTabs.first());

    await sidebarTreeItem(page, fooLabel).click();

    await expect(fooTabs).toHaveCount(1);
    await expect(barTabs).toHaveCount(1);
    await expectActiveTab(fooTabs.first());
    await expectInactiveTab(barTabs.first());
    await expectPersistedTabSession(page, {
      openTabs: [fooDoc, barDoc],
      activeTabId: fooDoc,
    });
  });

  test('sidebar previews replace the previous preview and Keep open promotes it', async ({
    page,
    api,
  }) => {
    const id = testId();
    const fooDoc = `foo-preview-${id}`;
    const barDoc = `bar-preview-${id}`;
    const bazDoc = `baz-preview-${id}`;
    const fooLabel = `${fooDoc}.md`;
    const barLabel = `${barDoc}.md`;
    const bazLabel = `${bazDoc}.md`;

    await seedMarkdownDocs(api, [
      { name: fooDoc, markdown: `# Foo Preview ${id}` },
      { name: barDoc, markdown: `# Bar Preview ${id}` },
      { name: bazDoc, markdown: `# Baz Preview ${id}` },
    ]);

    await page.goto(`/#/${fooDoc}`);
    const fooTabs = editorTabButtons(page, fooLabel);
    const barTabs = editorTabButtons(page, barLabel);
    const bazTabs = editorTabButtons(page, bazLabel);
    await expect(fooTabs).toHaveCount(1, { timeout: 10_000 });

    await sidebarTreeItem(page, barLabel).click();
    await expect(barTabs).toHaveCount(1);
    await expect(editorTabChrome(barTabs.first())).toHaveAttribute('data-preview-tab', 'true');

    await editorTabChrome(barTabs.first()).click({ button: 'right' });
    await page.getByTestId('editor-tab-context-keep-open').click();
    await expect(editorTabChrome(barTabs.first())).not.toHaveAttribute('data-preview-tab');

    await sidebarTreeItem(page, bazLabel).click();
    await expect(fooTabs).toHaveCount(1);
    await expect(barTabs).toHaveCount(1);
    await expect(bazTabs).toHaveCount(1);
    await expect(editorTabChrome(bazTabs.first())).toHaveAttribute('data-preview-tab', 'true');
  });

  test('tab click selects the already-open foo.md tab without rewriting the bar.md tab', async ({
    page,
    api,
    workerServer,
  }) => {
    const id = testId();
    const fooDoc = `foo-click-${id}`;
    const barDoc = `bar-click-${id}`;
    const fooLabel = `${fooDoc}.md`;
    const barLabel = `${barDoc}.md`;

    await clearVisibleContentEntries(workerServer);
    await seedMarkdownDocs(api, [
      { name: fooDoc, markdown: `# Foo Click ${id}` },
      { name: barDoc, markdown: `# Bar Click ${id}` },
    ]);

    await page.goto(`/#/${fooDoc}`);
    const fooTabs = editorTabButtons(page, fooLabel);
    const barTabs = editorTabButtons(page, barLabel);
    await expect(fooTabs).toHaveCount(1, { timeout: 10_000 });
    await expectActiveTab(fooTabs.first());

    await editorNewTabButton(page).click();
    await sidebarTreeItem(page, barLabel).click();
    await expect(barTabs).toHaveCount(1, { timeout: 10_000 });
    await expectActiveTab(barTabs.first());
    await expectInactiveTab(fooTabs.first());

    await fooTabs.first().click();

    await expect(fooTabs).toHaveCount(1);
    await expect(barTabs).toHaveCount(1);
    await expectActiveTab(fooTabs.first());
    await expectInactiveTab(barTabs.first());
  });

  test('sidebar click focuses the existing .mdx tab instead of duplicating it', async ({
    page,
    api,
    workerServer,
  }) => {
    const id = testId();
    const folder = `tab-${id}`;
    const barDoc = `${folder}/bar-${id}`;
    const bazDoc = `${folder}/baz-${id}`;
    const helloDoc = `hello-${id}`;
    const barLabel = `${folder}/bar-${id}.mdx`;
    const helloLabel = `hello-${id}.mdx`;

    await clearVisibleContentEntries(workerServer);
    await seedMdxDocs(api, [
      { name: barDoc, markdown: `# Bar ${id}` },
      { name: bazDoc, markdown: `# Baz ${id}` },
      { name: helloDoc, markdown: `# Hello ${id}` },
    ]);
    await installLocalTabSession(page, {
      openTabs: [barDoc],
      activeTabId: barDoc,
    });

    await page.goto(`/#/${barDoc}`);
    await expect(editorTabButtons(page, barLabel)).toHaveCount(1, { timeout: 10_000 });
    await waitForActiveProviderSynced(page);

    await editorNewTabButton(page).click();
    await expect(closeNewTabButtons(page)).toHaveCount(1, { timeout: 10_000 });
    await sidebarTreeItem(page, `hello-${id}.mdx`).click();
    await expect(editorTabButtons(page, helloLabel)).toHaveCount(1, { timeout: 10_000 });
    await expectActiveTab(editorTabButtons(page, helloLabel).first());
    await waitForActiveProviderSynced(page);

    await sidebarTreeItem(page, `bar-${id}.mdx`).click();

    const barTabs = editorTabButtons(page, barLabel);
    await expect(barTabs).toHaveCount(1);
    await expect(editorTabButtons(page, helloLabel)).toHaveCount(1);
    await expectActiveTab(barTabs.first());
    await expectInactiveTab(editorTabButtons(page, helloLabel).first());
  });

  test('double-clicking a preview tab promotes it without entering rename mode', async ({
    page,
    api,
  }) => {
    const id = testId();
    const folder = `preview-rename-${id}`;
    const baseDoc = `${folder}/base-${id}`;
    const barDoc = `${folder}/bar-${id}`;
    const baseLabel = `${folder}/base-${id}.mdx`;
    const barLabel = `${folder}/bar-${id}.mdx`;

    await seedMdxDocs(api, [
      { name: baseDoc, markdown: `# Base ${id}` },
      { name: barDoc, markdown: `# Preview Bar ${id}` },
    ]);

    await page.goto(`/#/${baseDoc}`);
    await expect(editorTabButtons(page, baseLabel)).toHaveCount(1, { timeout: 10_000 });
    await sidebarTreeItem(page, `bar-${id}.mdx`).click();

    const previewTab = editorTabButtons(page, barLabel);
    const previewChrome = page.getByRole('main').locator(`[data-editor-tab-id="${barDoc}"]`);
    await expect(previewTab).toHaveCount(1);
    await expect(previewChrome).toHaveAttribute('data-preview-tab', 'true');

    await previewTab.dblclick();
    await expect(previewChrome).not.toHaveAttribute('data-preview-tab');
    await expect(page.getByRole('main').getByTestId('editor-tab-rename-input')).toHaveCount(0);
  });

  test('pinning a tab replaces close with pin and bulk close keeps it open', async ({
    page,
    api,
  }) => {
    const id = testId();
    const pinnedDoc = `pinned-${id}`;
    const otherDoc = `other-${id}`;
    const pinnedLabel = `${pinnedDoc}.md`;
    const otherLabel = `${otherDoc}.md`;

    await seedMarkdownDocs(api, [
      { name: pinnedDoc, markdown: `# Pinned ${id}` },
      { name: otherDoc, markdown: `# Other ${id}` },
    ]);

    await installLocalTabSession(page, {
      openTabs: [pinnedDoc, otherDoc],
      activeTabId: otherDoc,
    });

    await page.goto(`/#/${otherDoc}`);
    const pinnedTab = editorTabButtons(page, pinnedLabel);
    const otherTab = editorTabButtons(page, otherLabel);
    await expect(pinnedTab).toHaveCount(1, { timeout: 10_000 });
    await expect(otherTab).toHaveCount(1);

    await pinnedTab.click({ button: 'right' });
    await page.getByTestId('editor-tab-context-pin-toggle').click();

    await expect(
      editorTabChrome(pinnedTab.first()).getByTestId('editor-tab-unpin-button'),
    ).toHaveCount(1);
    await expect(
      editorTabChrome(pinnedTab.first()).getByTestId('editor-tab-close-button'),
    ).toHaveCount(0);
    await expectPersistedPinnedTabs(page, [pinnedDoc]);

    await otherTab.click({ button: 'right' });
    await page.getByTestId('editor-tab-context-close-all').click();

    await expect(pinnedTab).toHaveCount(1);
    await expect(otherTab).toHaveCount(0);
    await expectActiveTab(pinnedTab.first());
    await expectPersistedTabSession(page, {
      openTabs: [pinnedDoc],
      activeTabId: pinnedDoc,
    });
    await expectPersistedPinnedTabs(page, [pinnedDoc]);

    await editorTabChrome(pinnedTab.first()).getByTestId('editor-tab-unpin-button').click();
    await expectPersistedPinnedTabs(page, []);
    await expect(
      editorTabChrome(pinnedTab.first()).getByTestId('editor-tab-close-button'),
    ).toHaveCount(1);
  });

  test('sidebar click from an active pinned tab opens a new tab instead of replacing it', async ({
    page,
    api,
    workerServer,
  }) => {
    const id = testId();
    const pinnedDoc = `active-pinned-${id}`;
    const otherDoc = `sidebar-open-${id}`;
    const pinnedLabel = `${pinnedDoc}.md`;
    const otherLabel = `${otherDoc}.md`;

    await clearVisibleContentEntries(workerServer);
    await seedMarkdownDocs(api, [
      { name: pinnedDoc, markdown: `# Active Pinned ${id}` },
      { name: otherDoc, markdown: `# Sidebar Open ${id}` },
    ]);

    await installLocalTabSession(page, {
      openTabs: [pinnedDoc],
      activeTabId: pinnedDoc,
    });

    await page.goto(`/#/${pinnedDoc}`);
    const pinnedTab = editorTabButtons(page, pinnedLabel);
    const otherTab = editorTabButtons(page, otherLabel);
    await expect(pinnedTab).toHaveCount(1, { timeout: 10_000 });
    await expectActiveTab(pinnedTab.first());

    await pinnedTab.click({ button: 'right' });
    await page.getByTestId('editor-tab-context-pin-toggle').click();
    await expectPersistedPinnedTabs(page, [pinnedDoc]);

    await sidebarTreeItem(page, otherLabel).click();

    await expect(pinnedTab).toHaveCount(1);
    await expect(otherTab).toHaveCount(1);
    await expectInactiveTab(pinnedTab.first());
    await expectActiveTab(otherTab.first());
    await expectPersistedTabSession(page, {
      openTabs: [pinnedDoc, otherDoc],
      activeTabId: otherDoc,
    });
    await expectPersistedPinnedTabs(page, [pinnedDoc]);
  });
});
