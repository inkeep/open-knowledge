import { expect, test } from './_helpers';

const SENTINEL = 'HelloWorldUniqueSentinel987';

test.describe('create → inline-rename → click → type', () => {
  test('newly-created file is editable on first click after inline rename', async ({
    page,
    workerServer,
  }) => {
    const uniqueName = `dhx-${Math.random().toString(36).slice(2, 10)}`;

    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    const sidebar = page.locator('[data-slot="sidebar-container"]');
    await expect(sidebar.getByRole('treeitem').first()).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'New file', exact: true }).click();
    const renameInput = page.getByRole('textbox', { name: /rename Untitled/i });
    await expect(renameInput).toBeVisible({ timeout: 10_000 });

    await renameInput.fill(uniqueName);
    await renameInput.press('Enter');

    await expect(
      sidebar.getByRole('treeitem', { name: `${uniqueName}.md`, exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page
        .locator('[data-active-tab="true"]')
        .getByRole('button', { name: `${uniqueName}.md`, exact: true }),
    ).toBeVisible({ timeout: 10_000 });

    const proseMirror = page.locator('.ProseMirror:not(.composer-prosemirror)').first();
    await expect(proseMirror).toBeVisible({ timeout: 10_000 });
    await proseMirror.click();

    await page.keyboard.insertText(SENTINEL);

    await expect(proseMirror).toContainText(SENTINEL, { timeout: 5_000 });

    await page.waitForFunction(
      (s) => window.__activeProvider?.document?.getText('source')?.toString()?.includes(s) ?? false,
      SENTINEL,
      { timeout: 5_000 },
    );

    const isEditable = await page.evaluate(() => window.__activeEditor?.isEditable);
    expect(isEditable).toBe(true);

    const stuckWarmFallbackCount = await page.locator('.tiptap-editor[aria-hidden="true"]').count();
    expect(stuckWarmFallbackCount).toBe(0);

    expect(workerServer.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
