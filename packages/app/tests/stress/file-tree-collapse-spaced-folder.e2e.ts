/**
 * A folder whose name contains a space must collapse like any other folder.
 *
 * The tree's click-capture handler intercepts a folder click to navigate to
 * that folder's page, and steps aside — letting @pierre/trees toggle the row —
 * only when the URL already points at that folder. That check compared
 * `window.location.hash` (which the browser percent-encodes) against
 * `hashFromFolderPath` (which emits the path raw), so for a name with a space
 * it was never true: every click was swallowed, and the folder could be
 * expanded but never collapsed. A space-free sibling is the control.
 */
import { expect, resetContentToFixtureBaseline, test } from './_helpers';

const SIDEBAR = '[data-slot="sidebar-container"]';

test.describe('file-tree collapse with a spaced folder name', () => {
  test.beforeEach(async ({ workerServer }) => {
    await resetContentToFixtureBaseline(workerServer.baseURL, workerServer.contentDir);
  });

  test('a folder named with a space toggles open and closed on click', async ({ page, api }) => {
    await api.seedDocs([
      { name: 'consolidated ux/check-in', markdown: '# Check-in\n' },
      { name: 'plainfolder/note', markdown: '# Note\n' },
    ]);

    await page.goto('/');
    const sidebar = page.locator(SIDEBAR);

    const spaced = sidebar.getByRole('treeitem', { name: 'consolidated ux', exact: true });
    const control = sidebar.getByRole('treeitem', { name: 'plainfolder', exact: true });
    await expect(spaced).toBeVisible({ timeout: 20_000 });
    await expect(control).toBeVisible();

    // Control: a space-free folder expands on the first click and collapses on
    // the second — the behavior the spaced folder must match.
    await control.click();
    await expect(control).toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 });
    await control.click();
    await expect(control).toHaveAttribute('aria-expanded', 'false', { timeout: 10_000 });

    await spaced.click();
    await expect(spaced).toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 });
    // The regression: this second click used to be swallowed, leaving the row
    // stuck open no matter how many times it was clicked.
    await spaced.click();
    await expect(spaced).toHaveAttribute('aria-expanded', 'false', { timeout: 10_000 });
    // And it still toggles back, so the fix did not merely invert the guard.
    await spaced.click();
    await expect(spaced).toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 });
  });
});
