import type { Page } from '@playwright/test';
import { AGENTS_COLUMN_ID } from '../../src/components/editor-area-rail-registry';
import { expect, test, waitForActiveProviderSynced } from './_helpers';

const RAIL_GROUP_SELECTOR = '[data-editor-area-panels] > [data-group]';
const AGENTS_PANEL_MOUNT = '[data-agents-panel-mount]';
const AGENTS_REVEAL_TAB = '[data-terminal-reveal="right"]';

const VIEWPORT_HEIGHT = 800;
const SWEEP_VIEWPORT_WIDTHS = [1281, 1367, 1451, 1610, 1733] as const;
const PROPORTIONALITY_TOLERANCE_PX = 0.25;
const MIN_RENDERED_RAIL_PANELS = 3;
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

async function readRailPanels(page: Page): Promise<RailPanelSample[]> {
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
  }, RAIL_GROUP_SELECTOR);
}

async function railSpacePx(page: Page): Promise<number> {
  const panels = await readRailPanels(page);
  return panels.reduce((total, panel) => total + panel.widthPx, 0);
}

async function openAgentsColumn(page: Page): Promise<void> {
  const reveal = page.locator(AGENTS_REVEAL_TAB);
  await expect(reveal).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  await reveal.click();
  await expect(page.locator(AGENTS_PANEL_MOUNT)).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
}

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

      const panels = await readRailPanels(page);
      const spacePx = panels.reduce((total, panel) => total + panel.widthPx, 0);
      const totalGrow = panels.reduce((total, panel) => total + panel.flexGrow, 0);
      const renderedPanels = panels.filter((panel) => panel.widthPx > 1);
      const agentsPanel = panels.find((panel) => panel.id === AGENTS_COLUMN_ID);
      previousSpacePx = spacePx;

      expect(
        totalGrow,
        `viewport ${viewportWidth}: the rail panels must carry flex-grow for the law to say anything`,
      ).toBeGreaterThan(0);
      expect(
        renderedPanels.length,
        `viewport ${viewportWidth}: the law only constrains a rail that is splitting its space across several rendered panels`,
      ).toBeGreaterThanOrEqual(MIN_RENDERED_RAIL_PANELS);
      expect(
        agentsPanel?.widthPx ?? 0,
        `viewport ${viewportWidth}: the agents column must be open so the sweep measures a px-pinned column beside a residual one`,
      ).toBeGreaterThan(0);

      if (panels.some((panel) => !Number.isInteger(panel.widthPx))) subPixelSplitSamples += 1;

      for (const panel of panels) {
        const modelledPx = (panel.flexGrow / totalGrow) * spacePx;
        expect(
          Math.abs(panel.widthPx - modelledPx),
          `viewport ${viewportWidth}, panel ${panel.id}: the real engine rendered ${panel.widthPx}px, but distributing the rail's ${spacePx}px in proportion to flex-grow ${panel.flexGrow} of ${totalGrow} predicts ${modelledPx}px. The jsdom panel-space tier derives rail widths from exactly this formula, so a divergence here means that model no longer describes the browser and every DOM-tier rail width is measuring a fiction.`,
        ).toBeLessThanOrEqual(PROPORTIONALITY_TOLERANCE_PX);
      }
    }

    expect(
      subPixelSplitSamples,
      'the sweep must land on at least one sub-pixel rail split, otherwise the law is only pinned where every panel happens to fall on a whole pixel',
    ).toBeGreaterThan(0);
  });
});
