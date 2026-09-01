import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

const NEW_FILE_DIALOG = /New file/i;

async function putRootTemplate(baseURL: string, name: string): Promise<void> {
  const res = await fetch(`${baseURL}/api/template`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder: '', name, frontmatter: { title: name }, body: 'Template body' }),
  });
  if (!res.ok) throw new Error(`PUT /api/template failed: ${res.status} ${await res.text()}`);
}

async function deleteRootTemplate(baseURL: string, name: string): Promise<void> {
  const res = await fetch(`${baseURL}/api/template?${new URLSearchParams({ folder: '', name })}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 404) throw new Error(`DELETE /api/template failed: ${res.status}`);
}

async function deleteDoc(baseURL: string, docName: string): Promise<void> {
  const res = await fetch(`${baseURL}/api/delete-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'file', path: `${docName}.md` }),
  });
  if (!res.ok && res.status !== 404) throw new Error(`delete-path failed: ${res.status}`);
}

async function gotoWithFolderConfig(page: Page, hash: string): Promise<void> {
  const folderConfigLanded = page.waitForResponse(
    (res) => res.url().includes('/api/folder-config') && res.ok(),
    { timeout: 15_000 },
  );
  await page.goto(hash);
  await page.waitForLoadState('domcontentloaded');
  await folderConfigLanded;
  await waitForActiveProviderSynced(page);
}

async function pressNewItemShortcut(page: Page): Promise<void> {
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.waitForFunction(
    () => document.activeElement === null || document.activeElement === document.body,
    null,
    { timeout: 1_000 },
  );
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Alt+KeyN`);
}

test.describe('new-item shortcut fast path', () => {
  test.describe.configure({ mode: 'serial' });

  test('no templates: creates untitled docs without the dialog, numbering past the taken names', async ({
    page,
    workerServer,
  }) => {
    await deleteDoc(workerServer.baseURL, 'untitled');
    await deleteDoc(workerServer.baseURL, 'untitled-2');
    await gotoWithFolderConfig(page, '/#/test-doc');

    await pressNewItemShortcut(page);
    await page.waitForFunction(() => window.location.hash === '#/untitled', null, {
      timeout: 10_000,
    });
    await expect(page.getByRole('dialog', { name: NEW_FILE_DIALOG })).toBeHidden();
    await waitForActiveProviderSynced(page);

    await pressNewItemShortcut(page);
    await page.waitForFunction(() => window.location.hash === '#/untitled-2', null, {
      timeout: 10_000,
    });
    await expect(page.getByRole('dialog', { name: NEW_FILE_DIALOG })).toBeHidden();

    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('ControlOrMeta+KeyK');
    await page
      .getByRole('option', { name: /^New file/ })
      .first()
      .click();
    const dialog = page.getByRole('dialog', { name: NEW_FILE_DIALOG });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByLabel(/^File name$/i)).toBeVisible();
    await expect(dialog.getByText('Start from')).toHaveCount(0);

    await deleteDoc(workerServer.baseURL, 'untitled');
    await deleteDoc(workerServer.baseURL, 'untitled-2');
  });

  test('a failed fast create surfaces the error and falls back to the dialog', async ({ page }) => {
    await gotoWithFolderConfig(page, '/#/test-doc');

    await page.route('**/api/create-page', async (route) => {
      await route.fulfill({
        status: 409,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'urn:ok:error:doc-already-exists',
          title: 'A file named untitled already exists',
        }),
      });
    });

    await pressNewItemShortcut(page);

    await expect(page.getByRole('dialog', { name: NEW_FILE_DIALOG })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('[data-sonner-toast]', { hasText: /already exists/i })).toBeVisible();
  });

  test('a resolved template brings the dialog back, with the picker', async ({
    page,
    workerServer,
  }) => {
    const templateName = 'zz-shortcut-fast-path-template';
    await putRootTemplate(workerServer.baseURL, templateName);
    try {
      await gotoWithFolderConfig(page, '/#/test-doc');

      await pressNewItemShortcut(page);
      const dialog = page.getByRole('dialog', { name: NEW_FILE_DIALOG });
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      await expect(dialog.getByText('Start from')).toBeVisible();
      await expect(dialog.getByRole('combobox')).toBeVisible();
    } finally {
      await deleteRootTemplate(workerServer.baseURL, templateName);
    }
  });
});
