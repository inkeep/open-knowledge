
import type { Page } from '@playwright/test';
import { expect, test, waitForActiveProviderSynced } from './_helpers';


/** ~30 paragraphs of filler — enough to push the trailing chip well below
 *  the first viewport (~720 px on the default Playwright viewport). */
const FILLER = Array.from({ length: 30 }, (_, i) => `Filler line ${i + 1}.`).join('\n\n');

interface PositionAssertions {
  panelRect: { x: number; y: number; width: number; height: number };
  chipRect: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number };
}

function assertAnchored({ panelRect, chipRect, viewport }: PositionAssertions) {
  expect(panelRect.y).toBeGreaterThanOrEqual(0);
  expect(panelRect.y + panelRect.height).toBeLessThanOrEqual(viewport.height);

  const verticalGap = Math.abs(panelRect.y - chipRect.y);
  expect(verticalGap).toBeLessThan(200);

  const panelCenterX = panelRect.x + panelRect.width / 2;
  const chipCenterX = chipRect.x + chipRect.width / 2;
  expect(Math.abs(panelCenterX - chipCenterX)).toBeLessThan(300);
}

async function rectOf(_page: Page, locator: ReturnType<Page['locator']>) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('locator has no bounding box');
  return box;
}


test('CHIP-POS-WIKI: wiki-link PropPanel anchors to chip rect when scrolled past first viewport', async ({
  page,
  api,
}) => {
  const docName = `chip-pos-wiki-${Math.random().toString(36).slice(2, 10)}`;
  await api.createPage(`${docName}.md`);
  await api.replaceDoc(docName, `${FILLER}\n\nTrailing chip: [[fake-target]]\n`);
  await page.goto(`/#/${docName}`);
  await page.waitForSelector('.ProseMirror');
  await waitForActiveProviderSynced(page);

  const chip = page.locator('[data-wiki-link]').first();
  await expect(chip).toBeAttached({ timeout: 10_000 });

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
  await page.waitForSelector('.ProseMirror');
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
