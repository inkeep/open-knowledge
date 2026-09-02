import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './_helpers';

function uniqueStamp(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const sidebar = (page: Page) => page.locator('[data-slot="sidebar-container"]');
const fileRow = (page: Page, fileName: string) =>
  sidebar(page).getByRole('treeitem', { name: fileName, exact: true });
const folderRow = (page: Page, folderName: string) =>
  sidebar(page).getByRole('treeitem', { name: folderName, exact: true });
const selectedRow = (page: Page) => sidebar(page).locator('[aria-selected="true"]');
const treeScroller = (page: Page) => sidebar(page).locator('[data-file-tree-virtualized-scroll]');

const editorHeading = (page: Page, text: string) =>
  page.locator('.ProseMirror:not(.composer-prosemirror) h1', { hasText: text });

async function settleFrames(page: Page, frames = 5): Promise<void> {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let remaining = count;
        const tick = () => {
          if (--remaining <= 0) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    frames,
  );
}

async function waitForPagesToInclude(baseURL: string, docNames: string[]): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await fetch(`${baseURL}/api/pages`).catch(() => null);
        if (!response?.ok) return ['__pages-fetch-failed__'];
        const data = (await response.json()) as { pages?: Array<{ docName: string }> };
        const known = new Set((data.pages ?? []).map((entry) => entry.docName));
        return docNames.filter((name) => !known.has(name));
      },
      { timeout: 15_000 },
    )
    .toEqual([]);
}

async function createFolder(baseURL: string, path: string): Promise<void> {
  const response = await fetch(`${baseURL}/api/create-folder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!response.ok && response.status !== 409) {
    throw new Error(`create-folder failed for ${path}: ${response.status}`);
  }
}

test('opening a tree-hidden doc keeps the tree quiet: previous row deselects, no auto-scroll', async ({
  page,
  api,
  workerServer,
}) => {
  const stamp = uniqueStamp();
  const hiddenDir = `.quiet-scratch-${stamp}`;
  const hiddenDocName = `${hiddenDir}/hidden-note`;
  const targetDoc = `zz-quiet-target-${stamp}`;

  const fillerNames = Array.from(
    { length: 40 },
    (_, i) => `quiet-filler-${stamp}-${String(i).padStart(2, '0')}`,
  );
  for (const name of fillerNames) {
    await api.createPage(`${name}.md`);
  }
  await api.createPage(`${targetDoc}.md`);

  mkdirSync(join(workerServer.contentDir, hiddenDir), { recursive: true });
  writeFileSync(
    join(workerServer.contentDir, hiddenDir, 'hidden-note.md'),
    '# Quiet hidden note\n',
    'utf-8',
  );
  await waitForPagesToInclude(workerServer.baseURL, [hiddenDocName, targetDoc]);

  await page.goto(`/#/${targetDoc}`);
  await fileRow(page, `${targetDoc}.md`).waitFor({ state: 'visible', timeout: 15_000 });
  await expect(selectedRow(page)).toHaveCount(1);
  await expect(selectedRow(page)).toHaveAttribute('aria-label', `${targetDoc}.md`);

  expect(await treeScroller(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await treeScroller(page).evaluate((el) => {
    el.scrollTop = 0;
  });
  expect(await treeScroller(page).evaluate((el) => el.scrollTop)).toBe(0);

  await page.evaluate((docName) => {
    window.location.hash = `#/${docName}`;
  }, hiddenDocName);

  await expect(editorHeading(page, 'Quiet hidden note')).toBeVisible({ timeout: 15_000 });

  await settleFrames(page);
  await expect(selectedRow(page)).toHaveCount(0);
  expect(await treeScroller(page).evaluate((el) => el.scrollTop)).toBe(0);

  await treeScroller(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await fileRow(page, `${targetDoc}.md`).waitFor({ state: 'visible', timeout: 15_000 });
  await expect(selectedRow(page)).toHaveCount(0);
});

test('visible ancestors of a partially-hidden path stay expanded while the tree stays quiet', async ({
  page,
  api,
  workerServer,
}) => {
  const stamp = uniqueStamp();
  const startDoc = `quiet-start-${stamp}`;
  const parentFolder = `quiet-parent-${stamp}`;
  const hiddenChildDocName = `${parentFolder}/.hidden-child`;

  await createFolder(workerServer.baseURL, parentFolder);
  await api.createPage(`${startDoc}.md`);
  await api.createPage(`${parentFolder}/sibling-note.md`);
  writeFileSync(
    join(workerServer.contentDir, parentFolder, '.hidden-child.md'),
    '# Quiet hidden child\n',
    'utf-8',
  );
  await waitForPagesToInclude(workerServer.baseURL, [hiddenChildDocName, startDoc]);

  await page.goto(`/#/${startDoc}`);
  await fileRow(page, `${startDoc}.md`).waitFor({ state: 'visible', timeout: 15_000 });
  await expect(selectedRow(page)).toHaveCount(1);
  await expect(selectedRow(page)).toHaveAttribute('aria-label', `${startDoc}.md`);

  await treeScroller(page).evaluate((el) => {
    el.scrollTop = 0;
  });
  await folderRow(page, parentFolder).waitFor({ state: 'visible', timeout: 15_000 });
  await expect(folderRow(page, parentFolder)).toHaveAttribute('aria-expanded', 'false');

  await page.evaluate((docName) => {
    window.location.hash = `#/${docName}`;
  }, hiddenChildDocName);

  await expect(editorHeading(page, 'Quiet hidden child')).toBeVisible({ timeout: 15_000 });

  await expect(folderRow(page, parentFolder)).toHaveAttribute('aria-expanded', 'true');
  await settleFrames(page);
  await expect(folderRow(page, parentFolder)).toHaveAttribute('aria-expanded', 'true');
  await expect(selectedRow(page)).toHaveCount(0);
  expect(await treeScroller(page).evaluate((el) => el.scrollTop)).toBe(0);
});

test('the not-in-sidebar indicator names the hiding toggle and its flip reveals the row', async ({
  page,
  workerServer,
}) => {
  const stamp = uniqueStamp();
  const hiddenDir = `.indicator-scratch-${stamp}`;
  const hiddenDocName = `${hiddenDir}/indicator-note`;

  mkdirSync(join(workerServer.contentDir, hiddenDir), { recursive: true });
  writeFileSync(
    join(workerServer.contentDir, hiddenDir, 'indicator-note.md'),
    '# Indicator note\n',
    'utf-8',
  );
  await waitForPagesToInclude(workerServer.baseURL, [hiddenDocName]);

  await page.goto(`/#/${hiddenDocName}`);
  await expect(editorHeading(page, 'Indicator note')).toBeVisible({ timeout: 15_000 });

  const indicator = page.getByTestId('not-in-sidebar-indicator');
  await expect(indicator).toBeVisible();
  await expect(page.getByTestId('not-in-sidebar-flip-hidden-files')).toBeVisible();
  await expect(page.getByTestId('not-in-sidebar-flip-only-markdown')).toHaveCount(0);
  await expect(selectedRow(page)).toHaveCount(0);

  await page.getByTestId('not-in-sidebar-flip-hidden-files').click();
  await fileRow(page, 'indicator-note.md').waitFor({ state: 'visible', timeout: 15_000 });
  await expect(indicator).toHaveCount(0);
  await expect(selectedRow(page)).toHaveAttribute('aria-label', 'indicator-note.md');

  await page.getByRole('button', { name: 'Tree view options' }).click();
  await page.getByTestId('tree-options-show-hidden-files').click();
  await expect(fileRow(page, 'indicator-note.md')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('not-in-sidebar-indicator')).toBeVisible();
  await expect(selectedRow(page)).toHaveCount(0);
});
