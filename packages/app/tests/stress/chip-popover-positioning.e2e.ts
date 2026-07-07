/**
 * Chip PropPanel positioning — wiki-link and internal-link.
 *
 * Regression guard for the singleton-popover-off-screen bug:
 * `InteractionPropPanel` historically anchored to the EditorArea wrapper
 * via `absolute left-1/2 top-2`, so the panel rendered fully off-screen
 * (verified `y=-2535` in a real browser) once the doc scrolled past the
 * first viewport. Clicking a chip below the fold appeared to do nothing.
 *
 * After Floating UI wiring, the panel anchors to the active chip's
 * bounding rect via `computePosition` + `autoUpdate`, with `placement:
 * 'bottom-start'` and `flip()` + `shift()` middleware.
 *
 * Test shape: seed a doc with enough leading content that the chip is
 * past the first viewport, hover the chip (post-redesign: click navigates,
 * hover opens the popover), assert (a) the panel is on-screen, (b) the
 * panel is anchored near the chip (vertical gap within ~200 px, horizontal
 * centers within ~200 px). Both assertions fail on the unfixed code; both
 * pass after the fix.
 *
 * One test per chip kind (wiki-link, internal-link). Both go through the
 * same singleton primitive but differ in registration path (atom NodeView
 * vs link mark) and trigger DOM shape — failing one while the other
 * passes is a possible regression mode.
 */

import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** ~30 paragraphs of filler — enough to push the trailing chip well below
 *  the first viewport (~720 px on the default Playwright viewport). */
const FILLER = Array.from({ length: 30 }, (_, i) => `Filler line ${i + 1}.`).join('\n\n');

interface PositionAssertions {
  panelRect: { x: number; y: number; width: number; height: number };
  chipRect: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
}

/** Run the canonical positioning assertions on a chip + panel pair. */
function assertAnchored({ panelRect, chipRect, viewport }: PositionAssertions) {
  // (a) Panel is fully on-screen vertically.
  expect(panelRect.y).toBeGreaterThanOrEqual(0);
  expect(panelRect.y + panelRect.height).toBeLessThanOrEqual(viewport.height);

  // (b) Panel is anchored near the chip — vertical gap < 200 px (panel sits
  //     below or above the chip per Floating UI's flip middleware).
  const verticalGap = Math.abs(panelRect.y - chipRect.y);
  expect(verticalGap).toBeLessThan(200);

  // (c) Panel center aligns roughly with the chip horizontally (within 300
  //     px — accommodates `placement: 'bottom-start'` which left-anchors,
  //     plus shift() padding adjustments near viewport edges).
  const panelCenterX = panelRect.x + panelRect.width / 2;
  const chipCenterX = chipRect.x + chipRect.width / 2;
  expect(Math.abs(panelCenterX - chipCenterX)).toBeLessThan(300);
}

async function rectOf(_page: Page, locator: ReturnType<Page['locator']>) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('locator has no bounding box');
  return box;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('CHIP-POS-WIKI: wiki-link PropPanel anchors to chip rect when scrolled past first viewport', async ({
  page,
  api,
}) => {
  const docName = `chip-pos-wiki-${Math.random().toString(36).slice(2, 10)}`;
  await api.createPage(`${docName}.md`);
  // Seed: 30 filler paragraphs, then a wiki-link.
  await api.replaceDoc(docName, `${FILLER}\n\nTrailing chip: [[fake-target]]\n`);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  await waitForActiveProviderSynced(page);

  const chip = page.locator('[data-wiki-link]').first();
  await expect(chip).toBeAttached({ timeout: 10_000 });

  // Scroll the chip into view (mid-viewport). Playwright's `scrollIntoViewIfNeeded`
  // handles the editor's overflow container automatically.
  await chip.scrollIntoViewIfNeeded();
  await expect(chip).toBeVisible();

  await chip.hover();
  const panel = page.locator('[data-ok-prop-panel="wiki-link"]');
  await expect(panel).toBeVisible({ timeout: 5_000 });

  const viewport = page.viewportSize();
  if (!viewport) throw new Error('viewport size unknown');

  const panelRect = await rectOf(page, panel);
  const chipRect = await rectOf(page, chip);

  assertAnchored({ panelRect, chipRect, viewport });
});

test('CHIP-POS-LINK: internal-link PropPanel anchors to chip rect when scrolled past first viewport', async ({
  page,
  api,
}) => {
  const docName = `chip-pos-link-${Math.random().toString(36).slice(2, 10)}`;
  await api.createPage(`${docName}.md`);
  await api.replaceDoc(docName, `${FILLER}\n\nTrailing chip: [Beta page](beta.md)\n`);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror:not(.composer-prosemirror)');
  await waitForActiveProviderSynced(page);

  const chip = page.locator('span[data-link]').first();
  await expect(chip).toBeAttached({ timeout: 10_000 });

  await chip.scrollIntoViewIfNeeded();
  await expect(chip).toBeVisible();

  await chip.hover();
  const panel = page.locator('[data-ok-prop-panel="internal-link"]');
  await expect(panel).toBeVisible({ timeout: 5_000 });

  const viewport = page.viewportSize();
  if (!viewport) throw new Error('viewport size unknown');

  const panelRect = await rectOf(page, panel);
  const chipRect = await rectOf(page, chip);

  assertAnchored({ panelRect, chipRect, viewport });
});
