/**
 * E2E coverage for the Settings sidebar search + scope badges.
 *
 * These are the real-browser seams the jsdom DOM tests structurally cannot
 * reach at fidelity:
 *   - The search box stays PINNED while the section list scrolls (real layout +
 *     scroll — jsdom has no layout).
 *   - A section result NAVIGATES the real composed dialog (real Shell → index →
 *     matchesCommandQuery → cmdk → onNavigate, over the real dev server).
 *   - A field result SCROLLS its target into view and FLASHES it — the flash is
 *     a real CSS keyframe here, not a jsdom classList assertion.
 *   - A markdownlint rule result opens the panel PRE-FILTERED to that rule, and
 *     rules are searchable only while the plugin is ENABLED (disabled-plugin
 *     exclusion), driven through the real enable/disable toggle.
 *   - The plugin panels carry the correct User/Project scope badge.
 *
 * Runnable via `pnpm exec playwright test tests/stress/settings-search.e2e.ts`;
 * wired into the CI `test:e2e` subset (packages/app/package.json).
 */

import { expect, test } from './_helpers';

async function openSettings(page: import('@playwright/test').Page) {
  await page.goto('/#settings');
  await expect(page.getByTestId('settings-dialog')).toBeVisible({ timeout: 10_000 });
}

test.describe('Settings search — navigation + pinned layout', () => {
  test('the search box stays pinned while the section list scrolls', async ({ page }) => {
    // Shrink the viewport so the dialog (max-h: 100dvh-4rem) is shorter than the
    // section list — forcing the sidebar scroll region to actually overflow.
    await page.setViewportSize({ width: 1000, height: 460 });
    await openSettings(page);

    const search = page.getByTestId('settings-search-input');
    await expect(search).toBeVisible();
    const before = await search.boundingBox();

    // Scroll a bottom-of-list item into view — this scrolls the inner group
    // region, NOT the pinned search box.
    await page.getByTestId('settings-sidebar-item-sharing').scrollIntoViewIfNeeded();

    const after = await search.boundingBox();
    await expect(search).toBeInViewport();
    // The search box has not moved: it is outside the scroll region.
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
    // Real body swapped to the Hotkeys section; query cleared → group nav back.
    await expect(page.getByTestId('settings-hotkeys')).toBeVisible({ timeout: 5_000 });
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
    await expect(field).toBeVisible({ timeout: 5_000 });
    // Rendered outcome: the field is scrolled into the viewport…
    await expect(field).toBeInViewport();
    // …and the real CSS flash keyframe is applied, then clears.
    await expect(field).toHaveClass(/animate-settings-nav-flash/, { timeout: 2_000 });
    await expect(field).not.toHaveClass(/animate-settings-nav-flash/, { timeout: 3_000 });
  });
});

test.describe('Settings search — scope badges + markdownlint rules', () => {
  test('the Themes plugin panel shows a User scope badge', async ({ page }) => {
    await openSettings(page);
    // Themes is a user-scope plugin, enabled by default.
    await page.getByTestId('settings-sidebar-item-plugin:theme').click();
    await expect(page.getByTestId('settings-scope-badge-user')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('settings-scope-badge-project')).toHaveCount(0);
  });

  test('markdownlint rules are searchable only while the plugin is enabled, and a rule result pre-filters the panel', async ({
    page,
  }) => {
    await openSettings(page);

    // Ensure markdownlint is ENABLED via the real project-plugins toggle.
    await page.getByTestId('settings-sidebar-item-plugins-manage').click();
    const toggle = page.getByTestId('settings-plugin-toggle-markdownlint');
    await expect(toggle).toBeVisible({ timeout: 5_000 });
    if ((await toggle.getAttribute('aria-checked')) !== 'true') {
      await toggle.click();
    }
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 5_000 });

    // A rule is now searchable from the sidebar search; the result opens the
    // panel pre-filtered to that rule, and the header shows the Project badge.
    await page.getByTestId('settings-search-input').fill('MD013');
    const ruleResult = page.getByTestId('settings-search-result-rule:MD013');
    await expect(ruleResult).toBeVisible({ timeout: 5_000 });
    await ruleResult.click();

    await expect(page.getByTestId('settings-plugin-markdownlint')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('settings-scope-badge-project')).toBeVisible();
    await expect(page.getByTestId('markdownlint-rule-search')).toHaveValue('MD013');
    await expect(page.getByTestId('markdownlint-rule-row-MD013')).toBeVisible();
    await expect(page.getByTestId('markdownlint-rule-row-MD001')).toHaveCount(0);

    // Now DISABLE markdownlint; its rules drop out of the search index.
    await page.getByTestId('settings-sidebar-item-plugins-manage').click();
    const toggleAgain = page.getByTestId('settings-plugin-toggle-markdownlint');
    await expect(toggleAgain).toBeVisible({ timeout: 5_000 });
    await toggleAgain.click();
    await expect(toggleAgain).toHaveAttribute('aria-checked', 'false', { timeout: 5_000 });

    await page.getByTestId('settings-search-input').fill('MD013');
    await expect(page.getByTestId('settings-search-result-rule:MD013')).toHaveCount(0);
    await expect(page.getByTestId('settings-search-empty')).toBeVisible({ timeout: 5_000 });
  });
});
