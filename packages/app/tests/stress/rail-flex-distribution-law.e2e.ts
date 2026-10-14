import type { Page } from '@playwright/test';
import { AGENTS_COLUMN_ID, DOC_PANEL_ID } from '../../src/components/editor-area-rail-registry';
import { acpCatalogBody, expect, test, waitForActiveProviderSynced } from './_helpers';

const OUTER_ROW_SELECTOR = '[data-editor-area-panels] > [data-group]';
const INNER_ROW_SELECTOR = '[data-editor-inner-panels] > [data-group]';
const ROWS = [
  { name: 'outer', selector: OUTER_ROW_SELECTOR, pinnedPanelId: AGENTS_COLUMN_ID },
  { name: 'inner', selector: INNER_ROW_SELECTOR, pinnedPanelId: DOC_PANEL_ID },
] as const;
const AGENTS_PANEL_MOUNT = '[data-agents-panel-mount]';
const AGENTS_HEADER_BUTTON = 'header-pane-button-agents';

const VIEWPORT_HEIGHT = 800;
const SWEEP_VIEWPORT_WIDTHS = [1281, 1367, 1451, 1610, 1687, 1733, 1813, 1953, 1960] as const;
const PROPORTIONALITY_TOLERANCE_PX = 0.25;
const MIN_RENDERED_ROW_PANELS = 2;
const BOOT_TIMEOUT_MS = 30_000;
const LAYOUT_SETTLE_TIMEOUT_MS = 10_000;

const DOC_MARKDOWN = `---
title: "Rail flex distribution"
description: "Fixture doc for the rail flex-distribution law"
---

# Rail flex distribution

Body text so the editor column renders real content while the rail is measured.`;

interface RailPanelSample {
  readonly id: string;
  readonly widthPx: number;
  readonly flexGrow: number;
}

async function readRowPanels(page: Page, selector: string): Promise<RailPanelSample[]> {
  return page.evaluate((selector) => {
    const group = document.querySelector(selector);
    if (group == null) return [];
    return [...group.querySelectorAll<HTMLElement>(':scope > [data-panel]')].map(
      (panel, index) => ({
        id: panel.id === '' ? `panel-${index}` : panel.id,
        widthPx: panel.getBoundingClientRect().width,
        flexGrow: Number.parseFloat(panel.style.flexGrow || '0'),
      }),
    );
  }, selector);
}

async function railSpacePx(page: Page): Promise<number> {
  const panels = await readRowPanels(page, OUTER_ROW_SELECTOR);
  return panels.reduce((total, panel) => total + panel.widthPx, 0);
}

async function openAgentsColumn(page: Page): Promise<void> {
  const agentsButton = page.getByTestId(AGENTS_HEADER_BUTTON);
  await expect(agentsButton).toHaveAttribute('aria-pressed', 'false', { timeout: BOOT_TIMEOUT_MS });
  await agentsButton.click();
  await expect(agentsButton).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(AGENTS_PANEL_MOUNT)).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/acp/catalog', (route) => route.fulfill({ json: acpCatalogBody([]) }));
});
test.describe('right rail flex distribution law', () => {
  test('rendered rail widths stay proportional to flex-grow across a viewport sweep', async ({
    page,
    api,
  }) => {
    const docName = `rail-flex-law-${test.info().workerIndex}`;
    await api.seedDocs([{ name: docName, markdown: DOC_MARKDOWN }]);
    await page.setViewportSize({ width: SWEEP_VIEWPORT_WIDTHS[0], height: VIEWPORT_HEIGHT });
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);
    await openAgentsColumn(page);
    const filesToggle = page.locator('[data-sidebar="trigger"]').first();
    if ((await filesToggle.getAttribute('aria-expanded')) === 'true') await filesToggle.click();
    await expect(filesToggle).toHaveAttribute('aria-expanded', 'false');

    let previousSpacePx = 0;
    let subPixelSplitSamples = 0;

    for (const viewportWidth of SWEEP_VIEWPORT_WIDTHS) {
      await page.setViewportSize({ width: viewportWidth, height: VIEWPORT_HEIGHT });
      await expect
        .poll(() => railSpacePx(page), { timeout: LAYOUT_SETTLE_TIMEOUT_MS })
        .not.toBe(previousSpacePx);
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );

      const outerPanels = await readRowPanels(page, OUTER_ROW_SELECTOR);
      previousSpacePx = outerPanels.reduce((total, panel) => total + panel.widthPx, 0);

      for (const row of ROWS) {
        await expect
          .poll(
            async () =>
              (await readRowPanels(page, row.selector)).filter((panel) => panel.widthPx > 1).length,
            { timeout: LAYOUT_SETTLE_TIMEOUT_MS },
          )
          .toBeGreaterThanOrEqual(MIN_RENDERED_ROW_PANELS);
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        const panels = await readRowPanels(page, row.selector);
        const spacePx = panels.reduce((total, panel) => total + panel.widthPx, 0);
        const totalGrow = panels.reduce((total, panel) => total + panel.flexGrow, 0);
        const renderedPanels = panels.filter((panel) => panel.widthPx > 1);
        const pinnedPanel = panels.find((panel) => panel.id === row.pinnedPanelId);

        expect(
          totalGrow,
          `viewport ${viewportWidth}, ${row.name} row: the row's panels must carry flex-grow for the law to say anything`,
        ).toBeGreaterThan(0);
        expect(
          renderedPanels.length,
          `viewport ${viewportWidth}, ${row.name} row: the law only constrains a row that is splitting its space across several rendered panels`,
        ).toBeGreaterThanOrEqual(MIN_RENDERED_ROW_PANELS);
        expect(
          pinnedPanel?.widthPx ?? 0,
          `viewport ${viewportWidth}, ${row.name} row: the px-pinned column (${row.pinnedPanelId}) must be open so the sweep measures it beside a residual one`,
        ).toBeGreaterThan(0);

        if (panels.some((panel) => !Number.isInteger(panel.widthPx))) subPixelSplitSamples += 1;

        for (const panel of panels) {
          const modelledPx = (panel.flexGrow / totalGrow) * spacePx;
          expect(
            Math.abs(panel.widthPx - modelledPx),
            `viewport ${viewportWidth}, ${row.name} row, panel ${panel.id}: the real engine rendered ${panel.widthPx}px, but distributing the row's ${spacePx}px in proportion to flex-grow ${panel.flexGrow} of ${totalGrow} predicts ${modelledPx}px. The jsdom panel-space tier derives rail widths from exactly this formula, so a divergence here means that model no longer describes the browser and every DOM-tier rail width is measuring a fiction.`,
          ).toBeLessThanOrEqual(PROPORTIONALITY_TOLERANCE_PX);
        }
      }
    }

    expect(
      subPixelSplitSamples,
      'the sweep must land on at least one sub-pixel row split, otherwise the law is only pinned where every panel happens to fall on a whole pixel',
    ).toBeGreaterThan(0);
  });
});
