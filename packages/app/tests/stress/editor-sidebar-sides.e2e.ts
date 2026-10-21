import type { Page } from '@playwright/test';
import type { ApiHelpers } from './_helpers';
import {
  expect,
  headerPaneButton,
  openDesktopHeader,
  runPaletteCommand,
  stubAgentCatalog,
  test,
  waitForActiveProviderSynced,
} from './_helpers';

const BOOT_TIMEOUT_MS = 30_000;
const DOC_TEXT = 'A document between two sidebars.';
const FILE_LIST = '[data-editor-file-list-slot]';
const EDITOR_COLUMN = '[data-editor-workspace-column]';
const DOC_PANEL = '#doc-panel';
const FILE_LIST_TOGGLE = '[data-file-list-toggle]';
const DOC_PANEL_TOGGLE = '[data-doc-panel-toggle]';
const SWAP_LABEL = 'Swap file sidebar and document panel';

interface Span {
  readonly start: number;
  readonly end: number;
}

async function spanOf(page: Page, selector: string): Promise<Span | null> {
  const box = await page.locator(selector).first().boundingBox();
  return box === null ? null : { start: box.x, end: box.x + box.width };
}

async function openWide(page: Page, api: ApiHelpers, slug: string): Promise<void> {
  const name = `editor-sidebar-sides-${slug}-${test.info().workerIndex}`;
  await api.seedDocs([{ name, markdown: `# ${name}\n\n${DOC_TEXT}\n` }]);
  await stubAgentCatalog(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto(`/#/${name}`);
  await waitForActiveProviderSynced(page);
  await expect(headerPaneButton(page, 'editor')).toBeVisible({ timeout: BOOT_TIMEOUT_MS });
  await expect(page.locator('.tiptap-editor .ProseMirror').first()).toContainText(DOC_TEXT, {
    timeout: BOOT_TIMEOUT_MS,
  });
}

async function fileSidebarSide(page: Page): Promise<'left' | 'right' | 'unsettled'> {
  const [list, editor, panel, listToggle, panelToggle] = await Promise.all(
    [FILE_LIST, EDITOR_COLUMN, DOC_PANEL, FILE_LIST_TOGGLE, DOC_PANEL_TOGGLE].map((selector) =>
      spanOf(page, selector),
    ),
  );
  if (
    list == null ||
    editor == null ||
    panel == null ||
    listToggle == null ||
    panelToggle == null
  ) {
    return 'unsettled';
  }
  if (
    list.end <= editor.start + 1 &&
    panel.start >= editor.end - 1 &&
    listToggle.start < panelToggle.start
  ) {
    return 'left';
  }
  if (
    list.start >= editor.end - 1 &&
    panel.end <= editor.start + 1 &&
    listToggle.start > panelToggle.start
  ) {
    return 'right';
  }
  return 'unsettled';
}

async function widthOf(page: Page, selector: string): Promise<number> {
  const span = await spanOf(page, selector);
  return span === null ? 0 : span.end - span.start;
}

async function expectFileSidebar(page: Page, side: 'left' | 'right'): Promise<void> {
  await expect.poll(() => fileSidebarSide(page), { timeout: BOOT_TIMEOUT_MS }).toBe(side);
}

test.describe('swapping the editor sidebars', () => {
  test('the palette puts the file sidebar on the right and the document panel on the left, the two toggles trade ends, and a reload keeps it', async ({
    page,
    api,
  }) => {
    await openWide(page, api, 'palette');
    await expectFileSidebar(page, 'left');

    await runPaletteCommand(page, 'swap file sidebar', 'swap-editor-sidebars');
    await expectFileSidebar(page, 'right');

    await page.reload();
    await waitForActiveProviderSynced(page);
    await expectFileSidebar(page, 'right');
  });

  test('right-clicking an empty part of the editor tab row offers the swap, and choosing it puts the sidebars back', async ({
    page,
    api,
  }) => {
    await openWide(page, api, 'menu');
    await expectFileSidebar(page, 'left');
    await runPaletteCommand(page, 'swap file sidebar', 'swap-editor-sidebars');
    await expectFileSidebar(page, 'right');

    const strip = await page.locator('[data-editor-pane-tabs]').first().boundingBox();
    if (strip === null) throw new Error('the editor tab row has no layout box');
    await page.mouse.click(strip.x + strip.width * 0.6, strip.y + strip.height / 2, {
      button: 'right',
    });
    await page.getByRole('menuitem', { name: SWAP_LABEL }).click();
    await expectFileSidebar(page, 'left');
  });

  test('a document panel resized before a swap keeps its width, and one closed before a swap stays closed', async ({
    page,
    api,
  }) => {
    await openWide(page, api, 'panel-width');
    await expectFileSidebar(page, 'left');
    const handle = await page.locator('[data-doc-panel-handle]').boundingBox();
    if (handle === null) throw new Error('the document panel handle has no layout box');
    const before = await widthOf(page, DOC_PANEL);
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 - 80, handle.y + handle.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    await expect.poll(() => widthOf(page, DOC_PANEL)).toBeGreaterThan(before + 60);
    const resized = await widthOf(page, DOC_PANEL);

    await runPaletteCommand(page, 'swap file sidebar', 'swap-editor-sidebars');
    await expectFileSidebar(page, 'right');
    await expect
      .poll(async () => Math.abs((await widthOf(page, DOC_PANEL)) - resized))
      .toBeLessThan(3);

    const toggle = page.locator(DOC_PANEL_TOGGLE);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await runPaletteCommand(page, 'swap file sidebar', 'swap-editor-sidebars');
    await expectFileSidebar(page, 'left');
    await expect.poll(() => widthOf(page, FILE_LIST)).toBeGreaterThan(0);
    await expect(page.locator(DOC_PANEL_TOGGLE)).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(() => widthOf(page, DOC_PANEL)).toBeLessThan(2);
  });

  test('with the file sidebar on the right, dragging its edge to the left widens it', async ({
    page,
    api,
  }) => {
    await openWide(page, api, 'rail');
    await runPaletteCommand(page, 'swap file sidebar', 'swap-editor-sidebars');
    await expectFileSidebar(page, 'right');
    const rail = await page.locator(`${FILE_LIST} [data-sidebar="rail"]`).boundingBox();
    if (rail === null) throw new Error('the file sidebar rail has no layout box');
    const before = await widthOf(page, FILE_LIST);
    await page.mouse.move(rail.x + rail.width / 2, rail.y + rail.height / 2);
    await page.mouse.down();
    await page.mouse.move(rail.x + rail.width / 2 - 60, rail.y + rail.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => widthOf(page, FILE_LIST)).toBeGreaterThan(before + 40);
  });

  test('in a right-to-left layout the file sidebar keeps its rail on the edge facing the document in both arrangements, and dragging it toward the document widens it', async ({
    page,
    api,
  }) => {
    await openWide(page, api, 'rtl');
    await page.evaluate(() => {
      document.documentElement.dir = 'rtl';
    });
    for (const swapped of [false, true]) {
      if (swapped) await runPaletteCommand(page, 'swap file sidebar', 'swap-editor-sidebars');
      const expectedSide = swapped ? 'left' : 'right';
      await expect
        .poll(async () => {
          const [list, editor] = await Promise.all([
            spanOf(page, FILE_LIST),
            spanOf(page, EDITOR_COLUMN),
          ]);
          if (list === null || editor === null) return 'unsettled';
          if (list.start >= editor.end - 1) return 'right';
          if (list.end <= editor.start + 1) return 'left';
          return 'unsettled';
        })
        .toBe(expectedSide);
      const list = await spanOf(page, FILE_LIST);
      const rail = await spanOf(page, `${FILE_LIST} [data-sidebar="rail"]`);
      if (list === null || rail === null)
        throw new Error('the file sidebar or its rail has no layout box');
      const innerEdge = expectedSide === 'right' ? list.start : list.end;
      const railCenter = (rail.start + rail.end) / 2;
      expect(Math.abs(railCenter - innerEdge)).toBeLessThan(2);

      const box = await page.locator(`${FILE_LIST} [data-sidebar="rail"]`).boundingBox();
      if (box === null) throw new Error('the file sidebar rail has no layout box');
      const before = await widthOf(page, FILE_LIST);
      const towardDocument = expectedSide === 'right' ? -60 : 60;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + towardDocument, box.y + box.height / 2, {
        steps: 8,
      });
      await page.mouse.up();
      await expect.poll(() => widthOf(page, FILE_LIST)).toBeGreaterThan(before + 40);
    }
  });

  test('in a desktop project window the empty tab row is not a window drag region, so a right-click there offers the swap', async ({
    page,
    api,
    workerServer,
  }) => {
    const name = `editor-sidebar-sides-desktop-${test.info().workerIndex}`;
    await api.seedDocs([{ name, markdown: `# ${name}\n\n${DOC_TEXT}\n` }]);
    await stubAgentCatalog(page);
    await page.setViewportSize({ width: 1600, height: 900 });
    await openDesktopHeader(page, workerServer, name, {});
    await expect(page.locator('.tiptap-editor .ProseMirror').first()).toContainText(DOC_TEXT, {
      timeout: BOOT_TIMEOUT_MS,
    });
    const regions = await page.evaluate(() =>
      ['[data-editor-pane-tabs]', '[data-editor-tab-overflow-root]'].map((selector) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) return `${selector}: missing`;
        const declared = element.closest('[data-electron-drag]') !== null;
        return `${selector}: ${declared ? 'declared' : 'undeclared'} ${getComputedStyle(element).getPropertyValue('-webkit-app-region') || 'unset'}`;
      }),
    );
    expect(regions).toEqual([
      '[data-editor-pane-tabs]: declared no-drag',
      '[data-editor-tab-overflow-root]: declared no-drag',
    ]);

    const strip = await page.locator('[data-editor-pane-tabs]').first().boundingBox();
    if (strip === null) throw new Error('the editor tab row has no layout box');
    await page.mouse.click(strip.x + strip.width * 0.6, strip.y + strip.height / 2, {
      button: 'right',
    });
    await expect(page.getByRole('menuitem', { name: SWAP_LABEL })).toBeVisible();
  });
});
