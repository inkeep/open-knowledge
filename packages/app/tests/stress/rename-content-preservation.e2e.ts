/**
 * Regression coverage for two related bugs surfaced by sidebar inline rename:
 *   1. Rename data-loss — see `handleSelectionChange` guard in
 *      `packages/app/src/components/FileTree.tsx` for the mechanism.
 *   2. Phantom file creation from openDirectConnection on a missing doc —
 *      see `onStoreDocument` phantom-doc guard in
 *      `packages/server/src/persistence.ts`. The e2e here covers the live
 *      `/api/document` entry point.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

const MARKER = 'zebra-marker-7892';
const DOC_CONTENT = `# Hello

This file has memorable content: ${MARKER}.
`;

// Persistence debounce is 2s. Wait past it with a small buffer so any late
// phantom store would have completed by the time we assert disk state.
const PERSISTENCE_SETTLE_MS = 3_000;

const sidebar = (page: Page) => page.locator('[data-slot="sidebar-container"]');
const folderRow = (page: Page, folderName: string) =>
  sidebar(page).getByRole('treeitem', { name: folderName, exact: true });

test.describe('FileTree sidebar rename — content preservation', () => {
  test('content stays in editor and on disk; no orphan at old path', async ({
    page,
    api,
    workerServer,
  }) => {
    await api.seedDocs([{ name: 'source-doc', markdown: DOC_CONTENT }]);
    await page.goto('/#/source-doc');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).toContainText(MARKER, {
      timeout: 15_000,
    });

    // Inline-rename via the sidebar context menu — exercises the @pierre/trees
    // selection-follows-rename path that triggered the data-loss bug.
    const sourceItem = page.getByRole('treeitem', { name: /source-doc\.md/ });
    await sourceItem.click({ button: 'right' });
    await page.getByRole('menuitem', { name: /rename/i }).click({ timeout: 5_000 });
    const renameInput = page.getByRole('textbox', { name: /rename source-doc\.md/i });
    await renameInput.fill('renamed-doc.md');
    await renameInput.press('Enter');

    // Editor displays the renamed doc with the original content.
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).toContainText(MARKER, {
      timeout: 15_000,
    });

    // Wait past the persistence debounce so any late phantom-write would
    // have landed before we assert disk state.
    await wait(PERSISTENCE_SETTLE_MS);

    // File on disk at the new path holds the content.
    const renamedContent = readFileSync(join(workerServer.contentDir, 'renamed-doc.md'), 'utf-8');
    expect(renamedContent).toContain(MARKER);

    // No orphan at the original path.
    const oldPath = join(workerServer.contentDir, 'source-doc.md');
    expect(existsSync(oldPath)).toBe(false);
  });

  test('renaming the active doc keeps navigation on the renamed doc while page list refresh lags', async ({
    page,
    api,
  }) => {
    await api.seedDocs([
      { name: 'foo/index', markdown: '# Foo index' },
      { name: 'bar/hello', markdown: '# Bar hello\n\nrename-stays-here' },
    ]);

    let serveLaggingPages = false;
    let laggingPagesServed = 0;

    await page.route('**/api/pages', async (route) => {
      if (!serveLaggingPages) {
        await route.fallback();
        return;
      }

      laggingPagesServed++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          pages: [
            {
              docName: 'foo/index',
              title: 'Foo index',
              size: 11,
              modified: '2026-05-08T00:00:00.000Z',
              docExt: '.md',
            },
          ],
        }),
      });
    });

    await page.route('**/api/rename-path', async (route) => {
      const body = route.request().postDataJSON() as { fromPath?: string; toPath?: string } | null;
      const response = await route.fetch();
      if (body?.fromPath === 'bar/hello' && body?.toPath === 'bar/something') {
        serveLaggingPages = true;
      }
      await route.fulfill({ response });
    });

    await page.goto('/#/foo/index');
    await expect(page.getByRole('button', { name: 'foo/index.md', exact: true })).toBeVisible({
      timeout: 10_000,
    });

    await page.goto('/#/bar/hello');
    await expect(page.getByRole('button', { name: 'bar/hello.md', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).toContainText(
      'rename-stays-here',
      {
        timeout: 15_000,
      },
    );

    const sourceItem = page.getByRole('treeitem', { name: 'hello.md', exact: true });
    await sourceItem.click({ button: 'right' });
    await page.getByRole('menuitem', { name: /rename/i }).click({ timeout: 5_000 });
    const renameInput = page.getByRole('textbox', { name: /rename hello\.md/i });
    await renameInput.fill('something.md');
    await renameInput.press('Enter');

    await expect.poll(() => laggingPagesServed, { timeout: 10_000 }).toBeGreaterThan(0);
    await expect(page).toHaveURL(/#\/bar\/something$/);
    await expect(page.getByRole('button', { name: 'bar/something.md', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('.ProseMirror:not(.composer-prosemirror)')).toContainText(
      'rename-stays-here',
      {
        timeout: 15_000,
      },
    );
  });

  test('renaming the active doc preserves expanded non-active nested folders', async ({
    page,
    api,
  }) => {
    await api.seedDocs([
      { name: 'foo/deep/leaf', markdown: '# Leaf' },
      { name: 'bar/hello', markdown: '# Bar hello\n\nrename-stays-here' },
    ]);

    await page.goto('/#/bar/hello');
    await expect(page.getByRole('button', { name: 'bar/hello.md', exact: true })).toBeVisible({
      timeout: 10_000,
    });

    const fooRow = folderRow(page, 'foo');
    await expect(fooRow).toHaveAttribute('aria-expanded', 'false', { timeout: 10_000 });
    await fooRow.focus();
    await fooRow.press('ArrowRight');
    await expect(fooRow).toHaveAttribute('aria-expanded', 'true');

    const deepRow = folderRow(page, 'deep');
    await expect(deepRow).toHaveAttribute('aria-expanded', 'false', { timeout: 10_000 });
    await deepRow.focus();
    await deepRow.press('ArrowRight');
    await expect(deepRow).toHaveAttribute('aria-expanded', 'true');
    await expect(sidebar(page).getByRole('treeitem', { name: 'leaf.md', exact: true })).toBeVisible(
      { timeout: 10_000 },
    );

    const sourceItem = page.getByRole('treeitem', { name: 'hello.md', exact: true });
    await sourceItem.click({ button: 'right' });
    await page.getByRole('menuitem', { name: /rename/i }).click({ timeout: 5_000 });
    const renameInput = page.getByRole('textbox', { name: /rename hello\.md/i });
    await renameInput.fill('something.md');
    await renameInput.press('Enter');

    await expect(page).toHaveURL(/#\/bar\/something$/);
    await expect(page.getByRole('button', { name: 'bar/something.md', exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(fooRow).toHaveAttribute('aria-expanded', 'true');
    await expect(deepRow).toHaveAttribute('aria-expanded', 'true');
    await expect(sidebar(page).getByRole('treeitem', { name: 'leaf.md', exact: true })).toBeVisible(
      { timeout: 10_000 },
    );
  });

  test('phantom guard: opening a non-existent doc does NOT create a file', async ({
    page,
    workerServer,
  }) => {
    // No seed — the doc has never existed.
    await page.goto(workerServer.baseURL);
    await page.waitForLoadState('domcontentloaded');

    // Trigger an openDirectConnection on a non-existent docName via the
    // public read endpoint. Without the persistence guard, the resulting
    // empty Y.Doc would be persisted as a 0-byte file at the corresponding
    // path on the next debounced onStoreDocument.
    await page.evaluate(async () => {
      await fetch('/api/document?docName=nonexistent-ghost').then((r) => r.json());
    });

    // Wait past the persistence debounce window.
    await wait(PERSISTENCE_SETTLE_MS);

    const ghostPath = join(workerServer.contentDir, 'nonexistent-ghost.md');
    expect(existsSync(ghostPath)).toBe(false);
  });
});
