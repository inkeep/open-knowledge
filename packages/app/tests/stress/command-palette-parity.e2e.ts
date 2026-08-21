/**
 * Real-cmdk smoke for the Cmd+K menu-parity backfill.
 *
 * The unit/DOM tests mock cmdk (they assert the registry-driven branch emits a
 * row and wires its dispatch). This test closes that fidelity gap against the
 * REAL palette in a running app: it proves a backfilled host-agnostic command
 * (Show/Hide sidebar) is search-only, renders under a matching query in the
 * real cmdk list, and — when activated — dispatches through the local
 * menu-action bus to the real FileSidebar handler, which flips the sidebar and
 * therefore the state-reflecting label on the next open.
 *
 * Runs on the web host (dev server, no desktop bridge), so it exercises exactly
 * the host-agnostic path that Phase 1 makes reachable on web.
 */

import { expect, test } from './_helpers';

const SEED_DOCS = [{ name: 'note', markdown: '# note\n\nHello there.\n' }];

async function openPalette(page: import('@playwright/test').Page) {
  // `ControlOrMeta+k` picks Meta on darwin, Control elsewhere — matches the
  // in-app handler's `isMacOS() ? metaKey : ctrlKey`.
  await page.keyboard.press('ControlOrMeta+k');
  const list = page.locator('[data-slot="command-list"]');
  await expect(list).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('[data-slot="command-input"]')).toBeFocused();
  return list;
}

test.describe('command-palette — menu-parity backfill (real cmdk)', () => {
  test('a backfilled toggle is search-only, renders in the real list, and dispatches to its handler', async ({
    page,
    api,
  }) => {
    await api.seedDocs(SEED_DOCS);
    await page.goto('/');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });

    // 1) Empty open: the backfilled long-tail row must NOT render (search-only).
    const list = await openPalette(page);
    await expect(page.getByTestId('command-palette-toggle-sidebar')).toHaveCount(0);

    // 2) Type a matching query: the real cmdk renders the backfilled row with a
    //    state-reflecting label (sidebar starts expanded → "Hide sidebar").
    await page.keyboard.type('sidebar');
    const row = page.getByTestId('command-palette-toggle-sidebar');
    await expect(row).toBeVisible({ timeout: 5_000 });
    await expect(row).toContainText('Hide sidebar');

    // 3) Activate it: the palette closes and the action dispatches through the
    //    bus to FileSidebar's handler (toggles the sidebar).
    await row.click();
    await expect(list).toBeHidden({ timeout: 5_000 });

    // 4) Re-open + re-query: the label now reads "Show sidebar", proving the
    //    real dispatch actually flipped the sidebar state (round-trip through
    //    the bus → FileSidebar → view-menu-state store → label).
    await openPalette(page);
    await page.keyboard.type('sidebar');
    const rowAfter = page.getByTestId('command-palette-toggle-sidebar');
    await expect(rowAfter).toBeVisible({ timeout: 5_000 });
    await expect(rowAfter).toContainText('Show sidebar');
  });

  test('a multi-word query admits a row whose terms are never adjacent', async ({ page, api }) => {
    await api.seedDocs(SEED_DOCS);
    await page.goto('/');
    await page.waitForSelector('[role="treeitem"]', { timeout: 15_000 });
    await openPalette(page);

    const row = page.getByTestId('command-palette-toggle-sidebar');
    const input = page.locator('[data-slot="command-input"]');

    // Every case fills the input and asserts the value before asserting the
    // row. This row is search-only, so it is absent for an empty query and
    // unchanged by a query that never landed — without checking the value
    // first, a no-op keystroke leaves the previous result on screen and each
    // assertion below passes without testing what it names.
    const query = async (value: string) => {
      await input.fill(value);
      await expect(input).toHaveValue(value);
    };

    // Control: a single token contained in the label.
    await query('sidebar');
    await expect(row).toBeVisible({ timeout: 5_000 });

    // The subject: "toggle" comes from the keywords and "sidebar" from the
    // label, so the two words are never one uninterrupted run of text.
    await query('toggle sidebar');
    await expect(row).toBeVisible({ timeout: 5_000 });

    // Reversed, to pin order-independence rather than one lucky ordering.
    await query('sidebar toggle');
    await expect(row).toBeVisible({ timeout: 5_000 });

    // The counterweight: one unmatchable term must still exclude the row, so
    // admission stays all-terms rather than degrading to any-term. Paired with
    // a positive control so "the list unmounted" cannot masquerade as "row
    // correctly excluded".
    await query('sidebar zzzznomatch');
    await expect(row).toHaveCount(0);

    await query('sidebar');
    await expect(row).toBeVisible({ timeout: 5_000 });
  });
});
