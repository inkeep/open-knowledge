import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './_helpers';

const PLACEHOLDER = 'Start writing to create this page';

function uniqueStamp(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const fileRow = (page: Page, fileName: string) =>
  page
    .locator('[data-slot="sidebar-container"]')
    .getByRole('treeitem', { name: fileName, exact: true });

const visibleEditor = (page: Page) =>
  page.locator('.ProseMirror:not(.composer-prosemirror)').filter({ visible: true }).first();

function emptyPlaceholder(editor: Locator): Promise<string> {
  return editor.evaluate((element) => getComputedStyle(element, '::before').content);
}

async function openMissingPage(page: Page, anchorDoc: string, missingDoc: string): Promise<void> {
  await page.goto(`/#/${anchorDoc}`);
  await fileRow(page, `${anchorDoc}.md`).waitFor({ state: 'visible', timeout: 15_000 });
  await page.evaluate((docName) => {
    window.location.hash = `#/${docName}`;
  }, missingDoc);
}

test('a page that does not exist yet shows the create placeholder and writes nothing while viewed', async ({
  page,
  api,
  workerServer,
}) => {
  const stamp = uniqueStamp();
  const anchorDoc = `placeholder-anchor-${stamp}`;
  const missingDoc = `placeholder-missing-${stamp}`;
  await api.createPage(`${anchorDoc}.md`);

  await openMissingPage(page, anchorDoc, missingDoc);

  const editor = visibleEditor(page);
  await expect.poll(() => emptyPlaceholder(editor), { timeout: 15_000 }).toBe(`"${PLACEHOLDER}"`);
  await expect(editor).toBeVisible();
  expect(await editor.evaluate((element) => element.childElementCount)).toBe(0);
  expect(existsSync(join(workerServer.contentDir, `${missingDoc}.md`))).toBe(false);
});

test('a cold load straight to a page that does not exist yet shows the create placeholder', async ({
  page,
  workerServer,
}) => {
  const missingDoc = `placeholder-cold-${uniqueStamp()}`;

  await page.goto(`/#/${missingDoc}`);

  const editor = visibleEditor(page);
  await expect.poll(() => emptyPlaceholder(editor), { timeout: 15_000 }).toBe(`"${PLACEHOLDER}"`);
  expect(existsSync(join(workerServer.contentDir, `${missingDoc}.md`))).toBe(false);
});

test('typing into a page that does not exist yet hides the placeholder and creates the page', async ({
  page,
  api,
  workerServer,
}) => {
  const stamp = uniqueStamp();
  const anchorDoc = `placeholder-anchor-${stamp}`;
  const missingDoc = `placeholder-typed-${stamp}`;
  const typed = `Created from the placeholder ${stamp}`;
  await api.createPage(`${anchorDoc}.md`);

  await openMissingPage(page, anchorDoc, missingDoc);

  const editor = visibleEditor(page);
  await expect.poll(() => emptyPlaceholder(editor), { timeout: 15_000 }).toBe(`"${PLACEHOLDER}"`);
  await editor.click();
  await page.keyboard.insertText(typed);

  await expect(editor).toContainText(typed, { timeout: 5_000 });
  await expect.poll(() => emptyPlaceholder(editor)).toBe('none');
  const path = join(workerServer.contentDir, `${missingDoc}.md`);
  await expect
    .poll(() => (existsSync(path) ? readFileSync(path, 'utf-8') : ''), { timeout: 15_000 })
    .toContain(typed);
});
