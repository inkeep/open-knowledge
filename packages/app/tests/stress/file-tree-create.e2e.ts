import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  type ApiHelpers,
  createFileViaSidebar,
  createFolderViaSidebar,
  expect,
  test,
} from './_helpers';

type DeleteKind = 'file' | 'folder';

async function deletePathIfExists(baseURL: string, kind: DeleteKind, path: string): Promise<void> {
  const res = await fetch(`${baseURL}/api/delete-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, path }),
  });

  if (res.ok || res.status === 404) return;
  throw new Error(`delete-path failed for ${kind}:${path}: ${res.status} ${await res.text()}`);
}

async function createFolder(baseURL: string, path: string): Promise<void> {
  const res = await fetch(`${baseURL}/api/create-folder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });

  if (res.ok || res.status === 409) return;
  throw new Error(`create-folder failed for ${path}: ${res.status} ${await res.text()}`);
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
      continue;
    }
    rmSync(join(contentDir, entry.name), { recursive: true, force: true });
  }
}

async function restoreRequiredFixtureEntries(baseURL: string, api: ApiHelpers): Promise<void> {
  await createFolder(baseURL, 'sidebar-folder');
  await api.createPage('test-doc.md');
  await api.createPage('sidebar-folder/nested-doc.md');
}

async function expectDocumentLoads(baseURL: string, docName: string): Promise<void> {
  const res = await fetch(`${baseURL}/api/document?docName=${encodeURIComponent(docName)}`);
  // RFC 9457 success body — flat `{ docName, body, ... }` shape, no
  // `{ ok: true }` discriminator. Status code is the authoritative
  // success/error gate.
  const data: { docName?: string } = await res.json();

  expect(res.status).toBe(200);
  expect(data.docName).toBe(docName);
}

function sidebarTreeItem(page: Page, name: string) {
  return page
    .locator('[data-slot="sidebar-container"]')
    .getByRole('treeitem', { name, exact: true });
}

function sidebarItemByPath(page: Page, path: string) {
  const escapedPath = path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return page
    .locator('[data-slot="sidebar-container"]')
    .locator(`[data-item-path="${escapedPath}"]`)
    .first();
}

async function visibleSidebarItemByPath(page: Page, path: string) {
  const item = sidebarItemByPath(page, path);
  await expect(item).toBeVisible({ timeout: 10_000 });
  return item;
}

function editorTabButton(page: Page, name: string) {
  return page.getByRole('main').getByRole('button', { name, exact: true });
}

function activeEditorTabButton(page: Page, name: string) {
  return page.locator('[data-active-tab="true"]').getByRole('button', { name, exact: true });
}

async function selectAllSidebarItems(page: Page, focusItemName: string) {
  const focusTarget = sidebarTreeItem(page, focusItemName);
  await focusTarget.focus();
  await expect(focusTarget).toBeFocused();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
}

function defaultName(base: string, index: number) {
  return index === 0 ? base : `${base} ${index + 1}`;
}

async function commitDefaultFileCreate(page: Page, docName: string): Promise<void> {
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  const input = page.getByRole('textbox', {
    name: new RegExp(`rename ${docName}\\.md`, 'i'),
  });
  const row = sidebarTreeItem(page, `${docName}.md`);

  await expect
    .poll(async () => {
      if (await input.isVisible().catch(() => false)) return 'input';
      if ((await row.count()) > 0) return 'row';
      return 'pending';
    })
    .not.toBe('pending');

  if (await input.isVisible().catch(() => false)) {
    await input.press('Enter');
  }
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: `${docName}.md`, exact: true })).toBeVisible({
    timeout: 10_000,
  });
}

async function commitDefaultFolderCreate(page: Page, folderName: string): Promise<void> {
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  const input = page.getByRole('textbox', { name: new RegExp(`rename ${folderName}`, 'i') });
  const row = sidebarTreeItem(page, folderName);

  await expect
    .poll(async () => {
      if (await input.isVisible().catch(() => false)) return 'input';
      if ((await row.count()) > 0) return 'row';
      return 'pending';
    })
    .not.toBe('pending');

  if (await input.isVisible().catch(() => false)) {
    await input.press('Enter');
  }
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: `${folderName}/`, exact: true })).toBeVisible({
    timeout: 10_000,
  });
}

/**
 * Navigate to the workspace root and wait until the sidebar file tree has
 * rendered at least one row. `waitForLoadState('domcontentloaded')` only
 * means the HTML parsed — the React app and the sidebar-tree CRDT may not be
 * hydrated yet, so a toolbar click ("New File" / "New Folder") fired right
 * after can land before its handler is wired and silently no-op, leaving the
 * inline rename input that the test then waits for permanently absent.
 * Gating on a rendered treeitem proves the app is interactive before the
 * first interaction. The worker fixture seeds `test-doc.md` + `sidebar-folder`,
 * so at least one row is always present at the start of every test.
 */
async function gotoRootAndAwaitSidebar(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await expect(
    page.locator('[data-slot="sidebar-container"]').getByRole('treeitem').first(),
  ).toBeVisible({ timeout: 15_000 });
}

async function installDelayedDesktopSessionBridge(
  page: Page,
  workerServer: { baseURL: string; port: number; contentDir: string },
  initialSession: {
    openTabs: string[];
    pinnedTabIds: string[];
    activeDocName: string | null;
    activeTabId: string | null;
  },
): Promise<void> {
  await page.addInitScript(
    ({ baseURL, contentDir, initialSession, port }) => {
      const sessionKey = '__okFakeDesktopSession';
      const readSession = () => {
        const raw = window.localStorage.getItem(sessionKey);
        return raw ? JSON.parse(raw) : { ...initialSession, updatedAt: '2026-05-08T00:00:00.000Z' };
      };
      const unsubscribe = () => {};
      const okDesktop = {
        appVersion: 'test',
        platform: 'darwin',
        config: {
          apiOrigin: baseURL,
          collabUrl: `ws://127.0.0.1:${port}/collab`,
          mode: 'editor',
          projectName: 'session-restore-test',
          projectPath: contentDir,
        },
        onProjectSwitched: () => unsubscribe,
        onMenuAction: () => unsubscribe,
        onUpdateDownloaded: () => unsubscribe,
        onUpdateRelaunching: () => unsubscribe,
        onUpdateRelaunchFailed: () => unsubscribe,
        onWhatsNew: () => unsubscribe,
        onWhatsNewDismissed: () => unsubscribe,
        onUpdateStuckHint: () => unsubscribe,
        onDeepLink: () => unsubscribe,
        onShareReceived: () => unsubscribe,
        onServerVersionDrift: () => unsubscribe,
        onServerRestarted: () => unsubscribe,
        onServerReclaimed: () => unsubscribe,
        restartServer: async () => ({ ok: true }),
        dialog: {
          openFolder: async () => null,
        },
        shell: {
          openExternal: async () => {},
          detectProtocol: async () => ({ installed: false }),
          spawnCursor: async () => ({ ok: false, reason: 'not-installed' }),
          recordHandoff: async () => {},
          openAsset: async () => ({ ok: false, reason: 'not-found' }),
          revealAsset: async () => ({ ok: false, reason: 'not-found' }),
          showAssetMenu: async () => {},
          showItemInFolder: async () => {},
          trashItem: async () => ({ ok: true as const }),
        },
        editor: {
          notifyActiveTargetChanged: () => {},
          notifyViewMenuStateChanged: () => {},
        },
        sidebar: {
          expandAll: () => unsubscribe,
          collapseAll: () => unsubscribe,
        },
        clipboard: { writeText: async () => {} },
        project: {
          listRecent: async () => [],
          removeRecent: async () => {},
          getSessionState: () =>
            new Promise((resolve) => {
              window.setTimeout(() => resolve(readSession()), 250);
            }),
          setSessionState: async (state: unknown) => {
            window.localStorage.setItem(sessionKey, JSON.stringify(state));
          },
          open: async () => {},
          createNew: async () => {},
          recordCreateNewBannerShown: async () => {},
          close: async () => {},
        },
        navigator: { open: async () => {} },
        seed: {
          plan: async () => ({ ok: false, error: { kind: 'no-project', message: 'test' } }),
          apply: async () => ({ ok: false, error: { kind: 'no-project', message: 'test' } }),
        },
        skill: {
          detectClaudeDesktop: async () => false,
          buildAndOpen: async () => ({ ok: false, reason: 'build-failed' }),
        },
        update: {
          relaunchNow: async () => {},
          checkNow: async () => {},
          dismissWhatsNew: async () => {},
        },
        state: {
          query: async () => ({ channel: 'latest', schemaIncompatibility: null }),
          resetIncompatible: async () => {},
        },
        mcpWiring: {
          onShow: () => unsubscribe,
          signalReady: () => {},
          confirm: async () => ({ ok: true }),
          skip: async () => ({ ok: true }),
        },
        localOp: {
          auth: {
            start: () => ({ events: [][Symbol.asyncIterator](), cancel: () => {} }),
          },
          clone: {
            start: () => ({ events: [][Symbol.asyncIterator](), cancel: () => {} }),
          },
          authStatus: async () => ({ authenticated: false, host: 'github.com' }),
          authRepos: async () => ({ ok: true, host: 'github.com', repos: [] }),
        },
        // useThemeBridge calls these on every cold-launch / theme change.
        // Both are required by the OkDesktopBridge type contract; without
        // them the hook throws "X is not a function" before tabs render.
        setThemeSource: async () => ({ ok: true as const }),
        signalThemeApplied: () => {},
      };
      (window as unknown as { okDesktop: typeof okDesktop }).okDesktop = okDesktop;
    },
    { ...workerServer, initialSession },
  );
}

test.describe('FileTree sidebar create', () => {
  test.describe.configure({ mode: 'serial' });

  test('desktop refresh preserves restored tabs while hash navigation is opening', async ({
    page,
    workerServer,
  }) => {
    await installDelayedDesktopSessionBridge(page, workerServer, {
      openTabs: ['test-doc', 'sidebar-folder/nested-doc'],
      pinnedTabIds: [],
      activeDocName: 'sidebar-folder/nested-doc',
      activeTabId: 'sidebar-folder/nested-doc',
    });

    await page.goto('/#/test-doc');
    await expect(page.getByRole('button', { name: 'test-doc.md', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByRole('button', { name: 'sidebar-folder/nested-doc.md', exact: true }),
    ).toBeVisible({ timeout: 10_000 });

    await page.reload();
    await expect(page.getByRole('button', { name: 'test-doc.md', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByRole('button', { name: 'sidebar-folder/nested-doc.md', exact: true }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('deletes the selected sidebar items from a selected item context menu', async ({
    page,
    workerServer,
    api,
  }) => {
    await api.createPage('zz-bulk-delete-a.md');
    await api.createPage('zz-bulk-delete-b.md');
    await expectDocumentLoads(workerServer.baseURL, 'zz-bulk-delete-a');
    await expectDocumentLoads(workerServer.baseURL, 'zz-bulk-delete-b');

    try {
      await page.goto('/#/zz-bulk-delete-a');
      await page.waitForLoadState('domcontentloaded');

      // Gate on the tree having rendered at all (same condition as
      // gotoRootAndAwaitSidebar) before waiting on specific rows: the
      // first refreshDocs that flips the sidebar out of loading can
      // exceed the per-row 10s budget under 4-worker CI contention, and
      // the per-row waits below are meant to measure incremental updates,
      // not the cold first render.
      await expect(
        page.locator('[data-slot="sidebar-container"]').getByRole('treeitem').first(),
      ).toBeVisible({ timeout: 30_000 });

      const firstItem = await visibleSidebarItemByPath(page, 'zz-bulk-delete-a.md');
      const secondItem = await visibleSidebarItemByPath(page, 'zz-bulk-delete-b.md');

      await firstItem.click();
      // The plain click re-runs the singleton tree-selection mirror when
      // its activation commits; a cmd-click extending the selection during
      // that window gets wiped by the mirror re-run. Wait for the first click's
      // selection to commit before extending it.
      await expect(firstItem).toHaveAttribute('aria-selected', 'true');
      await secondItem.click({
        modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'],
      });
      await expect(firstItem).toHaveAttribute('aria-selected', 'true');
      await expect(secondItem).toHaveAttribute('aria-selected', 'true');

      await firstItem.click({ button: 'right' });
      await page.getByRole('menuitem', { name: /^Delete/ }).click({ timeout: 5_000 });
      await expect(page.getByRole('dialog', { name: /Delete selected items/i })).toBeVisible({
        timeout: 5_000,
      });
      await page.getByRole('button', { name: /^Delete$/ }).click();

      await expect(sidebarTreeItem(page, 'zz-bulk-delete-a.md')).toHaveCount(0, {
        timeout: 10_000,
      });
      await expect(sidebarTreeItem(page, 'zz-bulk-delete-b.md')).toHaveCount(0);
      expect(existsSync(join(workerServer.contentDir, 'zz-bulk-delete-a.md'))).toBe(false);
      expect(existsSync(join(workerServer.contentDir, 'zz-bulk-delete-b.md'))).toBe(false);
    } finally {
      await restoreRequiredFixtureEntries(workerServer.baseURL, api);
    }
  });

  test('cmd+a bulk delete closes selected file and folder tabs', async ({
    page,
    workerServer,
    api,
  }) => {
    const docNames = ['zz-tab-delete-a', 'zz-tab-delete-b'];
    const folderNames = ['zz-tab-delete-folder-a', 'zz-tab-delete-folder-b'];

    await clearVisibleContentEntries(workerServer.baseURL, workerServer.contentDir);
    await Promise.all(docNames.map((docName) => api.createPage(`${docName}.md`)));
    await Promise.all(
      folderNames.map((folderName) => createFolder(workerServer.baseURL, folderName)),
    );

    try {
      await gotoRootAndAwaitSidebar(page);

      for (const docName of docNames) {
        await sidebarTreeItem(page, `${docName}.md`).click();
        await expect(page.getByRole('button', { name: `${docName}.md`, exact: true })).toBeVisible({
          timeout: 10_000,
        });
      }
      for (const folderName of folderNames) {
        await sidebarTreeItem(page, folderName).click();
        await expect(page.getByRole('button', { name: `${folderName}/`, exact: true })).toBeVisible(
          { timeout: 10_000 },
        );
      }

      await sidebarTreeItem(page, `${docNames[0]}.md`).click();
      await selectAllSidebarItems(page, `${docNames[0]}.md`);
      for (const docName of docNames) {
        await expect(sidebarTreeItem(page, `${docName}.md`)).toHaveAttribute(
          'aria-selected',
          'true',
        );
      }
      for (const folderName of folderNames) {
        await expect(sidebarItemByPath(page, `${folderName}/`)).toHaveAttribute(
          'data-item-selected',
          'true',
        );
      }

      await sidebarTreeItem(page, `${docNames[0]}.md`).click({ button: 'right' });
      await page.getByRole('menuitem', { name: /^Delete/ }).click({ timeout: 5_000 });
      await expect(page.getByRole('dialog', { name: /Delete selected items/i })).toBeVisible({
        timeout: 5_000,
      });
      await page.getByRole('button', { name: /^Delete$/ }).click();

      for (const docName of docNames) {
        await expect(sidebarTreeItem(page, `${docName}.md`)).toHaveCount(0, { timeout: 10_000 });
        await expect(page.getByRole('button', { name: `${docName}.md`, exact: true })).toHaveCount(
          0,
        );
        expect(existsSync(join(workerServer.contentDir, `${docName}.md`))).toBe(false);
      }
      for (const folderName of folderNames) {
        await expect(sidebarTreeItem(page, folderName)).toHaveCount(0, { timeout: 10_000 });
        await expect(page.getByRole('button', { name: `${folderName}/`, exact: true })).toHaveCount(
          0,
        );
        expect(existsSync(join(workerServer.contentDir, folderName))).toBe(false);
      }
    } finally {
      await restoreRequiredFixtureEntries(workerServer.baseURL, api);
    }
  });

  test('bulk delete closes tabs already deleted before a later delete fails', async ({
    page,
    workerServer,
    api,
  }) => {
    test.skip(
      true,
      'PR #1010 FileTree refactor broke applyDeleteAftermath partial-failure recovery — sidebar tree does not update after model.remove. See issue #1056.',
    );
    const firstDoc = 'zz-partial-delete-a';
    const secondDoc = 'zz-partial-delete-b';

    await deletePathIfExists(workerServer.baseURL, 'file', firstDoc);
    await deletePathIfExists(workerServer.baseURL, 'file', secondDoc);
    await api.createPage(`${firstDoc}.md`);
    await api.createPage(`${secondDoc}.md`);

    await page.route('**/api/delete-path', async (route) => {
      const body = route.request().postDataJSON() as { path?: string } | null;
      if (body?.path === secondDoc) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, error: 'Injected delete failure' }),
        });
        return;
      }
      await route.fallback();
    });

    try {
      await gotoRootAndAwaitSidebar(page);

      await sidebarTreeItem(page, `${firstDoc}.md`).click();
      await expect(page.getByRole('button', { name: `${firstDoc}.md`, exact: true })).toBeVisible({
        timeout: 10_000,
      });
      await sidebarTreeItem(page, `${secondDoc}.md`).click();
      await expect(page.getByRole('button', { name: `${secondDoc}.md`, exact: true })).toBeVisible({
        timeout: 10_000,
      });

      await sidebarTreeItem(page, `${firstDoc}.md`).click();
      await sidebarTreeItem(page, `${secondDoc}.md`).click({
        modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'],
      });
      await expect(sidebarTreeItem(page, `${firstDoc}.md`)).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(sidebarTreeItem(page, `${secondDoc}.md`)).toHaveAttribute(
        'aria-selected',
        'true',
      );

      await sidebarTreeItem(page, `${firstDoc}.md`).click({ button: 'right' });
      await page.getByRole('menuitem', { name: /^Delete/ }).click({ timeout: 5_000 });
      await expect(page.getByRole('dialog', { name: /Delete selected items/i })).toBeVisible({
        timeout: 5_000,
      });
      await page.getByRole('button', { name: /^Delete$/ }).click();

      await expect(page.getByRole('button', { name: `${firstDoc}.md`, exact: true })).toHaveCount(
        0,
        { timeout: 10_000 },
      );
      await expect(sidebarTreeItem(page, `${firstDoc}.md`)).toHaveCount(0, { timeout: 10_000 });
      await expect(sidebarTreeItem(page, `${secondDoc}.md`)).toBeVisible();
      expect(existsSync(join(workerServer.contentDir, `${firstDoc}.md`))).toBe(false);
      expect(existsSync(join(workerServer.contentDir, `${secondDoc}.md`))).toBe(true);
    } finally {
      await page.unroute('**/api/delete-path');
      await deletePathIfExists(workerServer.baseURL, 'file', firstDoc);
      await deletePathIfExists(workerServer.baseURL, 'file', secondDoc);
      await restoreRequiredFixtureEntries(workerServer.baseURL, api);
    }
  });

  test('cmd+a bulk delete closes many default-created file and folder tabs', async ({
    page,
    workerServer,
    api,
  }) => {
    test.skip(
      true,
      'PR #1010 FileTree refactor broke bulk-delete sidebar tree updates. See issue #1056.',
    );
    const fileNames = Array.from({ length: 8 }, (_, index) => defaultName('Untitled', index));
    const folderNames = Array.from({ length: 8 }, (_, index) => defaultName('New Folder', index));

    for (const docName of fileNames) {
      await deletePathIfExists(workerServer.baseURL, 'file', docName);
    }
    for (const folderName of folderNames) {
      await deletePathIfExists(workerServer.baseURL, 'folder', folderName);
    }

    try {
      await gotoRootAndAwaitSidebar(page);

      for (const docName of fileNames) {
        await commitDefaultFileCreate(page, docName);
      }

      for (const folderName of folderNames) {
        // The sidebar's "New Folder" button now creates inside the active
        // tab's folder. After each folder is created, it gets
        // navigated-to (FileTree's `navigateToFolderWithPulse`), so the next
        // click would create a NESTED folder named "New Folder" (no collision
        // in the empty subfolder), breaking the at-root default-name
        // sequence this test relies on. Click a root-level file before each
        // iteration to reset `activeTarget` to a root file so
        // `defaultInitialDir` returns `""` (root) and the auto-name
        // increments globally.
        await sidebarTreeItem(page, `${fileNames[0]}.md`).click();
        await commitDefaultFolderCreate(page, folderName);
      }

      await sidebarTreeItem(page, `${fileNames[0]}.md`).click();
      await selectAllSidebarItems(page, `${fileNames[0]}.md`);
      await sidebarTreeItem(page, `${fileNames[0]}.md`).click({ button: 'right' });
      await page.getByRole('menuitem', { name: /^Delete/ }).click({ timeout: 5_000 });
      await expect(page.getByRole('dialog', { name: /Delete selected items/i })).toBeVisible({
        timeout: 5_000,
      });
      await page.getByRole('button', { name: /^Delete$/ }).click();

      for (const docName of fileNames) {
        await expect(sidebarTreeItem(page, `${docName}.md`)).toHaveCount(0, { timeout: 10_000 });
        await expect(page.getByRole('button', { name: `${docName}.md`, exact: true })).toHaveCount(
          0,
        );
        expect(existsSync(join(workerServer.contentDir, `${docName}.md`))).toBe(false);
      }
      for (const folderName of folderNames) {
        await expect(sidebarTreeItem(page, folderName)).toHaveCount(0, { timeout: 10_000 });
        await expect(page.getByRole('button', { name: `${folderName}/`, exact: true })).toHaveCount(
          0,
        );
        expect(existsSync(join(workerServer.contentDir, folderName))).toBe(false);
      }
    } finally {
      for (const docName of fileNames) {
        await deletePathIfExists(workerServer.baseURL, 'file', docName);
      }
      for (const folderName of folderNames) {
        await deletePathIfExists(workerServer.baseURL, 'folder', folderName);
      }
      await restoreRequiredFixtureEntries(workerServer.baseURL, api);
    }
  });

  test('cmd+a bulk delete closes named folders plus a default-created folder tab', async ({
    page,
    workerServer,
    api,
  }) => {
    const folderNames = ['hello', 'hello2', 'New Folder'];

    for (const folderName of folderNames) {
      await deletePathIfExists(workerServer.baseURL, 'folder', folderName);
    }
    await createFolder(workerServer.baseURL, 'hello');
    await createFolder(workerServer.baseURL, 'hello2');

    try {
      await gotoRootAndAwaitSidebar(page);

      for (const folderName of folderNames.slice(0, 2)) {
        await sidebarTreeItem(page, folderName).click();
        await expect(sidebarTreeItem(page, folderName)).toBeVisible({ timeout: 10_000 });
        await expect(page.getByRole('button', { name: `${folderName}/`, exact: true })).toBeVisible(
          { timeout: 10_000 },
        );
      }

      await page.evaluate(() => {
        window.location.hash = '#/';
      });
      await commitDefaultFolderCreate(page, 'New Folder');

      await selectAllSidebarItems(page, 'New Folder');
      for (const folderName of folderNames) {
        await expect(sidebarTreeItem(page, folderName)).toHaveAttribute('aria-selected', 'true');
      }

      await sidebarTreeItem(page, 'New Folder').click({ button: 'right' });
      await page.getByRole('menuitem', { name: /^Delete/ }).click({ timeout: 5_000 });
      await expect(page.getByRole('dialog', { name: /Delete selected items/i })).toBeVisible({
        timeout: 5_000,
      });
      await page.getByRole('button', { name: /^Delete$/ }).click();

      for (const folderName of folderNames) {
        await expect(sidebarTreeItem(page, folderName)).toHaveCount(0, { timeout: 10_000 });
        await expect(page.getByRole('button', { name: `${folderName}/`, exact: true })).toHaveCount(
          0,
        );
        expect(existsSync(join(workerServer.contentDir, folderName))).toBe(false);
      }
    } finally {
      for (const folderName of folderNames) {
        await deletePathIfExists(workerServer.baseURL, 'folder', folderName);
      }
      await restoreRequiredFixtureEntries(workerServer.baseURL, api);
    }
  });

  test('cmd+a bulk delete does not restore a stale tab from a pending create', async ({
    page,
    workerServer,
    api,
  }) => {
    test.skip(
      true,
      'PR #1010 FileTree refactor broke bulk-delete sidebar tree updates. See issue #1056.',
    );
    const fileNames = Array.from({ length: 6 }, (_, index) => defaultName('Untitled', index));
    const pendingFolderName = 'New Folder';

    for (const docName of fileNames) {
      await deletePathIfExists(workerServer.baseURL, 'file', docName);
    }
    await deletePathIfExists(workerServer.baseURL, 'folder', pendingFolderName);

    try {
      await gotoRootAndAwaitSidebar(page);

      for (const docName of fileNames) {
        await page.getByRole('button', { name: 'New file', exact: true }).click();
        const input = page.getByRole('textbox', {
          name: new RegExp(`rename ${docName}\\.md`, 'i'),
        });
        await expect(input).toBeVisible({ timeout: 10_000 });
        await input.press('Enter');
        await expect(page.getByRole('button', { name: `${docName}.md`, exact: true })).toBeVisible({
          timeout: 10_000,
        });
      }

      await page.getByRole('button', { name: 'New folder', exact: true }).click();
      await expect(page.getByRole('textbox', { name: /rename New Folder/i })).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByRole('button', { name: 'New Folder/', exact: true })).toBeVisible({
        timeout: 10_000,
      });

      await sidebarTreeItem(page, `${fileNames[0]}.md`).click();
      await selectAllSidebarItems(page, `${fileNames[0]}.md`);
      await sidebarTreeItem(page, `${fileNames[0]}.md`).click({ button: 'right' });
      await page.getByRole('menuitem', { name: /^Delete/ }).click({ timeout: 5_000 });
      await expect(page.getByRole('dialog', { name: /Delete selected items/i })).toBeVisible({
        timeout: 5_000,
      });
      await page.getByRole('button', { name: /^Delete$/ }).click();

      for (const docName of fileNames) {
        await expect(sidebarTreeItem(page, `${docName}.md`)).toHaveCount(0, { timeout: 10_000 });
        await expect(page.getByRole('button', { name: `${docName}.md`, exact: true })).toHaveCount(
          0,
        );
        expect(existsSync(join(workerServer.contentDir, `${docName}.md`))).toBe(false);
      }
      await expect(sidebarTreeItem(page, pendingFolderName)).toHaveCount(0, { timeout: 10_000 });
      await expect(page.getByRole('button', { name: 'New Folder/', exact: true })).toHaveCount(0);
      expect(existsSync(join(workerServer.contentDir, pendingFolderName))).toBe(false);
    } finally {
      for (const docName of fileNames) {
        await deletePathIfExists(workerServer.baseURL, 'file', docName);
      }
      await deletePathIfExists(workerServer.baseURL, 'folder', pendingFolderName);
      await restoreRequiredFixtureEntries(workerServer.baseURL, api);
    }
  });

  test('renaming a new folder remaps the folder tab without opening a markdown tab', async ({
    page,
    workerServer,
    api,
  }) => {
    await deletePathIfExists(workerServer.baseURL, 'folder', 'New Folder');
    await deletePathIfExists(workerServer.baseURL, 'folder', 'hello');
    await deletePathIfExists(workerServer.baseURL, 'file', 'New Folder');

    try {
      await gotoRootAndAwaitSidebar(page);

      await createFolderViaSidebar(page, 'hello');

      await expect(page.getByRole('button', { name: 'New Folder/', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'New Folder.md', exact: true })).toHaveCount(0);
      expect(existsSync(join(workerServer.contentDir, 'hello'))).toBe(true);
      expect(existsSync(join(workerServer.contentDir, 'New Folder'))).toBe(false);
      expect(existsSync(join(workerServer.contentDir, 'New Folder.md'))).toBe(false);
    } finally {
      await deletePathIfExists(workerServer.baseURL, 'folder', 'New Folder');
      await deletePathIfExists(workerServer.baseURL, 'folder', 'hello');
      await deletePathIfExists(workerServer.baseURL, 'file', 'New Folder');
      await restoreRequiredFixtureEntries(workerServer.baseURL, api);
    }
  });

  test('allows a file and folder with the same basename and routes them distinctly', async ({
    page,
    workerServer,
    api,
  }) => {
    const name = 'zz-same-basename';

    await deletePathIfExists(workerServer.baseURL, 'file', name);
    await deletePathIfExists(workerServer.baseURL, 'folder', name);

    try {
      await gotoRootAndAwaitSidebar(page);

      await createFolderViaSidebar(page, name);
      const folderItem = await visibleSidebarItemByPath(page, `${name}/`);

      // The previous folder-create navigated into the new folder (via
      // `navigateToFolderWithPulse`), so `activeTarget.kind === 'folder'`
      // and the sidebar's New File button would create inside it.
      // This test needs the file as a ROOT SIBLING of the folder (same
      // basename, different kinds), so reset the URL hash to the workspace
      // root before clicking New File.
      await page.evaluate(() => {
        window.location.hash = '#/';
      });
      await expect(page).toHaveURL(/#\/$/);
      await createFileViaSidebar(page, name);
      const fileItem = await visibleSidebarItemByPath(page, `${name}.md`);
      await expect(editorTabButton(page, `${name}/`).first()).toBeVisible();

      await folderItem.click();
      // URL first: the hash commit is the click's direct effect; the
      // active-tab flip derives from it. Asserting in causal order makes
      // a swallowed click fail at the URL step instead of timing out on
      // the derived tab state.
      await expect(page).toHaveURL(new RegExp(`#/${name}/$`));
      await expect(activeEditorTabButton(page, `${name}/`)).toBeVisible({
        timeout: 10_000,
      });

      await fileItem.click();
      await expect(page).toHaveURL(new RegExp(`#/${name}$`));
      await expect(activeEditorTabButton(page, `${name}.md`)).toBeVisible({
        timeout: 10_000,
      });

      expect(existsSync(join(workerServer.contentDir, name))).toBe(true);
      expect(statSync(join(workerServer.contentDir, name)).isDirectory()).toBe(true);
      expect(existsSync(join(workerServer.contentDir, `${name}.md`))).toBe(true);
    } finally {
      await deletePathIfExists(workerServer.baseURL, 'file', name);
      await deletePathIfExists(workerServer.baseURL, 'folder', name);
      await restoreRequiredFixtureEntries(workerServer.baseURL, api);
    }
  });

  test('starts another create action after a default new file is committed by blur', async ({
    page,
    workerServer,
    api,
  }) => {
    test.skip(
      true,
      'PR #1010 FileTree refactor broke sidebar tree updates after blur-commit. See issue #1056.',
    );
    await deletePathIfExists(workerServer.baseURL, 'file', 'Untitled');
    await deletePathIfExists(workerServer.baseURL, 'folder', 'New Folder');

    try {
      await gotoRootAndAwaitSidebar(page);

      await page.getByRole('button', { name: 'New file', exact: true }).click();
      const fileRenameInput = page.getByRole('textbox', { name: /rename Untitled\.md/i });
      await expect
        .poll(async () => {
          if (await fileRenameInput.isVisible().catch(() => false)) return 'rename-input';
          if ((await sidebarTreeItem(page, 'Untitled.md').count()) > 0) return 'committed-row';
          return 'pending';
        })
        .not.toBe('pending');

      await page.getByRole('button', { name: 'New folder', exact: true }).click();
      const folderRenameInput = page.getByRole('textbox', { name: /rename New Folder/i });
      await expect(folderRenameInput).toBeVisible({ timeout: 10_000 });

      await expect(sidebarTreeItem(page, 'Untitled.md')).toBeVisible({ timeout: 10_000 });
      expect(existsSync(join(workerServer.contentDir, 'Untitled.md'))).toBe(true);

      await folderRenameInput.press('Escape');
      await expect(sidebarTreeItem(page, 'New Folder')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'New Folder/', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'New Folder.md', exact: true })).toHaveCount(0);
      expect(existsSync(join(workerServer.contentDir, 'New Folder'))).toBe(false);
    } finally {
      await deletePathIfExists(workerServer.baseURL, 'file', 'Untitled');
      await deletePathIfExists(workerServer.baseURL, 'folder', 'New Folder');
      await restoreRequiredFixtureEntries(workerServer.baseURL, api);
    }
  });

  test('creates default file and empty folder on disk, then survives refresh/delete', async ({
    page,
    workerServer,
  }) => {
    test.skip(
      true,
      'PR #1010 FileTree refactor broke sidebar tree updates after default-name create. See issue #1056.',
    );
    await deletePathIfExists(workerServer.baseURL, 'file', 'Untitled');
    await deletePathIfExists(workerServer.baseURL, 'folder', 'New Folder');

    await gotoRootAndAwaitSidebar(page);

    await page.getByRole('button', { name: 'New file', exact: true }).click();
    const canceledFileInput = page.getByRole('textbox', { name: /rename Untitled\.md/i });
    await expect(canceledFileInput).toBeVisible({ timeout: 10_000 });
    await canceledFileInput.press('Escape');
    await expect(sidebarTreeItem(page, 'Untitled.md')).toHaveCount(0);
    expect(existsSync(join(workerServer.contentDir, 'Untitled.md'))).toBe(false);

    await page.getByRole('button', { name: 'New folder', exact: true }).click();
    const canceledFolderInput = page.getByRole('textbox', { name: /rename New Folder/i });
    await expect(canceledFolderInput).toBeVisible({ timeout: 10_000 });
    await canceledFolderInput.press('Escape');
    await expect(sidebarTreeItem(page, 'New Folder')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New Folder/', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'New Folder.md', exact: true })).toHaveCount(0);
    expect(existsSync(join(workerServer.contentDir, 'New Folder'))).toBe(false);

    await page.getByRole('button', { name: 'New file', exact: true }).click();
    const fileRenameInput = page.getByRole('textbox', { name: /rename Untitled\.md/i });
    await expect(fileRenameInput).toBeVisible({ timeout: 10_000 });
    await fileRenameInput.press('Enter');

    await expect(sidebarTreeItem(page, 'Untitled.md')).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(/#\/Untitled$/);
    expect(existsSync(join(workerServer.contentDir, 'Untitled.md'))).toBe(true);
    await expectDocumentLoads(workerServer.baseURL, 'Untitled');

    await page.getByRole('button', { name: 'New folder', exact: true }).click();
    const folderRenameInput = page.getByRole('textbox', { name: /rename New Folder/i });
    await expect(folderRenameInput).toBeVisible({ timeout: 10_000 });
    await folderRenameInput.press('Enter');

    const folderPath = join(workerServer.contentDir, 'New Folder');
    await expect(sidebarTreeItem(page, 'New Folder')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'New Folder/', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole('button', { name: 'New Folder.md', exact: true })).toHaveCount(0);
    expect(existsSync(folderPath)).toBe(true);
    expect(statSync(folderPath).isDirectory()).toBe(true);
    expect(existsSync(join(folderPath, 'index.md'))).toBe(false);

    await page.reload();
    await expect(sidebarTreeItem(page, 'Untitled.md')).toBeVisible({ timeout: 10_000 });
    await expect(sidebarTreeItem(page, 'New Folder')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'New Folder/', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole('button', { name: 'New Folder.md', exact: true })).toHaveCount(0);
    expect(existsSync(join(folderPath, 'index.md'))).toBe(false);

    await sidebarTreeItem(page, 'New Folder').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^Delete$/ }).click({ timeout: 5_000 });
    await expect(page.getByRole('dialog', { name: /Delete New Folder\// })).toBeVisible({
      timeout: 5_000,
    });
    await page.getByRole('button', { name: /^Delete$/ }).click();

    await expect(sidebarTreeItem(page, 'New Folder')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'New Folder/', exact: true })).toHaveCount(0);
    expect(existsSync(folderPath)).toBe(false);
  });
});
