import {
  expect,
  SETTINGS_PANEL_TIMEOUT_MS,
  setPluginEnabled,
  test,
  waitForSettingsPanel,
} from './_helpers';

async function openSettings(page: import('@playwright/test').Page) {
  await page.goto('/#settings');
  await expect(page.getByTestId('settings-dialog')).toBeVisible({ timeout: 10_000 });
}

test.describe('Settings search — navigation + pinned layout', () => {
  test('the search box stays pinned while the section list scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 460 });
    await openSettings(page);

    const search = page.getByTestId('settings-search-input');
    await expect(search).toBeVisible();
    const before = await search.boundingBox();

    await page.getByTestId('settings-sidebar-item-okignore').scrollIntoViewIfNeeded();

    const after = await search.boundingBox();
    await expect(search).toBeInViewport();
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(Math.round(after?.y ?? -1)).toBe(Math.round(before?.y ?? -2));
  });

  test('typing a section name filters to a result that navigates on click', async ({ page }) => {
    await openSettings(page);

    await page.getByTestId('settings-search-input').fill('Hotkeys');
    const result = page.getByTestId('settings-search-result-section:hotkeys');
    await expect(result).toBeVisible({ timeout: 5_000 });

    await result.click();
    await expect(page.getByTestId('settings-hotkeys')).toBeVisible({
      timeout: SETTINGS_PANEL_TIMEOUT_MS,
    });
    await expect(page.getByTestId('settings-sidebar-item-preferences')).toBeVisible();
  });

  test('a no-match query shows the empty state', async ({ page }) => {
    await openSettings(page);
    await page.getByTestId('settings-search-input').fill('zzzznomatch');
    await expect(page.getByTestId('settings-search-empty')).toBeVisible({ timeout: 5_000 });
  });

  test('a field result scrolls its field into view and flashes it', async ({ page }) => {
    await openSettings(page);

    await page.getByTestId('settings-search-input').fill('Word wrap');
    const result = page.getByTestId('settings-search-result-field:preferences:editor.wordWrap');
    await expect(result).toBeVisible({ timeout: 5_000 });
    await result.click();

    const field = page.locator('[data-field="editor.wordWrap"]');
    await expect(field).toBeVisible({ timeout: SETTINGS_PANEL_TIMEOUT_MS });
    await expect(field).toBeInViewport();
    await expect(field).toHaveClass(/animate-settings-nav-flash/, { timeout: 2_000 });
    await expect(field).not.toHaveClass(/animate-settings-nav-flash/, { timeout: 3_000 });
  });

  test('a merged former section is searchable and lands on its block in the absorbing page', async ({
    page,
  }) => {
    await openSettings(page);

    await page.getByTestId('settings-search-input').fill('Config sharing');
    const result = page.getByTestId('settings-search-result-subsection:sync:sharing');
    await expect(result).toBeVisible({ timeout: 5_000 });
    await result.click();

    const block = page.locator('[data-field="section:sharing"]');
    await expect(block).toBeVisible({ timeout: SETTINGS_PANEL_TIMEOUT_MS });
    await expect(block).toBeInViewport();
    await expect(block).toHaveClass(/animate-settings-nav-flash/, { timeout: 2_000 });
  });

  test('Preview tabs is searchable from its catalog-backed label and description', async ({
    page,
  }) => {
    await openSettings(page);

    for (const query of ['preview', 'reuse']) {
      await page.getByTestId('settings-search-input').fill(query);
      const result = page.getByTestId(
        'settings-search-result-field:preferences:editor.previewTabs',
      );
      await expect(result).toBeVisible({ timeout: 5_000 });
      await result.click();

      const field = page.locator('[data-field="editor.previewTabs"]');
      await expect(field).toBeVisible({ timeout: SETTINGS_PANEL_TIMEOUT_MS });
      await expect(field).toBeInViewport();
    }
  });
});

test.describe('Settings search — scope badges + markdownlint rules', () => {
  test('the Themes plugin panel shows a User scope badge', async ({ page }) => {
    await openSettings(page);
    await page.getByTestId('settings-sidebar-item-plugin:theme').click();
    await expect(page.getByTestId('settings-scope-badge-user')).toBeVisible({
      timeout: SETTINGS_PANEL_TIMEOUT_MS,
    });
    await expect(page.getByTestId('settings-scope-badge-project')).toHaveCount(0);
  });

  test('markdownlint rules are searchable only while the plugin is enabled, and a rule result pre-filters the panel', async ({
    page,
  }) => {
    await openSettings(page);

    await page.getByTestId('settings-sidebar-item-plugins-manage').click();
    await waitForSettingsPanel(page, 'settings-plugins-manage');
    await setPluginEnabled(page, 'markdownlint', true);

    await page.getByTestId('settings-search-input').fill('MD013');
    const ruleResult = page.getByTestId('settings-search-result-rule:MD013');
    await expect(ruleResult).toBeVisible({ timeout: 5_000 });
    await ruleResult.click();

    await expect(page.getByTestId('settings-plugin-markdownlint')).toBeVisible();
    await expect(page.getByTestId('settings-scope-badge-project')).toBeVisible();
    await expect(page.getByTestId('markdownlint-rule-search')).toHaveValue('MD013');
    await expect(page.getByTestId('markdownlint-rule-row-MD013')).toBeVisible();
    await expect(page.getByTestId('markdownlint-rule-row-MD001')).toHaveCount(0);

    await page.getByTestId('settings-sidebar-item-plugins-manage').click();
    await setPluginEnabled(page, 'markdownlint', false);

    await page.getByTestId('settings-search-input').fill('MD013');
    await expect(page.getByTestId('settings-search-result-rule:MD013')).toHaveCount(0);
    await expect(page.getByTestId('settings-search-empty')).toBeVisible({ timeout: 5_000 });
  });
});
