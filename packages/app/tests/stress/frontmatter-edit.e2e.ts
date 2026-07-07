/**
 * E2E coverage for realtime frontmatter entries.
 *
 * Verifies the user-visible outcomes:
 *   - rename preserves position (driver-bug fix).
 *   - drag-to-reorder commits the new order to disk.
 *   - keyboard-accessible drag (space + arrow + space).
 *   - duplicate-name rows render with a marker on each.
 *   - malformed YAML region produces an inline banner.
 */

import { expect, test } from './_helpers';

const BASE_FM_DOC = `---
title: Initial
status: draft
cluster: research
---

# Body

Some content here.
`;

test.describe('PropertyPanel — realtime frontmatter (FR1, FR2, FR4, FR6, FR9)', () => {
  test('FR2 — renaming a property preserves its position', async ({ page, api }) => {
    const docName = `fm-rename-pos-${crypto.randomUUID()}`;
    await api.seedDocs([{ name: docName, markdown: BASE_FM_DOC }]);
    await page.goto(`/#/${docName}`);

    const panel = page.getByTestId('property-panel');
    await expect(panel).toBeVisible();

    const initialOrder = await panel
      .locator('[data-testid="property-row"]')
      .evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.key ?? ''));
    expect(initialOrder).toEqual(['title', 'status', 'cluster']);

    // Rename "title" → "titles" by clicking the name button, typing, blurring.
    await page.getByTestId('property-name-button').filter({ hasText: 'title' }).click();
    const renameInput = page.getByTestId('property-name-rename-input');
    await renameInput.fill('titles');
    await renameInput.press('Enter');

    // The row at position 0 must still be the renamed key — not pushed to the
    // bottom (the driver-bug regression).
    const orderAfter = await panel
      .locator('[data-testid="property-row"]')
      .evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.key ?? ''));
    expect(orderAfter).toEqual(['titles', 'status', 'cluster']);
  });

  test('FR4 — drag-to-reorder commits the new order', async ({ page, api }) => {
    const docName = `fm-reorder-${crypto.randomUUID()}`;
    await api.seedDocs([{ name: docName, markdown: BASE_FM_DOC }]);
    await page.goto(`/#/${docName}`);

    const panel = page.getByTestId('property-panel');
    await expect(panel).toBeVisible();

    // Drag the first row's handle past the second row to swap them.
    // @dnd-kit's PointerSensor activates on 4px movement; the drop point
    // needs to land below the second row's center for closestCenter to
    // pick it as the over target.
    const handles = panel.getByTestId('property-drag-handle');
    const first = handles.nth(0);
    const second = handles.nth(1);
    const firstBox = await first.boundingBox();
    const secondBox = await second.boundingBox();
    if (!firstBox || !secondBox) throw new Error('drag handles not measurable');

    await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      secondBox.x + secondBox.width / 2,
      secondBox.y + secondBox.height / 2 + 8,
      { steps: 10 },
    );
    await page.mouse.up();

    const orderAfter = await panel
      .locator('[data-testid="property-row"]')
      .evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.key ?? ''));
    expect(orderAfter).toEqual(['status', 'title', 'cluster']);
  });

  test('FR5 — keyboard drag: space + ArrowDown + space reorders', async ({ page, api }) => {
    const docName = `fm-reorder-kbd-${crypto.randomUUID()}`;
    await api.seedDocs([{ name: docName, markdown: BASE_FM_DOC }]);
    await page.goto(`/#/${docName}`);

    const panel = page.getByTestId('property-panel');
    await expect(panel).toBeVisible();

    // Focus first drag handle, press space to lift, ArrowDown to move past
    // second row, space to drop. @dnd-kit's KeyboardSensor uses
    // sortableKeyboardCoordinates so ArrowDown picks the next sortable item.
    const firstHandle = panel.getByTestId('property-drag-handle').nth(0);
    await firstHandle.focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Space');

    const orderAfter = await panel
      .locator('[data-testid="property-row"]')
      .evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.key ?? ''));
    expect(orderAfter).toEqual(['status', 'title', 'cluster']);
  });

  test('FR6 — duplicate names render with a marker on each row', async ({ page, api }) => {
    const docName = `fm-dup-name-${crypto.randomUUID()}`;
    await api.seedDocs([
      { name: docName, markdown: '---\ntitle: First\ntitle: Second\n---\n# Body\n' },
    ]);
    await page.goto(`/#/${docName}`);

    const panel = page.getByTestId('property-panel');
    await expect(panel).toBeVisible();

    const dupMarkers = panel.locator('[data-testid="property-duplicate-marker"]');
    await expect(dupMarkers).toHaveCount(2);
  });

  test('FR9 — malformed YAML region surfaces an inline banner', async ({ page, api }) => {
    const docName = `fm-malformed-${crypto.randomUUID()}`;
    await api.seedDocs([{ name: docName, markdown: '---\n: : : invalid\n---\n# Body\n' }]);
    await page.goto(`/#/${docName}`);

    const banner = page.getByTestId('property-panel-yaml-error');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Frontmatter YAML is malformed');
  });
});
