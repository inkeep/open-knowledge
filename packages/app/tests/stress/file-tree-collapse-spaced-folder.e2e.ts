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

    await control.click();
    await expect(control).toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 });
    await control.click();
    await expect(control).toHaveAttribute('aria-expanded', 'false', { timeout: 10_000 });

    await spaced.click();
    await expect(spaced).toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 });
    await spaced.click();
    await expect(spaced).toHaveAttribute('aria-expanded', 'false', { timeout: 10_000 });
    await spaced.click();
    await expect(spaced).toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 });
  });

  test('a folder collapses in one click after its child document took the selection', async ({
    page,
    api,
  }) => {
    await api.seedDocs([{ name: 'roundtrip/child', markdown: '# Child\n' }]);

    await page.goto('/');
    const sidebar = page.locator(SIDEBAR);

    const folder = sidebar.getByRole('treeitem', { name: 'roundtrip', exact: true });
    await expect(folder).toBeVisible({ timeout: 20_000 });

    await folder.click();
    await expect(folder).toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 });

    const child = sidebar.getByRole('treeitem', { name: 'child.md', exact: true });
    await child.click();
    await expect(child).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 });

    await folder.click();
    await expect(folder).toHaveAttribute('aria-expanded', 'false', { timeout: 10_000 });
    await expect(page).toHaveURL(/#\/roundtrip\/$/);
    await expect(folder).toHaveAttribute('aria-expanded', 'false');
  });
});
