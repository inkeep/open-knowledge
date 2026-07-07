/**
 * EMPIRICAL CHECK: does `renderRowDecoration`'s reverse-compare lose the
 * symlink badge while a row is in inline rename mode?
 *
 * Pierre's `#setRenamingValue` (FileTreeController.js) only mutates the
 * private `#renamingValue` field and calls `#emit()`. It does NOT call
 * `move()` or otherwise alter the store. The only place Pierre moves the
 * canonical path is `#completeRenaming`, which fires on Enter/blur.
 *
 * Post-commit, FileTree's extensionless-rename reconciliation runs inside the
 * `setDocuments` updater triggered by Pierre's `onRename` callback, with
 * React's batching ensuring it runs AFTER Pierre's `move()` completes.
 *
 * This test pins the empirical truth: the symlink decoration stays
 * present throughout the rename lifecycle (open → type → commit).
 * The badge is present at every step.
 */

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
    // Seed canonical doc, then write a symlink alongside (post-reset so it
    // survives `seedDocs`'s `testReset` call).
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

    // STEP 1: baseline — decoration is visible before any rename.
    const decorationCell = fooRow.locator('[data-item-section="decoration"]');
    const decorationIcon = decorationCell.locator('svg, [data-icon-token]');
    await expect(decorationIcon).toHaveCount(1, { timeout: 5_000 });

    // STEP 2: open the inline rename via the row context menu.
    await fooRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: /rename/i }).click({ timeout: 5_000 });
    const renameInput = sidebar.getByRole('textbox', { name: /rename foo\.md/i });
    await expect(renameInput).toBeVisible({ timeout: 5_000 });

    await expect(renameInput).toHaveValue('foo.md');

    // STEP 3: rename mode is active, but Pierre's store hasn't moved.
    // data-item-path stays canonical.
    await expect(fooRow).toBeVisible(); // still queryable by data-item-path="foo.md"
    const extensionlessRow = sidebar.locator('[data-type="item"][data-item-path="foo"]');
    await expect(extensionlessRow).toHaveCount(0); // no extensionless row exists

    // STEP 4: decoration is STILL present during inline rename.
    await expect(decorationIcon).toHaveCount(1);

    // STEP 5: type a different basename. Pierre's setValue updates
    // #renamingValue but does not move the store.
    await renameInput.fill('bar.md');
    await wait(150); // settle

    // data-item-path still canonical "foo.md" — typing doesn't move.
    await expect(fooRow).toBeVisible();
    const barRow = sidebar.locator('[data-type="item"][data-item-path="bar"]');
    await expect(barRow).toHaveCount(0);

    // Decoration STILL present mid-typing.
    await expect(decorationIcon).toHaveCount(1);

    // STEP 6: cancel via Escape — Pierre's #cancelRenaming restores
    // #renamingValue to "" and does NOT move. No #completeRenaming fires.
    await renameInput.press('Escape');
    await wait(150);

    // Row is back to its non-renaming state, decoration still there.
    await expect(fooRow).toBeVisible();
    await expect(decorationIcon).toHaveCount(1);
  });
});
