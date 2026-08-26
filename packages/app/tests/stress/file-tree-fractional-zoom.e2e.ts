/**
 * Pierre infers overflow from a hidden wrapping copy inside a CSS size
 * container. Only a real browser exposes the fractional layout-unit rounding
 * that can push a fitting one-line name above the marker threshold. CSS zoom
 * is a proxy for page zoom here because both feed Blink's effective zoom and
 * the same 1/64px layout-unit snapping, while Playwright has no page-zoom API.
 */
import type { Locator } from '@playwright/test';
import { expect, test } from './_helpers';

const FITTING_PATH = 'README.md';
const OVERFLOWING_PATH =
  'this-document-name-is-deliberately-long-enough-to-overflow-the-sidebar-file-tree.md';
// Electron maps zoom level to `1.2 ** level`, and the desktop View menu steps
// levels by 0.5. The defect was first found while sweeping levels 0 to -2, so
// the negative half replays that range and the positive half is its
// reflection; browser presets set the union's outer bounds. Neighbours are not
// equivalent for sub-pixel rounding.
const DESKTOP_ZOOM_FACTORS = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2].map((level) => 1.2 ** level);
const BROWSER_ZOOM_FACTORS = [0.25, 1 / 3, 0.5, 2 / 3, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const ZOOM_FACTORS = [...new Set([...DESKTOP_ZOOM_FACTORS, ...BROWSER_ZOOM_FACTORS])].sort(
  (a, b) => a - b,
);

async function sampleMarkerOpacities(tree: Locator, zoomFactor: number): Promise<number[]> {
  return tree.evaluate(
    async (host, { itemPaths, zoom }) => {
      document.documentElement.style.zoom = String(zoom);
      // Let Blink settle both zoom-driven layout and its container queries.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );

      return itemPaths.map((itemPath) => {
        const row = host.shadowRoot?.querySelector(`[data-item-path="${itemPath}"]`);
        const marker = row?.querySelector<HTMLElement>('[data-truncate-marker]');
        if (!marker) throw new Error(`Missing truncation marker for ${itemPath}`);
        return Number.parseFloat(getComputedStyle(marker).opacity);
      });
    },
    { itemPaths: [FITTING_PATH, OVERFLOWING_PATH], zoom: zoomFactor },
  );
}

test('fractional zoom marks only file names that actually overflow', async ({ page, api }) => {
  await api.seedDocs([
    { name: 'README', markdown: '# README\n' },
    { name: OVERFLOWING_PATH, markdown: '# Overflowing name\n' },
  ]);
  await page.goto('/');

  const tree = page.locator('file-tree-container');
  await expect(tree.getByRole('treeitem', { name: FITTING_PATH, exact: true })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: OVERFLOWING_PATH, exact: true })).toBeVisible();

  const falsePositiveFactors: number[] = [];
  const missingOverflowFactors: number[] = [];
  for (const zoomFactor of ZOOM_FACTORS) {
    const [fittingOpacity, overflowingOpacity] = await sampleMarkerOpacities(tree, zoomFactor);
    if (fittingOpacity > 0) falsePositiveFactors.push(zoomFactor);
    if (overflowingOpacity === 0) missingOverflowFactors.push(zoomFactor);
  }

  expect(falsePositiveFactors, 'fitting names must not show a truncation marker').toEqual([]);
  expect(missingOverflowFactors, 'overflowing names must keep their truncation marker').toEqual([]);
});
