import { expect, test } from './_helpers';

test.describe('Settings — Ignore patterns section (US-007 / US-008 / US-009 / US-010 / US-011 / US-012 / US-013)', () => {
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

    const addInput = page.getByTestId('settings-okignore-add-input');
    await addInput.fill(original);
    await page.getByTestId('settings-okignore-add-button').click();

    const rowInput = page
      .getByTestId('settings-okignore-row-input')
      .and(page.locator(`[value="${original}"]`))
      .first();
    await expect(rowInput).toBeVisible({ timeout: 5_000 });

    await rowInput.click();
    await rowInput.fill(updated);
    await page.getByRole('heading', { name: 'Ignore patterns' }).click();

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

    const savedRow = page
      .getByTestId('settings-okignore-row')
      .filter({
        has: page
          .getByTestId('settings-okignore-row-input')
          .and(page.locator(`[value="${pattern}"]`)),
      })
      .first();
    const indicator = savedRow.getByTestId('settings-okignore-saved-indicator');
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

    await addInput.fill('drafts/\\');
    await expect(indicator).toHaveAttribute('data-warnings', '1', { timeout: 1_500 });

    await addInput.fill('!');
    await expect(indicator).toHaveAttribute('data-warnings', '1', { timeout: 1_500 });

    await addInput.fill('foo[abc');
    await expect(indicator).toHaveAttribute('data-warnings', '1', { timeout: 1_500 });

    await addInput.fill('drafts/');
    await expect(indicator).toHaveAttribute('data-warnings', '0', { timeout: 1_500 });
  });

  test('US-009: heuristic-warning row still commits (warnings are non-blocking)', async ({
    page,
  }) => {
    await page.goto('/#settings');
    await page.getByTestId('settings-sidebar-item-okignore').click();
    await expect(page.getByTestId('settings-okignore-section')).toBeVisible({ timeout: 10_000 });

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

    await page.evaluate(() => {
      try {
        window.localStorage.removeItem('okignore-show-advanced');
      } catch {}
    });
    await page.reload();
    await expect(page.getByTestId('settings-okignore-section')).toBeVisible({ timeout: 10_000 });

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
    const body = await textarea.inputValue();
    expect(body).toContain(pattern);

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
      } catch {}
    });
    await page.reload();
    await expect(page.getByTestId('settings-okignore-section')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('settings-okignore-show-advanced-toggle').click();
    const textarea = page.getByTestId('settings-okignore-advanced-textarea');
    await expect(textarea).toBeVisible();

    const stamp = Date.now();
    const newBody = `# section\n\nadvanced-${stamp}/\n!keep-${stamp}.md\n\n# more\n*.draft.${stamp}.md\n`;
    await textarea.fill(newBody);
    await page.getByRole('heading', { name: 'Ignore patterns' }).click();

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
      } catch {}
    });
    await page.reload();
    await expect(page.getByTestId('settings-okignore-section')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('settings-okignore-show-advanced-toggle').click();
    const textarea = page.getByTestId('settings-okignore-advanced-textarea');
    await expect(textarea).toBeVisible();

    const stamp = Date.now();
    const body = `# top comment ${stamp}\n\n# subgroup\nfoo-${stamp}/\n\n# trailing comment\n`;
    await textarea.fill(body);
    await page.getByRole('heading', { name: 'Ignore patterns' }).click();

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
      } catch {}
    });
    await page.reload();
    await expect(page.getByTestId('settings-okignore-section')).toBeVisible({ timeout: 10_000 });

    const toggle = page.getByTestId('settings-okignore-show-advanced-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

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

    const stored = await page.evaluate(() => {
      try {
        return window.localStorage.getItem('okignore-show-advanced');
      } catch {
        return null;
      }
    });
    expect(stored).toBe('true');

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

    const input = page.getByTestId('settings-okignore-add-input');
    const stamp = Date.now().toString();
    await input.fill(`*-${stamp}.md`);

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

    const stamp = Date.now().toString();
    await page.getByTestId('settings-okignore-add-input').fill(`zzz-no-match-${stamp}.md`);

    const preview = page
      .getByTestId('settings-okignore-add')
      .getByTestId('settings-okignore-preview')
      .filter({ hasText: /matches \d+ / });
    await expect(preview).toBeVisible({ timeout: 2_000 });
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

    await expect(treeItem).toBeHidden({ timeout: 10_000 });

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

    const folderItem = page.getByRole('treeitem', { name: new RegExp(`${folder}/?$`) });
    await expect(folderItem).toBeVisible({ timeout: 10_000 });
    await folderItem.click({ button: 'right' });

    const hideItem = page.getByTestId('file-tree-menu-hide');
    await expect(hideItem).toBeVisible({ timeout: 5_000 });
    await expect(hideItem).toContainText('Hide folder');
    await hideItem.click();

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

    await page.goto('/#settings');
    await page.getByTestId('settings-sidebar-item-okignore').click();
    const list = page.getByTestId('settings-okignore-list');
    await expect(list).toBeVisible({ timeout: 10_000 });
    const row = list.getByTestId('settings-okignore-row-input').first();
    await expect(row).toHaveValue(`/${folder}/`);
  });
});
