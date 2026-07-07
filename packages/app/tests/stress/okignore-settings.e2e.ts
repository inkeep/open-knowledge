/**
 * E2E coverage for the Settings "Ignore patterns" section
 * for the okignore settings surface.
 *
 * Verifies the user-visible outcomes:
 *   - Section renders under THIS PROJECT → Ignore patterns
 *   - Empty-state nudge is plain-language and exposes a primer link
 *   - Add-pattern input + button commit a new pattern to the binding
 *   - After commit, the row appears in the divided list
 *   - List rows expose drag handle, editable input, and remove button
 *   - Edit on focus-out updates the pattern
 *   - Remove drops the row from the list
 *   - Per-row saved-indicator flashes after add + edit commit
 *   - Heuristic warnings flag five suspicious shapes
 *   - Server OKIGNORE_INVALID rejection surfaces a transient banner
 *   - Show-advanced toggle reveals a textarea bound to the same Y.Text
 *   - Round-trip preserves comments and blank lines byte-identically
 *   - Toggle state persists in localStorage across reloads
 *   - Per-row pattern preview shows "matches N files"
 *   - Nested-error CC1 surfaces a non-blocking toast
 *   - Section does NOT render under USER → Preferences (project-only)
 *   - FileTree right-click "Hide this file/folder" appends an anchored pattern
 *     to the same __config__/okignore Y.Text used by Settings
 *
 * Lives next to other stress tests; runnable via
 * `bunx playwright test tests/stress/okignore-settings.e2e.ts`. NOT added to
 * the CI 6-file subset — those are reserved for the highest-traffic surfaces.
 */

import { expect, test } from './_helpers';

test.describe('Settings — Ignore patterns section (US-007 / US-008 / US-009 / US-010 / US-011 / US-012 / US-013)', () => {
  // Each Settings test reads the okignore list with `.first()` and asserts
  // its own pattern is at index 0. `__config__/okignore` accumulates across
  // tests in the same worker (Playwright doesn't recycle the dev server),
  // so without an explicit reset the second test onwards sees a leftover
  // pattern from an earlier run. `api.testReset()` also clears
  // `__config__/okignore` Y.Text + the on-disk `.okignore` file.
  test.beforeEach(async ({ api }) => {
    await api.testReset();
  });

  test('project tab shows the section, empty-state, primer link, and add-pattern affordance', async ({
    page,
  }) => {
    await page.goto('/#settings');
    await page.getByTestId('settings-sidebar-item-okignore').click();

    const section = page.getByTestId('settings-okignore-section');
    await expect(section).toBeVisible({ timeout: 10_000 });

    await expect(section.getByRole('heading', { name: 'Ignore patterns' })).toBeVisible();

    const emptyState = page.getByTestId('settings-okignore-empty');
    await expect(emptyState).toBeVisible();
    await expect(emptyState).toContainText('No patterns yet');

    const primer = page.getByTestId('settings-okignore-primer');
    await expect(primer).toBeVisible();
    await expect(primer).toHaveAttribute('target', '_blank');

    const input = page.getByTestId('settings-okignore-add-input');
    const button = page.getByTestId('settings-okignore-add-button');
    await expect(input).toBeVisible();
    await expect(button).toBeVisible();
    await expect(button).toBeDisabled();
  });

  test('typing a pattern enables the Add button, committing populates the row list', async ({
    page,
  }) => {
    await page.goto('/#settings');
    await page.getByTestId('settings-sidebar-item-okignore').click();

    const section = page.getByTestId('settings-okignore-section');
    await expect(section).toBeVisible({ timeout: 10_000 });

    const input = page.getByTestId('settings-okignore-add-input');
    const button = page.getByTestId('settings-okignore-add-button');

    const pattern = `drafts-e2e-${Date.now()}/`;
    await input.fill(pattern);
    await expect(button).toBeEnabled();

    await button.click();

    await expect(page.getByTestId('settings-okignore-list')).toBeVisible({ timeout: 5_000 });
    const firstRow = page.getByTestId('settings-okignore-row').first();
    await expect(firstRow).toBeVisible();
    await expect(firstRow.getByTestId('settings-okignore-row-input')).toHaveValue(pattern);
    await expect(input).toHaveValue('');
  });

  test('row exposes drag handle, editable input, and remove button', async ({ page }) => {
    await page.goto('/#settings');
    await page.getByTestId('settings-sidebar-item-okignore').click();
    await expect(page.getByTestId('settings-okignore-section')).toBeVisible({ timeout: 10_000 });

    const addInput = page.getByTestId('settings-okignore-add-input');
    const addButton = page.getByTestId('settings-okignore-add-button');
    const pattern = `row-shape-${Date.now()}.tmp`;
    await addInput.fill(pattern);
    await addButton.click();

    const row = page
      .getByTestId('settings-okignore-row')
      .filter({
        has: page
          .getByTestId('settings-okignore-row-input')
          .and(page.locator(`[value="${pattern}"]`)),
      })
      .first();
    await expect(row).toBeVisible({ timeout: 5_000 });
    await expect(row.getByTestId('settings-okignore-drag-handle')).toBeVisible();
    await expect(row.getByTestId('settings-okignore-row-input')).toBeVisible();
    await expect(row.getByTestId('settings-okignore-remove')).toBeVisible();
  });

  test('editing a row in place commits on blur and persists the new value', async ({ page }) => {
    await page.goto('/#settings');
    await page.getByTestId('settings-sidebar-item-okignore').click();
    await expect(page.getByTestId('settings-okignore-section')).toBeVisible({ timeout: 10_000 });

    const stamp = Date.now();
    const original = `edit-original-${stamp}/`;
    const updated = `edit-updated-${stamp}/`;

    // Seed.
    const addInput = page.getByTestId('settings-okignore-add-input');
    await addInput.fill(original);
    await page.getByTestId('settings-okignore-add-button').click();

    // Locate the row by current value. `.and(...)` (intersection) is the
    // correct operator here — `.filter({ has })` requires a descendant
    // match, but the row-input is a void <input> with no children.
    const rowInput = page
      .getByTestId('settings-okignore-row-input')
      .and(page.locator(`[value="${original}"]`))
      .first();
    await expect(rowInput).toBeVisible({ timeout: 5_000 });

    await rowInput.click();
    await rowInput.fill(updated);
    // Blur to commit (focusing the heading).
    await page.getByRole('heading', { name: 'Ignore patterns' }).click();

    // The list should now contain the updated value, not the original.
    await expect(
      page.getByTestId('settings-okignore-row-input').and(page.locator(`[value="${updated}"]`)),
    ).toHaveCount(1, { timeout: 5_000 });
    await expect(
      page.getByTestId('settings-okignore-row-input').and(page.locator(`[value="${original}"]`)),
    ).toHaveCount(0);
  });

  test('removing a row drops it from the list', async ({ page }) => {
    await page.goto('/#settings');
    await page.getByTestId('settings-sidebar-item-okignore').click();
    await expect(page.getByTestId('settings-okignore-section')).toBeVisible({ timeout: 10_000 });

    const stamp = Date.now();
    const pattern = `remove-me-${stamp}.tmp`;

    await page.getByTestId('settings-okignore-add-input').fill(pattern);
    await page.getByTestId('settings-okignore-add-button').click();

    const rowInput = page
      .getByTestId('settings-okignore-row-input')
      .and(page.locator(`[value="${pattern}"]`))
      .first();
    await expect(rowInput).toBeVisible({ timeout: 5_000 });

    const row = page.getByTestId('settings-okignore-row').filter({ has: rowInput }).first();
    await row.getByTestId('settings-okignore-remove').click();

    await expect(
      page.getByTestId('settings-okignore-row-input').and(page.locator(`[value="${pattern}"]`)),
    ).toHaveCount(0, { timeout: 5_000 });
  });

  test('adding a pattern flashes a per-row green check (saved indicator)', async ({ page }) => {
    await page.goto('/#settings');
    await page.getByTestId('settings-sidebar-item-okignore').click();
    await expect(page.getByTestId('settings-okignore-section')).toBeVisible({ timeout: 10_000 });

    const pattern = `flash-${Date.now()}.tmp`;
    await page.getByTestId('settings-okignore-add-input').fill(pattern);
    await page.getByTestId('settings-okignore-add-button').click();

    // The saved indicator's polite live region exists for SR support; the
    // visible <Check/> SVG is what we assert on. The flash is 1200ms — give
    // it a generous window since CI machines can be slow.
    const savedRow = page
      .getByTestId('settings-okignore-row')
      .filter({
        has: page
          .getByTestId('settings-okignore-row-input')
          .and(page.locator(`[value="${pattern}"]`)),
      })
      .first();
    const indicator = savedRow.getByTestId('settings-okignore-saved-indicator');
    // `Saved` SR text appears with the icon.
    await expect(indicator).toContainText('Saved', { timeout: 1_500 });
  });

  test('user-scope tab does not render the section (D12 LOCKED — project-only)', async ({
    page,
  }) => {
    await page.goto('/#settings');

    await expect(page.getByTestId('settings-dialog')).toBeVisible({ timeout: 10_000 });

    await expect(page.getByTestId('settings-okignore-section')).toHaveCount(0);
    await expect(page.getByTestId('settings-okignore-skeleton')).toHaveCount(0);
  });

  test('US-009: heuristic warnings flag suspicious patterns in the add input', async ({ page }) => {
    await page.goto('/#settings');
    await page.getByTestId('settings-sidebar-item-okignore').click();
    await expect(page.getByTestId('settings-okignore-section')).toBeVisible({ timeout: 10_000 });

    const addInput = page.getByTestId('settings-okignore-add-input');
    const indicator = page
      .getByTestId('settings-okignore-add')
      .getByTestId('settings-okignore-warning-indicator');

    // Trailing backslash — should fire one warning after debounce.
    await addInput.fill('drafts/\\');
    await expect(indicator).toHaveAttribute('data-warnings', '1', { timeout: 1_500 });

    // Lone bang — also triggers the warning.
    await addInput.fill('!');
    await expect(indicator).toHaveAttribute('data-warnings', '1', { timeout: 1_500 });

    // Unmatched [ — character class is open.
    await addInput.fill('foo[abc');
    await expect(indicator).toHaveAttribute('data-warnings', '1', { timeout: 1_500 });

    // Plain pattern clears the warning state.
    await addInput.fill('drafts/');
    await expect(indicator).toHaveAttribute('data-warnings', '0', { timeout: 1_500 });
  });

  test('US-009: heuristic-warning row still commits (warnings are non-blocking)', async ({
    page,
  }) => {
    await page.goto('/#settings');
    await page.getByTestId('settings-sidebar-item-okignore').click();
    await expect(page.getByTestId('settings-okignore-section')).toBeVisible({ timeout: 10_000 });

    // Type a pattern with a trailing backslash → warning lights up but commit
    // is allowed; binding.patch lands the pattern in the list. Use
    // `toHaveValue` (reads the JS property) rather than a CSS attribute
    // selector — `\` would escape the closing quote in `[value="..."]`.
    const stamp = Date.now();
    const pattern = `warn-${stamp}\\`;
    await page.getByTestId('settings-okignore-add-input').fill(pattern);
    await page.getByTestId('settings-okignore-add-button').click();

    const rowInput = page.getByTestId('settings-okignore-row-input').first();
    await expect(rowInput).toBeVisible({ timeout: 5_000 });
    await expect(rowInput).toHaveValue(pattern);
  });

  test('US-010: Show advanced toggle reveals a textarea bound to the same Y.Text', async ({
    page,
  }) => {
    await page.goto('/#settings');
    await page.getByTestId('settings-sidebar-item-okignore').click();
    await expect(page.getByTestId('settings-okignore-section')).toBeVisible({ timeout: 10_000 });

    // Reset localStorage so the test starts in default-off state.
    await page.evaluate(() => {
      try {
        window.localStorage.removeItem('okignore-show-advanced');
      } catch {
        // ignore
      }
    });
    await page.reload();
    await expect(page.getByTestId('settings-okignore-section')).toBeVisible({ timeout: 10_000 });

    // Seed at least one pattern so we have a non-empty body to mirror.
    const stamp = Date.now();
    const pattern = `advanced-mirror-${stamp}/`;
    await page.getByTestId('settings-okignore-add-input').fill(pattern);
    await page.getByTestId('settings-okignore-add-button').click();
    await expect(
      page.getByTestId('settings-okignore-row-input').and(page.locator(`[value="${pattern}"]`)),
    ).toHaveCount(1, { timeout: 5_000 });

    const toggle = page.getByTestId('settings-okignore-show-advanced-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveText('Show advanced');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await toggle.click();
    await expect(toggle).toHaveText('Hide advanced');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');

    const textarea = page.getByTestId('settings-okignore-advanced-textarea');
    await expect(textarea).toBeVisible();
    // Body contains the seeded pattern + a trailing newline (per the
    // okignore-doc serializer's append behavior).
    const body = await textarea.inputValue();
    expect(body).toContain(pattern);

    // List view is hidden while advanced is on.
    await expect(page.getByTestId('settings-okignore-list')).toHaveCount(0);
  });

  test('US-010: editing in textarea persists and the list view reflects the new patterns', async ({
    page,
  }) => {
    await page.goto('/#settings');
    await page.getByTestId('settings-sidebar-item-okignore').click();
    await expect(page.getByTestId('settings-okignore-section')).toBeVisible({ timeout: 10_000 });

    await page.evaluate(() => {
      try {
        window.localStorage.removeItem('okignore-show-advanced');
      } catch {
        // ignore
      }
    });
    await page.reload();
    await expect(page.getByTestId('settings-okignore-section')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('settings-okignore-show-advanced-toggle').click();
    const textarea = page.getByTestId('settings-okignore-advanced-textarea');
    await expect(textarea).toBeVisible();

    const stamp = Date.now();
    const newBody = `# section\n\nadvanced-${stamp}/\n!keep-${stamp}.md\n\n# more\n*.draft.${stamp}.md\n`;
    await textarea.fill(newBody);
    // Blur to flush the debounced commit (also covers the 400ms timer).
    await page.getByRole('heading', { name: 'Ignore patterns' }).click();

    // Toggle back to list view; the new patterns should appear as rows.
    await page.getByTestId('settings-okignore-show-advanced-toggle').click();
    await expect(page.getByTestId('settings-okignore-list')).toBeVisible({ timeout: 5_000 });

    await expect(
      page
        .getByTestId('settings-okignore-row-input')
        .and(page.locator(`[value="advanced-${stamp}/"]`)),
    ).toHaveCount(1);
    await expect(
      page
        .getByTestId('settings-okignore-row-input')
        .and(page.locator(`[value="!keep-${stamp}.md"]`)),
    ).toHaveCount(1);
    await expect(
      page
        .getByTestId('settings-okignore-row-input')
        .and(page.locator(`[value="*.draft.${stamp}.md"]`)),
    ).toHaveCount(1);
  });

  test('US-010: round-trip preserves comments and blank lines byte-for-byte', async ({ page }) => {
    await page.goto('/#settings');
    await page.getByTestId('settings-sidebar-item-okignore').click();
    await expect(page.getByTestId('settings-okignore-section')).toBeVisible({ timeout: 10_000 });

    await page.evaluate(() => {
      try {
        window.localStorage.removeItem('okignore-show-advanced');
      } catch {
        // ignore
      }
    });
    await page.reload();
    await expect(page.getByTestId('settings-okignore-section')).toBeVisible({ timeout: 10_000 });

    // Open advanced and write a body with comments + blanks.
    await page.getByTestId('settings-okignore-show-advanced-toggle').click();
    const textarea = page.getByTestId('settings-okignore-advanced-textarea');
    await expect(textarea).toBeVisible();

    const stamp = Date.now();
    const body = `# top comment ${stamp}\n\n# subgroup\nfoo-${stamp}/\n\n# trailing comment\n`;
    await textarea.fill(body);
    await page.getByRole('heading', { name: 'Ignore patterns' }).click();

    // Toggle off and back on; the textarea body should be byte-identical.
    await page.getByTestId('settings-okignore-show-advanced-toggle').click();
    await expect(page.getByTestId('settings-okignore-list')).toBeVisible();
    await page.getByTestId('settings-okignore-show-advanced-toggle').click();
    const textareaReopened = page.getByTestId('settings-okignore-advanced-textarea');
    await expect(textareaReopened).toBeVisible();
    const reopenedBody = await textareaReopened.inputValue();
    expect(reopenedBody).toBe(body);
  });

  test('US-010: toggle state persists in localStorage across page reloads', async ({ page }) => {
    await page.goto('/#settings');
    await page.getByTestId('settings-sidebar-item-okignore').click();
    await expect(page.getByTestId('settings-okignore-section')).toBeVisible({ timeout: 10_000 });

    await page.evaluate(() => {
      try {
        window.localStorage.removeItem('okignore-show-advanced');
      } catch {
        // ignore
      }
    });
    await page.reload();
    await expect(page.getByTestId('settings-okignore-section')).toBeVisible({ timeout: 10_000 });

    // Default-off after reset.
    const toggle = page.getByTestId('settings-okignore-show-advanced-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    // Flip on and reload.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('settings-okignore-advanced-textarea')).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('settings-okignore-section')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('settings-okignore-show-advanced-toggle')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByTestId('settings-okignore-advanced-textarea')).toBeVisible();

    // Verify the localStorage key is exactly the spec-locked one.
    const stored = await page.evaluate(() => {
      try {
        return window.localStorage.getItem('okignore-show-advanced');
      } catch {
        return null;
      }
    });
    expect(stored).toBe('true');

    // Flip off and reload — should be remembered as off.
    await page.getByTestId('settings-okignore-show-advanced-toggle').click();
    await expect(page.getByTestId('settings-okignore-show-advanced-toggle')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await page.reload();
    await expect(page.getByTestId('settings-okignore-section')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('settings-okignore-show-advanced-toggle')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  test('US-011: typing a pattern in the add input shows a debounced "matches N files" preview', async ({
    page,
  }) => {
    await page.goto('/#settings');
    await page.getByTestId('settings-sidebar-item-okignore').click();
    await expect(page.getByTestId('settings-okignore-section')).toBeVisible({ timeout: 10_000 });

    // Add input: typing should reveal a preview after debounce.
    const input = page.getByTestId('settings-okignore-add-input');
    const stamp = Date.now().toString();
    await input.fill(`*-${stamp}.md`);

    // Preview slot is rendered both in hidden-state (empty input) and
    // visible-state (after debounce). Wait for any visible-state preview
    // — count must be a number 0..N.
    const preview = page
      .getByTestId('settings-okignore-add')
      .getByTestId('settings-okignore-preview')
      .filter({ hasText: /matches \d+ / });
    await expect(preview).toBeVisible({ timeout: 2_000 });
    await expect(preview).toContainText('(some may already be hidden by other rules)');
  });

  test('US-011: clearing the add input hides the preview (preview-state="hidden")', async ({
    page,
  }) => {
    await page.goto('/#settings');
    await page.getByTestId('settings-sidebar-item-okignore').click();
    await expect(page.getByTestId('settings-okignore-section')).toBeVisible({ timeout: 10_000 });

    const input = page.getByTestId('settings-okignore-add-input');
    await input.fill('drafts/');
    const preview = page
      .getByTestId('settings-okignore-add')
      .getByTestId('settings-okignore-preview')
      .filter({ hasText: /matches \d+ / });
    await expect(preview).toBeVisible({ timeout: 2_000 });

    // Clear the input — the preview should switch back to hidden-state.
    await input.fill('');
    const hiddenPreview = page
      .getByTestId('settings-okignore-add')
      .locator('[data-preview-state="hidden"]');
    await expect(hiddenPreview).toBeVisible({ timeout: 2_000 });
  });

  test('US-011: per-row preview attaches to a committed pattern row', async ({ page }) => {
    await page.goto('/#settings');
    await page.getByTestId('settings-sidebar-item-okignore').click();
    await expect(page.getByTestId('settings-okignore-section')).toBeVisible({ timeout: 10_000 });

    // Add a pattern; after commit the row owns its own debounced preview.
    const stamp = Date.now().toString();
    const pattern = `drafts-preview-${stamp}/`;
    await page.getByTestId('settings-okignore-add-input').fill(pattern);
    await page.getByTestId('settings-okignore-add-button').click();

    const firstRow = page.getByTestId('settings-okignore-row').first();
    await expect(firstRow).toBeVisible({ timeout: 5_000 });

    const rowPreview = firstRow
      .getByTestId('settings-okignore-preview')
      .filter({ hasText: /matches \d+ / });
    await expect(rowPreview).toBeVisible({ timeout: 2_000 });
    await expect(rowPreview).toHaveAttribute('data-preview-count', /^\d+$/);
  });

  test('US-011: preview pluralizes correctly (1 file vs N files)', async ({ page }) => {
    await page.goto('/#settings');
    await page.getByTestId('settings-sidebar-item-okignore').click();
    await expect(page.getByTestId('settings-okignore-section')).toBeVisible({ timeout: 10_000 });

    // Use a known-zero pattern — every workspace lacks `zzz-no-match-${stamp}.md`,
    // so we expect "matches 0 files" (plural). The pluralization
    // contract is what matters; correctness of the number is exercised
    // by the unit countMatches tests.
    const stamp = Date.now().toString();
    await page.getByTestId('settings-okignore-add-input').fill(`zzz-no-match-${stamp}.md`);

    const preview = page
      .getByTestId('settings-okignore-add')
      .getByTestId('settings-okignore-preview')
      .filter({ hasText: /matches \d+ / });
    await expect(preview).toBeVisible({ timeout: 2_000 });
    // 0 → "files" (plural form for zero is the conventional pluralization).
    await expect(preview).toContainText(/matches 0 files/);
  });
});

test.describe('FileTree right-click → Hide this file/folder (US-013)', () => {
  test('"Hide this file" appends an anchored pattern to __config__/okignore', async ({
    page,
    api,
  }) => {
    const stamp = Date.now();
    const docName = `hide-target-${stamp}`;
    await api.seedDocs([{ name: docName, markdown: '# hide me\n\nright-click hides this row.\n' }]);
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    const treeItem = page.getByRole('treeitem', { name: new RegExp(`${docName}\\.md`) });
    await expect(treeItem).toBeVisible({ timeout: 10_000 });
    await treeItem.click({ button: 'right' });

    const hideItem = page.getByTestId('file-tree-menu-hide');
    await expect(hideItem).toBeVisible({ timeout: 5_000 });
    await expect(hideItem).toContainText('Hide this file');
    await hideItem.click();

    // Tree refreshes via the existing CC1 'files' channel after the
    // ContentFilter rebuild — the row disappears without a manual reload.
    await expect(treeItem).toBeHidden({ timeout: 10_000 });

    // Settings → Ignore patterns lists the new anchored row.
    await page.goto('/#settings');
    await page.getByTestId('settings-sidebar-item-okignore').click();
    const list = page.getByTestId('settings-okignore-list');
    await expect(list).toBeVisible({ timeout: 10_000 });
    const row = list.getByTestId('settings-okignore-row-input').first();
    await expect(row).toHaveValue(`/${docName}.md`);
  });

  test('"Hide folder" appends an anchored folder pattern', async ({ page, api }) => {
    const stamp = Date.now();
    const folder = `drafts-${stamp}`;
    await api.seedDocs([
      { name: `${folder}/note-a`, markdown: '# a\n' },
      { name: `${folder}/note-b`, markdown: '# b\n' },
      { name: `keep-${stamp}`, markdown: '# keep\n' },
    ]);
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    // Folders render with a trailing slash in the @pierre/trees treeitem name.
    const folderItem = page.getByRole('treeitem', { name: new RegExp(`${folder}/?$`) });
    await expect(folderItem).toBeVisible({ timeout: 10_000 });
    await folderItem.click({ button: 'right' });

    const hideItem = page.getByTestId('file-tree-menu-hide');
    await expect(hideItem).toBeVisible({ timeout: 5_000 });
    await expect(hideItem).toContainText('Hide folder');
    await hideItem.click();

    // The folder row and both files inside it vanish; the unrelated keep-* file stays.
    await expect(folderItem).toBeHidden({ timeout: 10_000 });
    await expect(page.getByRole('treeitem', { name: /note-a\.md/ })).toBeHidden({
      timeout: 10_000,
    });
    await expect(page.getByRole('treeitem', { name: /note-b\.md/ })).toBeHidden({
      timeout: 10_000,
    });
    await expect(
      page.getByRole('treeitem', { name: new RegExp(`keep-${stamp}\\.md`) }),
    ).toBeVisible();

    // Settings shows the anchored folder pattern.
    await page.goto('/#settings');
    await page.getByTestId('settings-sidebar-item-okignore').click();
    const list = page.getByTestId('settings-okignore-list');
    await expect(list).toBeVisible({ timeout: 10_000 });
    const row = list.getByTestId('settings-okignore-row-input').first();
    await expect(row).toHaveValue(`/${folder}/`);
  });
});

// Note: end-to-end coverage of the OKIGNORE_INVALID rejection banner
// requires server-side L3 to emit a CC1 broadcast in response to a
// whitespace-only Y.Text body. Triggering that from the browser harness
// would require either an in-process fixture that bypasses AddPatternRow's
// trim guard or a dev-only window hook into the binding — both add
// production-source seams for one assertion. The structural and routing
// contract is fully pinned by the unit guards in OkignoreSection.test.ts:
//   - subscribeToConfigValidationRejected with docName filter
//   - binding.notifyRejection routing
//   - subscribeRejection → banner state
//   - banner copy / color / aria / auto-dismiss timer
//   - AddPatternRow rejection flash
// The integration round-trip is exercised by the server-side rejection
// counter test in packages/server/src/config-persistence.test.ts and the
// CC1 emit test in cc1-broadcast.test.ts.
//
// Note: the nested-error toast follows the same pattern. The
// trigger is a server-side ContentFilter.rebuildIgnorePatterns() failure on
// a malformed nested .okignore — but npm:ignore is famously permissive
// and almost never throws on syntax. Forcing a real
// rebuild error from the harness would require a race against the
// file-watcher (write nested file → delete before rebuild reads) or a
// dev-only window hook — both fragile or production-seam-y. The structural
// and routing contract is fully pinned by:
//   - parseCC1ConfigIgnoreNestedError + dispatcher branch (cc1.test.ts)
//   - emit/subscribe pubsub (config-ignore-nested-error-events.test.ts)
//   - SystemDocSubscriber wires emitter into dispatcher (OkignoreSection.test.ts)
//   - OkignoreSectionBody.useEffect subscribes and surfaces toast.error
//     with the project-relative path + error description + dedup id
// The server emit path is covered by cc1-broadcast.test.ts (8 emit tests
// for emitConfigIgnoreNestedError) and the multi-path watcher integration
// in server-factory.test.ts. Sonner's actual DOM rendering is the
// library's responsibility, not ours.
