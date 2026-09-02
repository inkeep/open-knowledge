import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  type ApiHelpers,
  blockMarker,
  expect,
  generateTallDoc,
  test,
  waitForActiveProviderSynced,
} from './_helpers';

const WYSIWYG = '.ProseMirror:not(.composer-prosemirror)';
const SCROLLER = '[data-testid="editor-scroll-container"]';
const TOOLBAR = '[data-testid="editor-toolbar"]';
const BUBBLE_BAR = 'bubble-menu-bar';
const COMMENT_COMPOSER = 'comment-composer';

const REGION_TOLERANCE_PX = 8;

const SELECTION_TOP_INSET_PX = 20;

const SELECTION_ABOVE_PANE_INSET_PX = -120;

const SELECTION_BOTTOM_INSET_PX = 8;

interface SurfaceGeometry {
  present: boolean;
  visible: boolean;
  top: number;
  bottom: number;
  regionTop: number;
  regionBottom: number;
  scrollerBottom: number;
  overlayBandPx: number;
  left: number;
  right: number;
  regionLeft: number;
  regionRight: number;
}

async function readSurfaceGeometry(page: Page, testId: string): Promise<SurfaceGeometry> {
  return readFloatingSurfaceGeometry(page, `[data-testid="${testId}"]`);
}

async function readFloatingSurfaceGeometry(page: Page, selector: string): Promise<SurfaceGeometry> {
  return page.evaluate(
    ({ surfaceSel, scrollerSel, toolbarSel }) => {
      const scroller = Array.from(document.querySelectorAll(scrollerSel)).find(
        (element): element is HTMLElement =>
          element instanceof HTMLElement && element.getClientRects().length > 0,
      );
      const toolbar = Array.from(document.querySelectorAll(toolbarSel)).find(
        (element): element is HTMLElement =>
          element instanceof HTMLElement && element.getClientRects().length > 0,
      );
      if (!scroller || !toolbar) {
        throw new Error(`missing chrome: scroller=${!!scroller} toolbar=${!!toolbar}`);
      }
      const scrollerBox = scroller.getBoundingClientRect();
      const readRootPx = (name: string): number => {
        const value = Number.parseFloat(document.documentElement.style.getPropertyValue(name));
        return Number.isFinite(value) ? value : 0;
      };
      const overlayBandPx =
        readRootPx('--ask-composer-height') + readRootPx('--conflict-footer-height');
      const regionTop = toolbar.getBoundingClientRect().bottom;
      const regionBottom = scrollerBox.bottom - overlayBandPx;
      const region = {
        regionTop,
        regionBottom,
        scrollerBottom: scrollerBox.bottom,
        overlayBandPx,
        regionLeft: scrollerBox.left,
        regionRight: scrollerBox.right,
      };
      const candidates = Array.from(document.querySelectorAll(surfaceSel)).filter(
        (element): element is HTMLElement => element instanceof HTMLElement,
      );
      const el = candidates.find((element) => element.getClientRects().length > 0) ?? candidates[0];
      if (!el) {
        return { present: false, visible: false, top: 0, bottom: 0, left: 0, right: 0, ...region };
      }
      const box = el.getBoundingClientRect();
      return {
        present: true,
        visible: getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length > 0,
        top: box.top,
        bottom: box.bottom,
        left: box.left,
        right: box.right,
        ...region,
      };
    },
    { surfaceSel: selector, scrollerSel: SCROLLER, toolbarSel: TOOLBAR },
  );
}

function expectInsideVisibleRegionHorizontally(geometry: SurfaceGeometry, label: string): void {
  const inside =
    geometry.left >= geometry.regionLeft - REGION_TOLERANCE_PX &&
    geometry.right <= geometry.regionRight + REGION_TOLERANCE_PX;
  expect(
    !geometry.visible || inside,
    `${label} escaped the editor's visible content region horizontally: rendered ` +
      `${geometry.left}–${geometry.right}, region ${geometry.regionLeft}–${geometry.regionRight}`,
  ).toBe(true);
}

function expectInsideVisibleRegion(geometry: SurfaceGeometry, label: string): void {
  const inside =
    geometry.top >= geometry.regionTop - REGION_TOLERANCE_PX &&
    geometry.bottom <= geometry.regionBottom + REGION_TOLERANCE_PX;
  expect(
    !geometry.visible || inside,
    `${label} escaped the editor's visible content region vertically: rendered ` +
      `${geometry.top}–${geometry.bottom}, region ${geometry.regionTop}–${geometry.regionBottom}`,
  ).toBe(true);
}

async function openTallDoc(page: Page, api: ApiHelpers, prefix: string): Promise<string> {
  const docName = `${prefix}-${randomUUID().slice(0, 8)}`;
  const { markdown } = generateTallDoc({ blockCount: 300 });
  await api.seedDocs([{ name: docName, markdown }]);
  await page.goto(`/#/${docName}`);
  await waitForActiveProviderSynced(page);
  await expect(page.locator(WYSIWYG).first()).toBeVisible();
  return docName;
}

async function selectBlockSpan(page: Page, fromMarker: string, toMarker: string): Promise<void> {
  await page.evaluate(
    ({ a, b }) => {
      const editor = window.__activeEditor;
      if (!editor) throw new Error('selectBlockSpan: window.__activeEditor not set');
      let from = -1;
      let to = -1;
      editor.state.doc.descendants((node, pos) => {
        const text = node.isText ? node.text : undefined;
        if (!text) return true;
        const startIndex = text.indexOf(a);
        if (startIndex !== -1 && from === -1) from = pos + startIndex;
        const endIndex = text.indexOf(b);
        if (endIndex !== -1) to = pos + endIndex + b.length;
        return true;
      });
      if (from === -1 || to === -1) throw new Error(`selectBlockSpan: markers not found ${a} ${b}`);
      editor.chain().focus().setTextSelection({ from, to }).run();
    },
    { a: fromMarker, b: toMarker },
  );
  await page.waitForFunction(
    ({ a, b }) => {
      const editor = window.__activeEditor;
      if (!editor) return false;
      const { from, to } = editor.state.selection;
      const text = editor.state.doc.textBetween(from, to);
      return text.startsWith(a) && text.endsWith(b);
    },
    { a: fromMarker, b: toMarker },
    { timeout: 5_000 },
  );
}

async function selectSingleMarker(page: Page, marker: string): Promise<void> {
  await page.evaluate((target) => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('selectSingleMarker: window.__activeEditor not set');
    let from = -1;
    editor.state.doc.descendants((node, pos) => {
      if (from !== -1) return false;
      const text = node.isText ? node.text : undefined;
      if (text) {
        const index = text.indexOf(target);
        if (index !== -1) from = pos + index;
      }
      return true;
    });
    if (from === -1) throw new Error(`selectSingleMarker: ${target} not found`);
    editor
      .chain()
      .focus()
      .setTextSelection({ from, to: from + target.length })
      .run();
  }, marker);
  await page.waitForFunction(
    (target) => {
      const editor = window.__activeEditor;
      if (!editor) return false;
      const { from, to } = editor.state.selection;
      return editor.state.doc.textBetween(from, to) === target;
    },
    marker,
    { timeout: 5_000 },
  );
}

async function nextLayoutFrame(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function parkSelectionTopAtPaneInset(page: Page, inset: number): Promise<void> {
  let residual = Number.NaN;
  for (let attempt = 0; attempt < 12; attempt++) {
    residual = await page.evaluate(
      ({ target, scrollerSel }) => {
        const editor = window.__activeEditor;
        const scroller = Array.from(document.querySelectorAll(scrollerSel)).find(
          (element): element is HTMLElement =>
            element instanceof HTMLElement && element.getClientRects().length > 0,
        );
        if (!editor) throw new Error('parkSelectionTopAtPaneInset: no active editor');
        if (!scroller) throw new Error('parkSelectionTopAtPaneInset: no painted scrollport');
        const { from } = editor.state.selection;
        const selectionTop = editor.view.coordsAtPos(from).top;
        const delta = selectionTop - (scroller.getBoundingClientRect().top + target);
        scroller.scrollTop += delta;
        return delta;
      },
      { target: inset, scrollerSel: SCROLLER },
    );
    if (Math.abs(residual) < 2) return;
    await nextLayoutFrame(page);
  }
  throw new Error(
    `parkSelectionTopAtPaneInset: selection top still ${residual.toFixed(1)}px from its ` +
      `${inset}px target after 12 passes`,
  );
}

interface SelectionRect {
  top: number;
  height: number;
}

async function readSelectionRect(page: Page): Promise<SelectionRect> {
  return page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('readSelectionRect: window.__activeEditor not set');
    const { from, to } = editor.state.selection;
    const start = editor.view.coordsAtPos(from);
    const end = editor.view.coordsAtPos(to, -1);
    const top = Math.min(start.top, end.top);
    const bottom = Math.max(start.bottom, end.bottom);
    return { top, height: bottom - top };
  });
}

async function expectEscapeTriggerReached(
  page: Page,
  geometry: SurfaceGeometry,
  label: string,
): Promise<void> {
  const selection = await readSelectionRect(page);
  const regionHeight = geometry.regionBottom - geometry.regionTop;
  expect(
    selection.height,
    `selection must be taller than the ${regionHeight}px visible region`,
  ).toBeGreaterThan(regionHeight);
  expect(
    selection.top,
    `selection top must sit above the visible region's top (${geometry.regionTop})`,
  ).toBeLessThan(geometry.regionTop);
  expect(
    geometry.visible,
    `${label} must be on screen for the containment arm of the contract to be the one under test`,
  ).toBe(true);
}

async function waitForSurfaceSettled(page: Page, testId: string): Promise<void> {
  await waitForFloatingSurfaceSettled(page, `[data-testid="${testId}"]`);
}

async function waitForFloatingSurfaceSettled(page: Page, selector: string): Promise<void> {
  let previous: string | null = null;
  await expect
    .poll(
      async () => {
        const geometry = await readFloatingSurfaceGeometry(page, selector);
        const current =
          `${geometry.present}:${geometry.visible}:` +
          `${Math.round(geometry.top)}:${Math.round(geometry.left)}`;
        const settled = current === previous;
        previous = current;
        return settled;
      },
      { timeout: 10_000, intervals: [200, 200, 400] },
    )
    .toBe(true);
}

async function repositionViaPluginPath(page: Page): Promise<PluginWrite> {
  await page.evaluate((barId) => {
    const bar = document.querySelector(`[data-testid="${barId}"]`);
    if (!(bar instanceof HTMLElement)) throw new Error('repositionViaPluginPath: no bubble bar');
    bar.style.top = '';
    bar.style.visibility = '';
    bar.style.width = `${bar.getBoundingClientRect().width}px`;
  }, BUBBLE_BAR);

  await nextLayoutFrame(page);
  expect(
    await page.evaluate((barId) => {
      const bar = document.querySelector(`[data-testid="${barId}"]`);
      return bar instanceof HTMLElement ? bar.style.top : null;
    }, BUBBLE_BAR),
    'the autoUpdate loop must stay asleep across the clear, or the plugin is not the writer ' +
      'under test',
  ).toBe('');

  await page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('repositionViaPluginPath: window.__activeEditor not set');
    const pluginKey = editor.state.plugins
      .map((plugin) => plugin.key)
      .find((key) => key.startsWith('bubbleMenu'));
    if (!pluginKey) throw new Error('repositionViaPluginPath: bubble-menu plugin not registered');
    editor.view.dispatch(editor.state.tr.setMeta(pluginKey, 'updatePosition'));
  });

  let written: PluginWrite = { top: null };
  await expect
    .poll(
      async () => {
        written = await page.evaluate((barId) => {
          const bar = document.querySelector(`[data-testid="${barId}"]`);
          if (!(bar instanceof HTMLElement)) return { top: null };
          if (bar.style.visibility === 'hidden') return { top: null, settled: true };
          if (bar.style.width !== 'max-content') return { top: null };
          return { top: bar.getBoundingClientRect().top, settled: true };
        }, BUBBLE_BAR);
        return written.settled === true;
      },
      {
        message:
          "the bubble-menu plugin never wrote: `width: max-content` is tiptap's stamp on its " +
          'success branch and `visibility: hidden` its occluded one, so neither appearing means ' +
          'the plugin declined to position (not visible, no virtual element, destroyed) or ' +
          'stopped stamping width',
        timeout: 5_000,
      },
    )
    .toBe(true);
  return written;
}

interface PluginWrite {
  top: number | null;
  settled?: boolean;
}

function expectGeometryIsThePluginsWrite(
  written: PluginWrite,
  geometry: SurfaceGeometry,
  label: string,
): void {
  if (written.top === null) return;
  expect(
    Math.abs(geometry.top - written.top),
    `${label}: the surface moved from the plugin's ${written.top} to ${geometry.top} between ` +
      `the wait resolving and the geometry read, so the assertions below describe a later writer`,
  ).toBeLessThanOrEqual(1);
}

function expectPluginAgreesWithLoop(
  loop: SurfaceGeometry,
  plugin: SurfaceGeometry,
  label: string,
): void {
  expect(
    Math.abs(plugin.top - loop.top),
    `${label}: tiptap's own positioning pass settled at ${plugin.top} where the autoUpdate ` +
      `loop settled at ${loop.top}. A disagreement of about one anchor gap means the plugin ` +
      `no longer builds its middleware as flip -> shift -> offset, so pendingOffsetPx now ` +
      `injects the delta it was written to absorb.`,
  ).toBeLessThanOrEqual(1);
}

test('bubble bar stays in the pane when a tall selection scrolls behind the toolbar', async ({
  page,
  api,
}) => {
  await openTallDoc(page, api, 'clip-bar');
  await selectBlockSpan(page, blockMarker(5), blockMarker(80));
  await expect(page.getByTestId(BUBBLE_BAR)).toBeVisible();

  await parkSelectionTopAtPaneInset(page, SELECTION_TOP_INSET_PX);
  await waitForSurfaceSettled(page, BUBBLE_BAR);

  const geometry = await readSurfaceGeometry(page, BUBBLE_BAR);
  expect(geometry.present, 'bubble bar still mounted').toBe(true);
  await expectEscapeTriggerReached(page, geometry, 'bubble bar');
  expectInsideVisibleRegion(geometry, 'bubble bar');
});

test('bubble bar stays in the pane when the plugin repositions it on a transaction', async ({
  page,
  api,
}) => {
  await openTallDoc(page, api, 'clip-bar-plugin');
  await selectBlockSpan(page, blockMarker(5), blockMarker(80));
  await expect(page.getByTestId(BUBBLE_BAR)).toBeVisible();

  await parkSelectionTopAtPaneInset(page, SELECTION_TOP_INSET_PX);
  await waitForSurfaceSettled(page, BUBBLE_BAR);
  const fromLoop = await readSurfaceGeometry(page, BUBBLE_BAR);

  const written = await repositionViaPluginPath(page);

  const geometry = await readSurfaceGeometry(page, BUBBLE_BAR);
  expect(geometry.present, 'bubble bar still mounted').toBe(true);
  expectGeometryIsThePluginsWrite(written, geometry, 'bubble bar above a tall selection');
  await expectEscapeTriggerReached(page, geometry, 'bubble bar (plugin pass)');
  expectInsideVisibleRegion(geometry, 'bubble bar (plugin pass)');
  expectPluginAgreesWithLoop(fromLoop, geometry, 'bubble bar above a tall selection');
});

test('comment composer stays in the pane when a tall selection scrolls behind the toolbar', async ({
  page,
  api,
}) => {
  await openTallDoc(page, api, 'clip-composer');
  await selectBlockSpan(page, blockMarker(5), blockMarker(80));
  await expect(page.getByTestId(BUBBLE_BAR)).toBeVisible();

  await page.getByTestId('comment-bubble-button').click();
  await expect(page.getByTestId(COMMENT_COMPOSER)).toBeVisible();

  await parkSelectionTopAtPaneInset(page, SELECTION_TOP_INSET_PX);
  await waitForSurfaceSettled(page, COMMENT_COMPOSER);

  const geometry = await readSurfaceGeometry(page, COMMENT_COMPOSER);
  expect(geometry.present, 'comment composer still mounted').toBe(true);
  await expectEscapeTriggerReached(page, geometry, 'comment composer');
  expectInsideVisibleRegion(geometry, 'comment composer');
});

test('bubble bar hides when a short selection scrolls fully behind the toolbar', async ({
  page,
  api,
}) => {
  await openTallDoc(page, api, 'clip-bar-short');
  await selectSingleMarker(page, blockMarker(40));
  await expect(page.getByTestId(BUBBLE_BAR)).toBeVisible();

  await parkSelectionTopAtPaneInset(page, SELECTION_TOP_INSET_PX);
  await waitForSurfaceSettled(page, BUBBLE_BAR);

  const geometry = await readSurfaceGeometry(page, BUBBLE_BAR);
  const selection = await readSelectionRect(page);
  expect(
    selection.top + selection.height,
    `the whole selection must sit above the visible region's top ` +
      `(${geometry.regionTop}) for the "or does not render" arm to be the one under test`,
  ).toBeLessThanOrEqual(geometry.regionTop);
  expect(
    geometry.visible,
    `bubble bar should be hidden for a fully occluded selection; rendered ` +
      `${geometry.top}–${geometry.bottom} in region ${geometry.regionTop}–${geometry.regionBottom}`,
  ).toBe(false);
});

test('comment composer stays put when its captured passage scrolls behind the toolbar', async ({
  page,
  api,
}) => {
  await openTallDoc(page, api, 'clip-composer-occluded');
  await selectSingleMarker(page, blockMarker(40));
  await expect(page.getByTestId(BUBBLE_BAR)).toBeVisible();

  await page.getByTestId('comment-bubble-button').click();
  await expect(page.getByTestId(COMMENT_COMPOSER)).toBeVisible();

  await parkSelectionTopAtPaneInset(page, SELECTION_ABOVE_PANE_INSET_PX);
  await waitForSurfaceSettled(page, COMMENT_COMPOSER);

  const geometry = await readSurfaceGeometry(page, COMMENT_COMPOSER);
  const selection = await readSelectionRect(page);
  expect(
    selection.top + selection.height,
    `the captured passage must have scrolled clear above the visible region's top ` +
      `(${geometry.regionTop}) for this case to be about an occluded anchor`,
  ).toBeLessThanOrEqual(geometry.regionTop);
  expect(
    geometry.visible,
    'comment composer must stay on screen while it holds a draft, even with its anchor occluded',
  ).toBe(true);
  expectInsideVisibleRegion(geometry, 'comment composer (occluded anchor)');
});

async function parkSelectionBottomAtRegionFloor(page: Page, inset: number): Promise<void> {
  let residual = Number.NaN;
  for (let attempt = 0; attempt < 12; attempt++) {
    residual = await page.evaluate(
      ({ target, scrollerSel }) => {
        const editor = window.__activeEditor;
        const scroller = Array.from(document.querySelectorAll(scrollerSel)).find(
          (element): element is HTMLElement =>
            element instanceof HTMLElement && element.getClientRects().length > 0,
        );
        if (!editor) throw new Error('parkSelectionBottomAtRegionFloor: no active editor');
        if (!scroller) throw new Error('parkSelectionBottomAtRegionFloor: no painted scrollport');
        const readRootPx = (name: string): number => {
          const value = Number.parseFloat(document.documentElement.style.getPropertyValue(name));
          return Number.isFinite(value) ? value : 0;
        };
        const overlayBandPx =
          readRootPx('--ask-composer-height') + readRootPx('--conflict-footer-height');
        const regionBottom = scroller.getBoundingClientRect().bottom - overlayBandPx;
        const { to } = editor.state.selection;
        const selectionBottom = editor.view.coordsAtPos(to, -1).bottom;
        const delta = selectionBottom - (regionBottom - target);
        scroller.scrollTop += delta;
        return delta;
      },
      { target: inset, scrollerSel: SCROLLER },
    );
    if (Math.abs(residual) < 2) return;
    await nextLayoutFrame(page);
  }
  throw new Error(
    `parkSelectionBottomAtRegionFloor: selection end still ${residual.toFixed(1)}px from its ` +
      `${inset}px target after 12 passes`,
  );
}

async function expectBottomEscapeTriggerReached(
  page: Page,
  geometry: SurfaceGeometry,
  label: string,
): Promise<void> {
  const selection = await readSelectionRect(page);
  const regionHeight = geometry.regionBottom - geometry.regionTop;
  const selectionBottom = selection.top + selection.height;
  expect(
    geometry.overlayBandPx,
    `the Ask AI composer must be up for this arm to bite: the region's floor ` +
      `(${geometry.regionBottom}) has to sit above the container's ` +
      `(${geometry.scrollerBottom})`,
  ).toBeGreaterThan(0);
  expect(
    selection.height,
    `selection must be taller than the ${regionHeight}px visible region`,
  ).toBeGreaterThan(regionHeight);
  expect(
    selectionBottom,
    `selection's end must rest in the lower half of the visible region ` +
      `(${geometry.regionTop}–${geometry.regionBottom})`,
  ).toBeGreaterThan(geometry.regionTop + regionHeight / 2);
  expect(
    selectionBottom,
    `selection's end must still be inside the visible region ` +
      `(${geometry.regionTop}–${geometry.regionBottom}), so the anchor is visible`,
  ).toBeLessThanOrEqual(geometry.regionBottom + REGION_TOLERANCE_PX);
  expect(
    geometry.visible,
    `${label} must be on screen for the containment arm of the contract to be the one under test`,
  ).toBe(true);
}

test("bubble bar stays in the pane when a tall selection's end sits at the pane floor", async ({
  page,
  api,
}) => {
  await openTallDoc(page, api, 'clip-bar-floor');
  await selectBlockSpan(page, blockMarker(5), blockMarker(80));
  await expect(page.getByTestId(BUBBLE_BAR)).toBeVisible();

  await parkSelectionBottomAtRegionFloor(page, SELECTION_BOTTOM_INSET_PX);
  await waitForSurfaceSettled(page, BUBBLE_BAR);

  const geometry = await readSurfaceGeometry(page, BUBBLE_BAR);
  expect(geometry.present, 'bubble bar still mounted').toBe(true);
  await expectBottomEscapeTriggerReached(page, geometry, 'bubble bar (below anchor)');
  expectInsideVisibleRegion(geometry, 'bubble bar (below anchor)');
});

test('bubble bar stays in the pane when the plugin repositions it below the anchor', async ({
  page,
  api,
}) => {
  await openTallDoc(page, api, 'clip-bar-floor-plugin');
  await selectBlockSpan(page, blockMarker(5), blockMarker(80));
  await expect(page.getByTestId(BUBBLE_BAR)).toBeVisible();

  await parkSelectionBottomAtRegionFloor(page, SELECTION_BOTTOM_INSET_PX);
  await waitForSurfaceSettled(page, BUBBLE_BAR);
  const fromLoop = await readSurfaceGeometry(page, BUBBLE_BAR);

  const written = await repositionViaPluginPath(page);

  const geometry = await readSurfaceGeometry(page, BUBBLE_BAR);
  expect(geometry.present, 'bubble bar still mounted').toBe(true);
  expectGeometryIsThePluginsWrite(written, geometry, 'bubble bar below a tall selection');
  await expectBottomEscapeTriggerReached(page, geometry, 'bubble bar (below anchor, plugin pass)');
  expectInsideVisibleRegion(geometry, 'bubble bar (below anchor, plugin pass)');
  expectPluginAgreesWithLoop(fromLoop, geometry, 'bubble bar below a tall selection');
});

test("comment composer stays in the pane when a tall selection's end sits at the pane floor", async ({
  page,
  api,
}) => {
  await openTallDoc(page, api, 'clip-composer-floor');
  await selectBlockSpan(page, blockMarker(5), blockMarker(80));
  await expect(page.getByTestId(BUBBLE_BAR)).toBeVisible();

  await page.getByTestId('comment-bubble-button').click();
  await expect(page.getByTestId(COMMENT_COMPOSER)).toBeVisible();

  await parkSelectionBottomAtRegionFloor(page, SELECTION_BOTTOM_INSET_PX);
  await waitForSurfaceSettled(page, COMMENT_COMPOSER);

  const geometry = await readSurfaceGeometry(page, COMMENT_COMPOSER);
  expect(geometry.present, 'comment composer still mounted').toBe(true);
  await expectBottomEscapeTriggerReached(page, geometry, 'comment composer (below anchor)');
  expectInsideVisibleRegion(geometry, 'comment composer (below anchor)');
});

async function readSelectionHorizontalRect(page: Page): Promise<{ left: number; right: number }> {
  return page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('readSelectionHorizontalRect: window.__activeEditor not set');
    const { from, to } = editor.state.selection;
    const start = editor.view.coordsAtPos(from);
    const end = editor.view.coordsAtPos(to, -1);
    return { left: Math.min(start.left, end.left), right: Math.max(start.right, end.right) };
  });
}

async function expectAnchorInsideRegionHorizontally(
  page: Page,
  geometry: SurfaceGeometry,
): Promise<void> {
  expect(geometry.visible, 'surface must be on screen for the horizontal arm to bite').toBe(true);
  const anchor = await readSelectionHorizontalRect(page);
  expect(
    anchor.left,
    `anchor's left edge must sit inside the pane (${geometry.regionLeft}–${geometry.regionRight})`,
  ).toBeGreaterThanOrEqual(geometry.regionLeft);
  expect(
    anchor.right,
    `anchor's right edge must sit inside the pane (${geometry.regionLeft}–${geometry.regionRight})`,
  ).toBeLessThanOrEqual(geometry.regionRight);
}

async function expectCentredSurfaceWouldOverhang(
  page: Page,
  geometry: SurfaceGeometry,
): Promise<void> {
  const anchor = await readSelectionHorizontalRect(page);
  const unclampedLeft = (anchor.left + anchor.right) / 2 - (geometry.right - geometry.left) / 2;
  expect(
    unclampedLeft,
    `an anchor-centred surface must overhang the pane's left edge (${geometry.regionLeft}) ` +
      `for the clamp to be under test; unclamped left would be ${unclampedLeft}`,
  ).toBeLessThan(geometry.regionLeft);
}

test('bubble bar stays inside the pane when anchored at the text column left margin', async ({
  page,
  api,
}) => {
  await openTallDoc(page, api, 'clip-bar-x');
  await selectSingleMarker(page, blockMarker(40));
  await expect(page.getByTestId(BUBBLE_BAR)).toBeVisible();
  await waitForSurfaceSettled(page, BUBBLE_BAR);

  const geometry = await readSurfaceGeometry(page, BUBBLE_BAR);
  expect(geometry.present, 'bubble bar still mounted').toBe(true);
  await expectAnchorInsideRegionHorizontally(page, geometry);
  await expectCentredSurfaceWouldOverhang(page, geometry);
  expectInsideVisibleRegionHorizontally(geometry, 'bubble bar');
});

test('bubble bar stays inside the pane horizontally when the plugin repositions it', async ({
  page,
  api,
}) => {
  await openTallDoc(page, api, 'clip-bar-x-plugin');
  await selectSingleMarker(page, blockMarker(40));
  await expect(page.getByTestId(BUBBLE_BAR)).toBeVisible();
  await waitForSurfaceSettled(page, BUBBLE_BAR);

  const written = await repositionViaPluginPath(page);

  const geometry = await readSurfaceGeometry(page, BUBBLE_BAR);
  expect(geometry.present, 'bubble bar still mounted').toBe(true);
  expectGeometryIsThePluginsWrite(written, geometry, 'bubble bar at the column left margin');
  await expectAnchorInsideRegionHorizontally(page, geometry);
  await expectCentredSurfaceWouldOverhang(page, geometry);
  expectInsideVisibleRegionHorizontally(geometry, 'bubble bar (plugin pass)');
});

test('comment composer stays inside the pane when anchored at the text column left margin', async ({
  page,
  api,
}) => {
  await openTallDoc(page, api, 'clip-composer-x');
  await selectSingleMarker(page, blockMarker(40));
  await expect(page.getByTestId(BUBBLE_BAR)).toBeVisible();

  await page.getByTestId('comment-bubble-button').click();
  await expect(page.getByTestId(COMMENT_COMPOSER)).toBeVisible();
  await waitForSurfaceSettled(page, COMMENT_COMPOSER);

  const geometry = await readSurfaceGeometry(page, COMMENT_COMPOSER);
  expect(geometry.present, 'comment composer still mounted').toBe(true);
  await expectAnchorInsideRegionHorizontally(page, geometry);
  expectInsideVisibleRegionHorizontally(geometry, 'comment composer');
});

async function narrowPaneTo(page: Page, targetPaneWidthPx: number): Promise<void> {
  const initial = page.viewportSize();
  if (!initial) throw new Error('narrowPaneTo: no viewport to resize');
  for (let round = 0; round < 6; round += 1) {
    const paneWidth = await readPaneWidth(page);
    if (paneWidth <= targetPaneWidthPx + 1) {
      await nextLayoutFrame(page);
      return;
    }
    const viewport = page.viewportSize();
    if (!viewport) throw new Error('narrowPaneTo: viewport disappeared mid-resize');
    const chromeWidth = viewport.width - paneWidth;
    await page.setViewportSize({
      width: Math.max(MIN_VIEWPORT_WIDTH_PX, Math.round(chromeWidth + targetPaneWidthPx) - 1),
      height: initial.height,
    });
    await waitForPaneWidthSettled(page);
  }
  throw new Error(
    `narrowPaneTo: pane still ${await readPaneWidth(page)}px after 6 rounds, wanted ` +
      `<= ${targetPaneWidthPx}px`,
  );
}

async function waitForPaneWidthSettled(page: Page): Promise<void> {
  let previous: number | null = null;
  await expect
    .poll(
      async () => {
        const current = Math.round(await readPaneWidth(page));
        const settled = current === previous;
        previous = current;
        return settled;
      },
      { timeout: 10_000, intervals: [100, 100, 200] },
    )
    .toBe(true);
}

const MIN_VIEWPORT_WIDTH_PX = 320;

async function narrowPaneAsFarAsPossible(page: Page): Promise<void> {
  await narrowPaneTo(page, 0).catch(() => {});
}

const SELECTION_MID_PANE_INSET_PX = 200;

async function readPaneWidth(page: Page): Promise<number> {
  return page.evaluate((scrollerSel) => {
    const scroller = Array.from(document.querySelectorAll(scrollerSel)).find(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element.getClientRects().length > 0,
    );
    if (!scroller) throw new Error('readPaneWidth: no painted scroll container');
    return scroller.getBoundingClientRect().width;
  }, SCROLLER);
}

function expectPaneNarrowerThan(
  geometry: SurfaceGeometry,
  naturalWidthPx: number,
  label: string,
): void {
  const regionWidth = geometry.regionRight - geometry.regionLeft;
  expect(
    regionWidth,
    `${label}: the pane (${regionWidth}px) must be narrower than the surface's natural ` +
      `width (${naturalWidthPx}px) for the width cap to be under test`,
  ).toBeLessThan(naturalWidthPx);
}

async function readNaturalSurfaceWidth(page: Page, testId: string): Promise<number> {
  const geometry = await readSurfaceGeometry(page, testId);
  expect(geometry.visible, 'surface must be on screen to measure its natural width').toBe(true);
  return geometry.right - geometry.left;
}

test('bubble bar stays inside a pane narrower than the bar', async ({ page, api }) => {
  await openTallDoc(page, api, 'clip-bar-narrow');
  await selectSingleMarker(page, blockMarker(40));
  await expect(page.getByTestId(BUBBLE_BAR)).toBeVisible();
  await waitForSurfaceSettled(page, BUBBLE_BAR);

  const naturalWidth = await readNaturalSurfaceWidth(page, BUBBLE_BAR);
  await narrowPaneAsFarAsPossible(page);
  await parkSelectionTopAtPaneInset(page, SELECTION_MID_PANE_INSET_PX);
  await waitForSurfaceSettled(page, BUBBLE_BAR);

  const geometry = await readSurfaceGeometry(page, BUBBLE_BAR);
  expect(geometry.present, 'bubble bar still mounted').toBe(true);
  expectPaneNarrowerThan(geometry, naturalWidth, 'bubble bar');
  await expectAnchorInsideRegionHorizontally(page, geometry);
  expectInsideVisibleRegionHorizontally(geometry, 'bubble bar (narrow pane)');
  expectInsideVisibleRegion(geometry, 'bubble bar (narrow pane)');
});

test('bubble bar stays inside a narrow pane when the plugin repositions it', async ({
  page,
  api,
}) => {
  await openTallDoc(page, api, 'clip-bar-narrow-plugin');
  await selectSingleMarker(page, blockMarker(40));
  await expect(page.getByTestId(BUBBLE_BAR)).toBeVisible();
  await waitForSurfaceSettled(page, BUBBLE_BAR);

  const naturalWidth = await readNaturalSurfaceWidth(page, BUBBLE_BAR);
  await narrowPaneAsFarAsPossible(page);
  await parkSelectionTopAtPaneInset(page, SELECTION_MID_PANE_INSET_PX);
  await waitForSurfaceSettled(page, BUBBLE_BAR);

  const written = await repositionViaPluginPath(page);

  const geometry = await readSurfaceGeometry(page, BUBBLE_BAR);
  expect(geometry.present, 'bubble bar still mounted').toBe(true);
  expectGeometryIsThePluginsWrite(written, geometry, 'bubble bar in a narrow pane');
  expectPaneNarrowerThan(geometry, naturalWidth, 'bubble bar (plugin pass)');
  await expectAnchorInsideRegionHorizontally(page, geometry);
  expectInsideVisibleRegionHorizontally(geometry, 'bubble bar (narrow pane, plugin pass)');
  expectInsideVisibleRegion(geometry, 'bubble bar (narrow pane, plugin pass)');
});

test('comment composer stays inside a pane narrower than the card', async ({ page, api }) => {
  await openTallDoc(page, api, 'clip-composer-narrow');
  await selectSingleMarker(page, blockMarker(40));
  await expect(page.getByTestId(BUBBLE_BAR)).toBeVisible();

  await page.getByTestId('comment-bubble-button').click();
  await expect(page.getByTestId(COMMENT_COMPOSER)).toBeVisible();
  await waitForSurfaceSettled(page, COMMENT_COMPOSER);

  const naturalWidth = await readNaturalSurfaceWidth(page, COMMENT_COMPOSER);
  await narrowPaneAsFarAsPossible(page);
  await waitForSurfaceSettled(page, COMMENT_COMPOSER);

  const geometry = await readSurfaceGeometry(page, COMMENT_COMPOSER);
  expect(geometry.present, 'comment composer still mounted').toBe(true);
  expect(geometry.visible, 'composer must be on screen for containment to bite').toBe(true);
  expectPaneNarrowerThan(geometry, naturalWidth, 'comment composer');
  expectInsideVisibleRegionHorizontally(geometry, 'comment composer (narrow pane)');
  expectInsideVisibleRegion(geometry, 'comment composer (narrow pane)');
});

const SLASH_PICKER = '[data-suggestion-popup="slash-command"]';
const SUGGESTION_POPUP = SLASH_PICKER;
const LINT_CALLOUT = '.ok-lint-tooltip';

const SUGGESTION_MAX_HEIGHT_FRACTION = 0.4;

async function parkCaretAtViewportY(page: Page, y: number): Promise<void> {
  let residual = Number.NaN;
  for (let attempt = 0; attempt < 12; attempt++) {
    residual = await page.evaluate(
      ({ target, scrollerSel }) => {
        const editor = window.__activeEditor;
        const scroller = Array.from(document.querySelectorAll(scrollerSel)).find(
          (element): element is HTMLElement =>
            element instanceof HTMLElement && element.getClientRects().length > 0,
        );
        if (!editor) throw new Error('parkCaretAtViewportY: no active editor');
        if (!scroller) throw new Error('parkCaretAtViewportY: no painted scrollport');
        const delta = editor.view.coordsAtPos(editor.state.selection.from).top - target;
        scroller.scrollTop += delta;
        return delta;
      },
      { target: y, scrollerSel: SCROLLER },
    );
    if (Math.abs(residual) < 2) return;
    await nextLayoutFrame(page);
  }
  throw new Error(
    `parkCaretAtViewportY: caret still ${residual.toFixed(1)}px from its ${y}px target ` +
      'after 12 passes',
  );
}

async function placeCaretNearPaneRight(page: Page, marker: string, insetPx: number): Promise<void> {
  const placed = await page.evaluate(
    ({ target, inset, scrollerSel }) => {
      const editor = window.__activeEditor;
      const scroller = Array.from(document.querySelectorAll(scrollerSel)).find(
        (element): element is HTMLElement =>
          element instanceof HTMLElement && element.getClientRects().length > 0,
      );
      if (!editor) throw new Error('placeCaretNearPaneRight: no active editor');
      if (!scroller) throw new Error('placeCaretNearPaneRight: no painted scrollport');
      const limit = scroller.getBoundingClientRect().right - inset;
      let found = -1;
      editor.state.doc.descendants((node, pos) => {
        if (found !== -1) return false;
        const text = node.isText ? node.text : undefined;
        if (text?.includes(target)) found = pos;
        return true;
      });
      if (found === -1) throw new Error(`placeCaretNearPaneRight: ${target} not found`);
      const resolved = editor.state.doc.resolve(found);
      const start = resolved.before(1) + 1;
      const end = resolved.after(1) - 1;
      let best = start;
      let bestLeft = Number.NEGATIVE_INFINITY;
      for (let pos = start; pos <= end; pos++) {
        const { left } = editor.view.coordsAtPos(pos);
        if (left <= limit && left > bestLeft) {
          bestLeft = left;
          best = pos;
        }
      }
      editor.chain().focus().setTextSelection(best).run();
      return bestLeft;
    },
    { target: marker, inset: insetPx, scrollerSel: SCROLLER },
  );
  expect(placed, `no caret position in ${marker} sits inside the pane`).toBeGreaterThan(0);
}

async function openSuggestionPicker(page: Page): Promise<void> {
  await openPicker(page, SLASH_PICKER);
}

const PICKERS = [
  { label: 'slash', trigger: ' /', selector: '[data-suggestion-popup="slash-command"]' },
  {
    label: 'wiki-link',
    trigger: ' [[',
    selector: '[data-suggestion-popup="wiki-link-suggestion"]',
  },
  { label: 'tag', trigger: ' #', selector: '[data-suggestion-popup="tag-suggestion"]' },
] as const;

async function openPicker(page: Page, selector: string, trigger = ' /'): Promise<void> {
  await page.keyboard.type(trigger);
  await page.locator(selector).waitFor({ state: 'visible', timeout: 10_000 });
  await waitForFloatingSurfaceSettled(page, selector);
}

async function readPaintedPickerBox(
  page: Page,
  selector: string,
): Promise<{ left: number; right: number }> {
  return page.evaluate((sel) => {
    const root = Array.from(document.querySelectorAll(sel)).find(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element.getClientRects().length > 0,
    );
    if (!root) throw new Error(`readPaintedPickerBox: no painted ${sel}`);
    const boxes = [root, ...root.querySelectorAll('*')]
      .filter(
        (el): el is HTMLElement => el instanceof HTMLElement && el.getClientRects().length > 0,
      )
      .map((el) => el.getBoundingClientRect());
    return {
      left: Math.min(...boxes.map((b) => b.left)),
      right: Math.max(...boxes.map((b) => b.right)),
    };
  }, selector);
}

async function readCaretRect(page: Page): Promise<{ top: number; bottom: number; left: number }> {
  return page.evaluate(() => {
    const editor = window.__activeEditor;
    if (!editor) throw new Error('readCaretRect: window.__activeEditor not set');
    const coords = editor.view.coordsAtPos(editor.state.selection.from);
    return { top: coords.top, bottom: coords.bottom, left: coords.left };
  });
}

test('suggestion picker stays inside the pane when opened past the middle of a line', async ({
  page,
  api,
}) => {
  await openTallDoc(page, api, 'clip-suggest-x');
  await selectSingleMarker(page, blockMarker(40));
  const region = await readFloatingSurfaceGeometry(page, SUGGESTION_POPUP);
  await parkCaretAtViewportY(page, region.regionTop + 40);
  await placeCaretNearPaneRight(page, blockMarker(40), 200);
  await openSuggestionPicker(page);

  const geometry = await readFloatingSurfaceGeometry(page, SUGGESTION_POPUP);
  expect(geometry.present, 'suggestion picker still mounted').toBe(true);
  expect(geometry.visible, 'suggestion picker must be on screen for containment to be tested').toBe(
    true,
  );

  const caret = await readCaretRect(page);
  expect(
    caret.left,
    `caret must sit inside the pane (${geometry.regionLeft}–${geometry.regionRight})`,
  ).toBeLessThan(geometry.regionRight);
  expect(
    caret.left + (geometry.right - geometry.left),
    `an anchor-aligned picker must overhang the pane's right edge (${geometry.regionRight}) ` +
      'for the clamp to be under test',
  ).toBeGreaterThan(geometry.regionRight);

  expectInsideVisibleRegionHorizontally(geometry, 'suggestion picker');
});

for (const picker of PICKERS) {
  test(`${picker.label} picker stays inside a pane narrower than the picker`, async ({
    page,
    api,
  }) => {
    await openTallDoc(page, api, `clip-suggest-narrow-${picker.label}`);
    await selectSingleMarker(page, blockMarker(40));
    const before = await readFloatingSurfaceGeometry(page, picker.selector);
    await parkCaretAtViewportY(page, before.regionTop + 40);
    await openPicker(page, picker.selector, picker.trigger);
    const natural = await readPaintedPickerBox(page, picker.selector);
    const naturalWidth = natural.right - natural.left;
    if (picker.label === 'slash') {
      expect(await previewColumnCount(page), 'preview column up in a roomy pane').toBe(1);
    }

    await narrowPaneAsFarAsPossible(page);
    const region = await readFloatingSurfaceGeometry(page, picker.selector);
    await parkCaretAtViewportY(page, region.regionTop + 40);
    await openPicker(page, picker.selector, picker.trigger);

    const geometry = await readFloatingSurfaceGeometry(page, picker.selector);
    expect(geometry.present, `${picker.label} picker still mounted`).toBe(true);
    expect(geometry.visible, `${picker.label} picker must be on screen to bite`).toBe(true);
    const paneWidth = geometry.regionRight - geometry.regionLeft;
    test.skip(
      naturalWidth <= paneWidth,
      `${picker.label} picker is ${naturalWidth}px, which already fits the narrowest pane ` +
        `this host lays out (${paneWidth}px) — no overhang to contain`,
    );
    expectPaneNarrowerThan(geometry, naturalWidth, `${picker.label} picker`);

    const painted = await readPaintedPickerBox(page, picker.selector);
    expect(
      painted.right,
      `${picker.label} picker painted past the pane's right edge (${geometry.regionRight}): ` +
        `rendered ${painted.left}-${painted.right}`,
    ).toBeLessThanOrEqual(geometry.regionRight + REGION_TOLERANCE_PX);
    expect(
      painted.left,
      `${picker.label} picker painted past the pane's left edge (${geometry.regionLeft}): ` +
        `rendered ${painted.left}-${painted.right}`,
    ).toBeGreaterThanOrEqual(geometry.regionLeft - REGION_TOLERANCE_PX);

    if (picker.label === 'slash') {
      expect(await previewColumnCount(page), 'preview column dropped in a narrow pane').toBe(0);
    }
  });
}

async function previewColumnCount(page: Page): Promise<number> {
  return page.evaluate(
    (selector) =>
      Array.from(document.querySelectorAll(`${selector} .ok-suggestion-preview`)).filter(
        (el) => el.getClientRects().length > 0,
      ).length,
    SUGGESTION_POPUP,
  );
}

test('suggestion picker stays inside the pane when the caret sits mid-pane', async ({
  page,
  api,
}) => {
  await openTallDoc(page, api, 'clip-suggest-y');
  await selectSingleMarker(page, blockMarker(40));
  await placeCaretNearPaneRight(page, blockMarker(40), 400);

  const region = await readFloatingSurfaceGeometry(page, SUGGESTION_POPUP);
  await parkCaretAtViewportY(page, (region.regionTop + region.regionBottom) / 2);
  await openSuggestionPicker(page);

  const geometry = await readFloatingSurfaceGeometry(page, SUGGESTION_POPUP);
  expect(geometry.present, 'suggestion picker still mounted').toBe(true);
  expect(geometry.visible, 'suggestion picker must be on screen for containment to be tested').toBe(
    true,
  );
  expect(
    geometry.bottom - geometry.top,
    'suggestion picker must keep a usable height',
  ).toBeGreaterThan(60);

  const caret = await readCaretRect(page);
  const ceiling = (await page.evaluate(() => window.innerHeight)) * SUGGESTION_MAX_HEIGHT_FRACTION;
  expect(
    geometry.regionBottom - caret.bottom,
    `room below the caret must be under the picker's ${ceiling}px ceiling for the clamp ` +
      'to be under test',
  ).toBeLessThan(ceiling);
  expect(
    caret.top - geometry.regionTop,
    `room above the caret must be under the picker's ${ceiling}px ceiling for the clamp ` +
      'to be under test',
  ).toBeLessThan(ceiling);

  expectInsideVisibleRegion(geometry, 'suggestion picker');
});

test.describe('markdown-lint hover callout', () => {
  const LINT_PARAGRAPH =
    'A wrapping paragraph with\ta hard tab in the middle of it, long enough that it spans ' +
    'more than one visual line in the editor so a pointer can rest anywhere along its width.';

  test.beforeEach(({ workerServer }) => {
    mkdirSync(join(workerServer.contentDir, '.ok'), { recursive: true });
    writeFileSync(
      join(workerServer.contentDir, '.ok', 'config.yml'),
      'contentRules:\n  markdownlint:\n    enabled: true\n',
      'utf-8',
    );
  });

  test.afterAll(({ workerServer }) => {
    writeFileSync(join(workerServer.contentDir, '.ok', 'config.yml'), '', 'utf-8');
  });

  async function openLintDoc(page: Page, api: ApiHelpers, prefix: string): Promise<void> {
    const docName = `${prefix}-${randomUUID().slice(0, 8)}`;
    const body = Array.from(
      { length: 60 },
      (_, index) => `Block ${index} — ${LINT_PARAGRAPH}`,
    ).join('\n\n');
    await api.seedDocs([{ name: docName, markdown: body }]);
    await page.goto(`/#/${docName}`);
    await waitForActiveProviderSynced(page);
    await expect(page.locator(WYSIWYG).first()).toBeVisible();
    await expect(page.locator(`${WYSIWYG} .ok-lint-block`).first()).toBeVisible({
      timeout: 20_000,
    });
  }

  async function scrollLintBlockTo(
    page: Page,
    targetTop: number,
  ): Promise<{ top: number; bottom: number; left: number; right: number }> {
    let residual = Number.NaN;
    for (let attempt = 0; attempt < 12; attempt++) {
      residual = await page.evaluate(
        ({ target, scrollerSel, wysiwygSel }) => {
          const scroller = Array.from(document.querySelectorAll(scrollerSel)).find(
            (element): element is HTMLElement =>
              element instanceof HTMLElement && element.getClientRects().length > 0,
          );
          if (!scroller) throw new Error('scrollLintBlockTo: no painted scrollport');
          const blocks = Array.from(
            document.querySelectorAll<HTMLElement>(`${wysiwygSel} .ok-lint-block`),
          );
          if (blocks.length === 0) throw new Error('scrollLintBlockTo: no lint blocks painted');
          const nearest = blocks.reduce((best, block) =>
            Math.abs(block.getBoundingClientRect().top - target) <
            Math.abs(best.getBoundingClientRect().top - target)
              ? block
              : best,
          );
          const delta = nearest.getBoundingClientRect().top - target;
          scroller.scrollTop += delta;
          return delta;
        },
        { target: targetTop, scrollerSel: SCROLLER, wysiwygSel: WYSIWYG },
      );
      if (Math.abs(residual) < 2) break;
      await nextLayoutFrame(page);
    }
    await waitForScrollSettled(page);
    return page.evaluate(
      ({ target, wysiwygSel }) => {
        const blocks = Array.from(
          document.querySelectorAll<HTMLElement>(`${wysiwygSel} .ok-lint-block`),
        );
        const nearest = blocks.reduce((best, block) =>
          Math.abs(block.getBoundingClientRect().top - target) <
          Math.abs(best.getBoundingClientRect().top - target)
            ? block
            : best,
        );
        const box = nearest.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
      },
      { target: targetTop, wysiwygSel: WYSIWYG },
    );
  }

  async function waitForScrollSettled(page: Page): Promise<void> {
    let previous: number | null = null;
    await expect
      .poll(
        async () => {
          const current = await page.evaluate((scrollerSel) => {
            const scroller = Array.from(document.querySelectorAll(scrollerSel)).find(
              (element): element is HTMLElement =>
                element instanceof HTMLElement && element.getClientRects().length > 0,
            );
            return scroller ? scroller.scrollTop : Number.NaN;
          }, SCROLLER);
          const settled = previous !== null && Math.abs(current - previous) < 0.5;
          previous = current;
          return settled;
        },
        { timeout: 10_000, intervals: [200, 200, 400] },
      )
      .toBe(true);
  }

  async function hoverLintBlock(page: Page, x: number, y: number): Promise<void> {
    await page.mouse.move(x, y);
    await expect(page.locator(`${LINT_CALLOUT}:visible`)).not.toHaveCount(0);
    await expect
      .poll(async () => {
        const geometry = await readFloatingSurfaceGeometry(page, LINT_CALLOUT);
        return geometry.top !== 0 || geometry.left !== 0;
      })
      .toBe(true);
    await waitForFloatingSurfaceSettled(page, LINT_CALLOUT);
  }

  test('hover callout stays inside the pane when its line rests below the toolbar band', async ({
    page,
    api,
  }) => {
    await openLintDoc(page, api, 'clip-lint-y');
    const region = await readFloatingSurfaceGeometry(page, LINT_CALLOUT);
    const block = await scrollLintBlockTo(page, region.regionTop + 4);
    await hoverLintBlock(page, block.left + 40, block.top + 8);

    const geometry = await readFloatingSurfaceGeometry(page, LINT_CALLOUT);
    expect(geometry.present, 'hover callout still mounted').toBe(true);
    expect(geometry.visible, 'hover callout must be on screen for containment to be tested').toBe(
      true,
    );
    expect(
      block.top - geometry.regionTop,
      `the hovered line must sit within one callout height (${geometry.bottom - geometry.top}px) ` +
        `of the visible region's top (${geometry.regionTop}) for the clamp to be under test`,
    ).toBeLessThan(geometry.bottom - geometry.top);

    expectInsideVisibleRegion(geometry, 'hover callout');
  });

  test('hover callout stays inside the pane when hovered near the column right edge', async ({
    page,
    api,
  }) => {
    await openLintDoc(page, api, 'clip-lint-x');
    const region = await readFloatingSurfaceGeometry(page, LINT_CALLOUT);
    const block = await scrollLintBlockTo(page, (region.regionTop + region.regionBottom) / 2);
    const pointerX = block.right - 8;
    await hoverLintBlock(page, pointerX, block.top + 8);

    const geometry = await readFloatingSurfaceGeometry(page, LINT_CALLOUT);
    expect(geometry.present, 'hover callout still mounted').toBe(true);
    expect(geometry.visible, 'hover callout must be on screen for containment to be tested').toBe(
      true,
    );
    expect(
      pointerX,
      `the pointer must rest inside the pane (${geometry.regionLeft}–${geometry.regionRight})`,
    ).toBeLessThan(geometry.regionRight);
    expect(
      pointerX + (geometry.right - geometry.left),
      `the callout must overhang the pane's right edge (${geometry.regionRight}) for the clamp ` +
        'to be under test',
    ).toBeGreaterThan(geometry.regionRight);

    expectInsideVisibleRegionHorizontally(geometry, 'hover callout');
  });
});
