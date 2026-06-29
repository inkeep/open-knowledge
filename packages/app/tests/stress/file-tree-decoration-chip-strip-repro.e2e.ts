import { existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { expect, test } from './_helpers';

test.describe('CHECK: renderRowDecoration is robust through inline rename', () => {
  test('symlink badge stays present at every step of inline rename', async ({
    page,
    api,
    workerServer,
  }) => {
    await api.seedDocs([{ name: 'target', markdown: '# Target\n\nContent.\n' }]);
    const symlinkPath = join(workerServer.contentDir, 'foo.md');
    if (!existsSync(symlinkPath)) {
      symlinkSync('target.md', symlinkPath);
    }

    await page.goto('/');
    const sidebar = page.locator('[data-slot="sidebar-container"]');
    await expect(sidebar.getByRole('treeitem', { name: 'foo.md', exact: true })).toBeVisible({
      timeout: 20_000,
    });

    const fooRow = sidebar.locator('[data-type="item"][data-item-path="foo.md"]');
    await expect(fooRow).toBeVisible();

    const decorationCell = fooRow.locator('[data-item-section="decoration"]');
    const decorationIcon = decorationCell.locator('svg, [data-icon-token]');
    await expect(decorationIcon).toHaveCount(1, { timeout: 5_000 });

    await fooRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: /rename/i }).click({ timeout: 5_000 });
    const renameInput = sidebar.getByRole('textbox', { name: /rename foo\.md/i });
    await expect(renameInput).toBeVisible({ timeout: 5_000 });

    await expect(renameInput).toHaveValue('foo.md');

    await expect(fooRow).toBeVisible(); // still queryable by data-item-path="foo.md"
    const extensionlessRow = sidebar.locator('[data-type="item"][data-item-path="foo"]');
    await expect(extensionlessRow).toHaveCount(0); // no extensionless row exists

    await expect(decorationIcon).toHaveCount(1);

    await renameInput.fill('bar.md');
    await wait(150); // settle

    await expect(fooRow).toBeVisible();
    const barRow = sidebar.locator('[data-type="item"][data-item-path="bar"]');
    await expect(barRow).toHaveCount(0);

    await expect(decorationIcon).toHaveCount(1);

    await renameInput.press('Escape');
    await wait(150);

    await expect(fooRow).toBeVisible();
    await expect(decorationIcon).toHaveCount(1);
  });
});
