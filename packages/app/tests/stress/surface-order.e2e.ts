import type { Page } from '@playwright/test';
import type { ApiHelpers } from './_helpers';
import {
  expect,
  headerPaneButton,
  relativeLuminance,
  rgbaBytesOf,
  screenshotBrightness,
  stubAgentCatalog,
  test,
  waitForActiveProviderSynced,
} from './_helpers';

type Theme = 'light' | 'dark';

const BOOT_TIMEOUT_MS = 30_000;
const DOC_TEXT = 'Cards sit on a desk.';
const DESK = 'header[data-app-header]';
const SIDEBAR = '[data-slot="sidebar-inner"]';
const DOCUMENT = '[data-slot="sidebar-inset"]';
const EDITOR_CARD = '[data-slot="pane-card"][data-pane="editor"]';
const AGENTS_CARD = '[data-slot="pane-card"][data-pane="agents"]';
const EDGES = ['top', 'right', 'bottom', 'left'] as const;
const EDGE_SAMPLE_PX = 4;
const RING_STEP = 12;
const POPOVER = '[data-slot="dialog-content"]';

test.use({ deviceScaleFactor: 2 });

async function openInTheme(page: Page, api: ApiHelpers, theme: Theme): Promise<void> {
  const name = `surface-order-${theme}-${test.info().workerIndex}`;
  await api.seedDocs([{ name, markdown: `# ${name}\n\n${DOC_TEXT}\n` }]);
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript((value) => window.localStorage.setItem('ok-theme-v1', value), theme);
  await stubAgentCatalog(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`/#/${name}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`));
  await expect(headerPaneButton(page, 'editor')).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  await expect(page.locator('.tiptap-editor .ProseMirror').first()).toContainText(DOC_TEXT, {
    timeout: BOOT_TIMEOUT_MS,
  });
}

async function luminanceOf(page: Page, selector: string): Promise<number> {
  const surface = page.locator(selector).first();
  await expect(surface).toBeVisible();
  const color = await surface.evaluate((element) => getComputedStyle(element).backgroundColor);
  const [bytes] = await rgbaBytesOf(page, [color]);
  if (bytes === undefined || bytes[3] !== 255) {
    throw new Error(`${selector} paints no opaque background of its own`);
  }
  return relativeLuminance(bytes);
}

type Edge = 'top' | 'right' | 'bottom' | 'left';

async function edgeBrightness(
  page: Page,
  selector: string,
  edge: Edge,
): Promise<{ ring: number; inside: number }> {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new Error(`${selector} has no layout box`);
  const horizontal = edge === 'left' || edge === 'right';
  const along = Math.round(horizontal ? box.y + box.height / 2 : box.x + box.width / 2);
  const at = Math.round(
    { top: box.y, right: box.x + box.width, bottom: box.y + box.height, left: box.x }[edge],
  );
  const towardEdgeLast = edge === 'right' || edge === 'bottom';
  const start = towardEdgeLast ? at - EDGE_SAMPLE_PX : at;
  const clip = horizontal
    ? { x: start, y: along, width: EDGE_SAMPLE_PX, height: 1 }
    : { x: along, y: start, width: 1, height: EDGE_SAMPLE_PX };
  const pixels = await screenshotBrightness(page, await page.screenshot({ clip }));
  const fromEdge = towardEdgeLast ? [...pixels].reverse() : pixels;
  return {
    ring: Math.max(fromEdge[0] ?? 0, fromEdge[1] ?? 0),
    inside: fromEdge[fromEdge.length - 1] ?? 0,
  };
}

async function readSurfaces(page: Page) {
  const desk = await luminanceOf(page, DESK);
  const sidebar = await luminanceOf(page, SIDEBAR);
  const document = await luminanceOf(page, DOCUMENT);
  await page.keyboard.press('ControlOrMeta+k');
  const popover = await luminanceOf(page, POPOVER);
  await page.keyboard.press('Escape');
  await expect(page.locator(POPOVER)).toHaveCount(0);
  return { desk, sidebar, document, popover };
}

test.describe('surface order', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`in the ${theme} theme the desk is darkest, the file sidebar steps up from it, the document is lighter still and a popover is no darker than the document`, async ({
      page,
      api,
    }) => {
      await openInTheme(page, api, theme);
      const { desk, sidebar, document, popover } = await readSurfaces(page);

      expect(desk, 'desk below the file sidebar').toBeLessThan(sidebar);
      expect(sidebar, 'file sidebar below the document').toBeLessThan(document);
      expect(popover, 'popover against the document').toBeGreaterThanOrEqual(document);
    });
  }

  test('in the dark theme a popover steps up to its own lighter surface', async ({ page, api }) => {
    await openInTheme(page, api, 'dark');
    const { document, popover } = await readSurfaces(page);
    expect(popover).toBeGreaterThan(document);
  });

  test('in the dark theme every edge of the editor and Agents cards paints a ring, including where the file list and document panel reach it', async ({
    page,
    api,
  }) => {
    await openInTheme(page, api, 'dark');
    const agents = headerPaneButton(page, 'agents');
    if ((await agents.getAttribute('aria-pressed')) !== 'true') await agents.click();
    await expect(page.locator(AGENTS_CARD)).toBeVisible();
    for (const card of [EDITOR_CARD, AGENTS_CARD]) {
      for (const edge of EDGES) {
        const { ring, inside } = await edgeBrightness(page, card, edge);
        expect(ring - inside, `${card} ${edge} edge`).toBeGreaterThan(RING_STEP);
      }
    }
  });

  test('in the light theme the editor card relies on its shadow and paints no ring', async ({
    page,
    api,
  }) => {
    await openInTheme(page, api, 'light');
    for (const edge of EDGES) {
      const { ring, inside } = await edgeBrightness(page, EDITOR_CARD, edge);
      expect(Math.abs(ring - inside), `editor card ${edge} edge`).toBeLessThanOrEqual(RING_STEP);
    }
  });
});
