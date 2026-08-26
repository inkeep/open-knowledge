/**
 * Selection-anchored floating surfaces stay inside the editor's visible
 * content region — or don't render.
 *
 * Both surfaces (the formatting bubble bar and the comment composer card) are
 * `position: fixed`, body-appended, and anchored to a virtual element whose
 * rect is the SELECTION's rect, not a laid-out node. Nothing in the DOM clips
 * them: the editor's scroll container is not an ancestor. Their final `top` is
 * whatever floating-ui's middleware chain emits, so the chain is the only thing
 * standing between a selection scrolled behind the toolbar band and a toolbar
 * painted over the document tab strip.
 *
 * `flip()` selects a placement but never moves a coordinate, `shift()` clamps
 * the cross axis only when asked (it isn't, by default) and defaults its
 * boundary to the clipping ancestors rather than the pane, and `hide()`'s
 * `referenceHidden` reports only a FULLY occluded anchor. A selection taller
 * than the pane therefore overflows both candidate placements, keeps the
 * top-side one, and lands at `selectionTop - offset - surfaceHeight` — a
 * coordinate that can be arbitrarily far above the pane, or above the window.
 *
 * What this file pins is the observable contract, not a middleware
 * arrangement: the surface's rendered rect sits inside the visible content
 * region, or the surface is not visible. The region's top edge is read from
 * the opaque `EditorToolbar` overlay's own rect (the same anchor
 * `outline-toolbar-occlusion.e2e.ts` measures against) and its bottom edge
 * from the scroll container MINUS the overlay band the Ask AI composer and
 * the conflict footer publish, which is the same floor production clamps
 * into. Taking the raw container edge instead would leave a composer-sized
 * strip in which a surface could sit over the composer's input and still
 * satisfy every assertion here.
 *
 * Three positioning call sites share the contract and are covered separately:
 *
 *   1. `BubbleMenuBar`'s `autoUpdate` loop — driven by scroll and resize.
 *   2. The `<BubbleMenu>` plugin's OWN `computePosition`, which tiptap runs on
 *      editor transactions (remote CRDT edits included) with a second copy of
 *      the options. Fixing only the loop leaves this path escaping, so it is
 *      exercised through a transaction that cannot wake the loop — see
 *      `repositionViaPluginPath`.
 *   3. `CommentSelectionAffordance`'s `autoUpdate` loop.
 *
 * The short-selection cases are guards rather than regressions, and the two
 * surfaces diverge there on purpose. The bar takes `hide()`: it already fires
 * for a fully occluded anchor today and the fix must keep it firing, since
 * clamping the ANCHOR rect instead of the surface's own coordinate would
 * silently break it (`referenceHidden` is computed from that very rect) and
 * leave a bar floating over the composer with no visible selection under it.
 * The comment composer declines that arm: it holds a live draft and owns the
 * caret, so it parks at the region's edge instead of vanishing.
 */

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

/**
 * Absorbs sub-pixel rounding and the few pixels by which the toolbar's
 * rendered box can differ from the constant the clamp reserves for it (the
 * toolbar is content-sized, not a fixed `h-14`). Every escape under test
 * clears the region by at least one surface height — roughly 40 px for the
 * bar, more for the composer card — and by the anchor's whole distance above
 * the pane in the upward cases, so no real escape hides inside it.
 */
const REGION_TOLERANCE_PX = 8;

/**
 * How far below the scroll container's top edge the selection's top is parked.
 * Any value inside the toolbar band works; 20 px puts it unambiguously behind
 * the opaque overlay without touching the band's edges.
 */
const SELECTION_TOP_INSET_PX = 20;

/**
 * Where the selection's top is parked for the composer's occluded-anchor case:
 * ABOVE the scroll container, not merely behind the toolbar band.
 *
 * At `SELECTION_TOP_INSET_PX` the card's unclamped `bottom-start` coordinate
 * already sits within a few px of the region's top, so a containment assertion
 * there passes whether or not the clamp ran. Scrolling the anchor off the top
 * puts the unclamped coordinate ~130 px above the region and gives that half of
 * the test the same margin the other arms have. Kept small enough that the
 * anchor's block stays in a materialized chunk, so `coordsAtPos` is meaningful.
 */
const SELECTION_ABOVE_PANE_INSET_PX = -120;

/**
 * How far above the visible region's FLOOR the selection's END is parked for
 * the downward cases (the floor, not the scroll container's own edge — the Ask
 * AI composer floats over the band between them). Small enough that a surface
 * placed below the anchor clears the region by far more than
 * `REGION_TOLERANCE_PX`, large enough that the anchor stays visible.
 */
const SELECTION_BOTTOM_INSET_PX = 8;

interface SurfaceGeometry {
  present: boolean;
  visible: boolean;
  top: number;
  bottom: number;
  /** Bottom edge of the opaque toolbar overlay — the visible region's top. */
  regionTop: number;
  /** Scroll container's bottom edge less the overlay band — the region's bottom. */
  regionBottom: number;
  /** The raw scroll-container bottom, i.e. `regionBottom` plus the band. */
  scrollerBottom: number;
  /** Height the Ask AI composer + conflict footer reserve at the container's foot. */
  overlayBandPx: number;
  left: number;
  right: number;
  /** The scroll container's left/right edges — the visible region is a box,
   *  not a horizontal band, so the pane's side edges bound it too. */
  regionLeft: number;
  regionRight: number;
}

async function readSurfaceGeometry(page: Page, testId: string): Promise<SurfaceGeometry> {
  return readFloatingSurfaceGeometry(page, `[data-testid="${testId}"]`);
}

/**
 * Same read against an arbitrary selector, for the surfaces that carry no
 * `data-testid`: the suggestion picker (a body-appended `div` tagged only by
 * `data-suggestion-popup`) and the markdown-lint hover callout (`.ok-lint-tooltip`).
 *
 * Resolves the same way the scroller and toolbar do — first element that has a
 * layout box — because a pool-hidden editor keeps its own callout in the DOM
 * (`display: none`, so no client rects) alongside the painted one's.
 */
async function readFloatingSurfaceGeometry(page: Page, selector: string): Promise<SurfaceGeometry> {
  return page.evaluate(
    ({ surfaceSel, scrollerSel, toolbarSel }) => {
      // First-match `querySelector` is unsafe here: a hidden `<Activity>`
      // entry keeps its scroll container in the DOM, so more than one can
      // exist and only the painted one is the active scrollport (the idiom
      // `_helpers/scrollport.ts` was factored out to carry).
      const scroller = Array.from(document.querySelectorAll(scrollerSel)).find(
        (element): element is HTMLElement =>
          element instanceof HTMLElement && element.getClientRects().length > 0,
      );
      // Same reason as the scroller above: a toolbar renders per visible doc,
      // so a retained hidden entry can hand back a zero rect.
      const toolbar = Array.from(document.querySelectorAll(toolbarSel)).find(
        (element): element is HTMLElement =>
          element instanceof HTMLElement && element.getClientRects().length > 0,
      );
      if (!scroller || !toolbar) {
        throw new Error(`missing chrome: scroller=${!!scroller} toolbar=${!!toolbar}`);
      }
      const scrollerBox = scroller.getBoundingClientRect();
      // The same two vars `deriveEditorClipOptions` reads. Reading them here
      // rather than restating the container's raw edge is what makes this
      // assertion the region production clamps into: a clamp that dropped the
      // overlay inset would land a surface over the Ask AI composer's input
      // and still sit inside the container.
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

/**
 * The vertical half of the containment contract, complementary to
 * `expectInsideVisibleRegionHorizontally`. The name predates the horizontal
 * sibling and reads as the two-axis superset it is not, so the failure message
 * names the axis — several tests now call both side by side, and a report that
 * said only "escaped the region" would leave the reader to infer which one.
 */
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

/**
 * Select from the block carrying `fromMarker` through the one carrying
 * `toMarker`. The resulting selection is taller than the pane, which is the
 * amplifier the escape needs: both candidate placements overflow, so `flip`'s
 * `bestFit` keeps the top-side one instead of moving the surface anywhere.
 */
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

/** Select just the marker word of one block — a selection shorter than the pane. */
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

/** Yield until layout has settled for the scroll just applied. */
async function nextLayoutFrame(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/**
 * Scroll the pane until the selection's top edge sits `inset` px below the
 * scroll container's top.
 *
 * A POSITIVE inset parks the selection's start inside the toolbar band, where
 * the user can no longer see where it begins but the container still holds it.
 * A NEGATIVE one parks it above the container entirely — a strictly stronger
 * occlusion, and the state the composer's occluded-anchor case needs.
 *
 * Iterative because moving the scrollport re-lays-out lazily-rendered blocks,
 * which moves the target again; it converges in a handful of passes and stops
 * once the residual is sub-pixel.
 */
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
        // Throw rather than report a zero residual: 0 is this loop's
        // "converged" value, so a missing editor or scrollport would read as
        // a successful park and surface downstream as a confusing assertion
        // about the selection instead.
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

/**
 * The selection's rendered rect, read the same way the surfaces' virtual
 * elements read it. Used to prove the trigger state was actually reached
 * rather than asserted against a selection that never left the visible region.
 */
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

/**
 * Assert the escape's preconditions actually hold: the selection is taller
 * than the visible region (so both candidate placements overflow and `flip` has
 * nowhere good to go), its top edge has scrolled behind the toolbar band (so
 * the top-side placement resolves above the pane), and the surface is on
 * screen — without that last one the contract's "or does not render" arm
 * would satisfy the containment assertion vacuously, and anything that made
 * occlusion detection over-eager would turn these tests from "the bar is
 * contained" into "the bar is absent" while staying green.
 *
 * Asserting visibility is safe precisely because the selection is taller than
 * the region: it is always partially on screen, so `referenceHidden` is false.
 */
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

/**
 * Wait until the surface's rendered position stops moving across two samples,
 * on both axes — the X-axis tests read `left`/`right` with this as their only
 * gate.
 *
 * Polling the ASSERTION directly would terminate on the first satisfying
 * sample, which can be an intermediate position from part-way through the
 * scroll, and never observe the terminal one. Settling first makes the read
 * deterministic in both the escaping and the corrected case.
 *
 * The poll's own interval is the gap between the two samples — the shape
 * `primeFullLayout` uses — rather than a fixed sleep inside the callback,
 * which would be the busy-wait the E2E stop rules ban.
 */
async function waitForSurfaceSettled(page: Page, testId: string): Promise<void> {
  await waitForFloatingSurfaceSettled(page, `[data-testid="${testId}"]`);
}

/** `waitForSurfaceSettled` against an arbitrary selector. */
async function waitForFloatingSurfaceSettled(page: Page, selector: string): Promise<void> {
  let previous: string | null = null;
  await expect
    .poll(
      async () => {
        const geometry = await readFloatingSurfaceGeometry(page, selector);
        // Both axes: this helper is the only gate before the X-axis tests read
        // `left`/`right`, and Y-stability implies X-stability only while both
        // land in the same assignment block.
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

/**
 * Make the `<BubbleMenu>` plugin's own positioning pass the last writer, with
 * the component's `autoUpdate` loop provably asleep.
 *
 * tiptap's bubble-menu view re-runs `computePosition` whenever a transaction
 * carries its `updatePosition` meta. A meta-only transaction changes neither
 * the document nor the selection nor any layout, so none of `autoUpdate`'s
 * triggers (ancestor scroll/resize, element resize, layout shift) can fire —
 * leaving the plugin as the only code that can write to the bar.
 *
 * Attribution is what makes that useful, and `top`/`visibility` cannot supply
 * it — both writers set exactly those. `width` can: tiptap stamps
 * `max-content` alongside its coordinates, and the loop never touches width.
 * So the clear pins `width` to the bar's own measured box (identical under
 * `box-sizing: border-box`, so the ResizeObserver stays quiet) and the wait
 * keys on `max-content` coming back, which only the plugin writes.
 *
 * The `visibility: hidden` disjunct is the plugin's early-return branch, but
 * the loop reaches that state too (`BubbleMenuBar` stamps it on
 * `referenceHidden`), so it is a terminal condition rather than an attribution
 * signal — the callers close it by asserting the surface is on screen. The
 * `top === ''` control across the clear window is what catches a loop tick
 * before the dispatch.
 *
 * Returns the coordinate the plugin actually wrote, because attribution ends
 * when the wait resolves and every caller reads its geometry a round trip
 * later. `autoUpdate` can tick in that gap with no scroll or resize: its
 * ResizeObserver unobserves and re-observes the floating element on a frame,
 * and `observe()` delivers an initial entry, so a lazily-materialized chunk
 * resizing `editor.view.dom` produces one. The loop never touches width, so
 * nothing else downstream would notice it had overwritten the plugin.
 */
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

  // `expect.poll` rather than `page.waitForFunction`, which carries no message:
  // three paths through tiptap's `updatePosition` write nothing at all (not
  // visible, no virtual element, destroyed/disconnected inside the `.then()`),
  // and any upstream change to the width stamp lands the same way, so the bare
  // form would report every one of them as an unexplained 5 s timeout.
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

/** What the plugin's own positioning pass wrote, or `null` on its hidden branch. */
interface PluginWrite {
  top: number | null;
  settled?: boolean;
}

/**
 * Assert the geometry the caller went on to read is still the plugin's write.
 *
 * Cheap insurance on the round trip between the wait resolving and the read:
 * a loop tick landing there would overwrite the coordinate with nothing else
 * noticing, since the loop never touches width.
 */
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

/**
 * The plugin's pass and the loop's pass must land on the same pixel.
 *
 * The two chains apply the same anchor gap in opposite orders — the loop as
 * `offset -> flip -> shift`, tiptap's plugin as `flip -> shift -> offset` —
 * and `deriveEditorShiftOptions`' `pendingOffsetPx` exists solely to cancel
 * that difference. The order is tiptap's private `middlewares` getter, with no
 * options passthrough and no test of its own upstream, and floating-ui's own
 * guidance is the opposite arrangement. So a tiptap release that "fixed" the
 * order would turn the compensation from a correction into a gap-sized
 * injection: correct in the loop, off by the gap in the plugin, with the bar
 * jittering by that much on every transaction. Containment alone cannot see
 * it — both coordinates stay inside the region — so the agreement is asserted
 * directly.
 */
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

  // The anchor is fully occluded here, so the contract's "or does not render"
  // arm is the one that must hold. Asserting the surface is hidden — not
  // merely inside the region — is what stops a fix from satisfying the tall
  // cases by clamping the anchor rect, which would keep this bar visible over
  // the pane's chrome with nothing under it.
  const geometry = await readSurfaceGeometry(page, BUBBLE_BAR);
  // Prove the trigger state first. Without it this passes whenever the bar is
  // absent for any reason at all, including a park that overshot and left the
  // anchor somewhere else entirely.
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

  // The mirror image of the bar's guard above, and a deliberate divergence:
  // the two surfaces share the region producers but not the middleware chain.
  // The bar takes hide() and vanishes with its anchor; this card holds a live
  // draft and owns the caret, so stamping `visibility: hidden` on it would
  // drop focus to <body> mid-sentence. It stays put at the region's edge, and
  // the passage it annotates stays marked in the document. Pinning the choice
  // here keeps it a decision rather than an accident of omission.
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

/**
 * Scroll the pane until the selection's END sits `inset` px above the visible
 * region's floor.
 *
 * This is the mirror of `parkSelectionTopAtPaneInset`, and it reaches the
 * contract's other arm: with the selection's start far above the pane and its
 * end at the region's floor, the bottom-side placement is the one `flip`
 * keeps, and the surface lands below the anchor — over the bottom composer and
 * the status footer rather than inside the region.
 *
 * Constructed rather than inherited. Selecting a range taller than the pane
 * already leaves the head near the pane's bottom, because ProseMirror scrolls
 * it into view; but that resting coordinate comes out of a race between the
 * scroll and the lazily-resolving chunk heights of a virtualized 300-block
 * document, and it settles in one of two places from run to run. Converging on
 * it explicitly makes the trigger identical every time.
 *
 * Iterative for the same reason the top-side helper is: moving the scrollport
 * re-lays-out lazily-rendered blocks, which moves the target again.
 */
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
        // Against the region's floor, not the container's: the Ask AI
        // composer floats over the band between them, so parking the anchor
        // there would put it behind the composer card and make the "the
        // anchor is still visible" precondition false.
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

/**
 * Assert the downward escape's preconditions: the region's floor really is
 * inset by a published overlay band, the selection is taller than the visible
 * region (so both candidate placements overflow), its end rests in the
 * region's lower half but still inside it (so the anchor is genuinely on
 * screen rather than behind the composer card, and the bottom-side placement
 * is the one that overflows least), and the surface is on screen — without that last one
 * the contract's "or does not render" arm would satisfy the assertion
 * vacuously.
 */
async function expectBottomEscapeTriggerReached(
  page: Page,
  geometry: SurfaceGeometry,
  label: string,
): Promise<void> {
  const selection = await readSelectionRect(page);
  const regionHeight = geometry.regionBottom - geometry.regionTop;
  const selectionBottom = selection.top + selection.height;
  // Without a published overlay band the region's floor collapses onto the
  // scroll container's own edge, and the downward arm silently degrades into
  // the weaker claim a pre-fix surface already satisfies.
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

/**
 * The selection's horizontal extent, read the way the surfaces' virtual
 * elements read it.
 */
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

/**
 * The precondition every horizontal case shares: the surface is on screen, and
 * its anchor is itself well inside the pane's side edges — so anything that
 * spills past them does so on the surface's own account, not because the user
 * selected text that was already out of bounds.
 *
 * Says nothing about whether the clamp had anything to do; that is
 * `expectCentredSurfaceWouldOverhang`, which only the centred surfaces can
 * answer.
 */
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

/**
 * Assert the horizontal clamp is actually under test: for a placement centred
 * on its anchor the unclamped left edge is derivable, and it has to overhang
 * the pane for the clamp to have anything to do. Without this the whole arm
 * turns into a no-op the day `--content-max-width` or the pane's side margin
 * moves the prose column far enough inboard, and nothing goes red.
 *
 * Its own assertion rather than a flag on the one above, so a surface that
 * cannot reach the escape — the comment composer, whose `bottom-start` is
 * anchor-aligned rather than centred and which is narrow enough to clear the
 * gutter today — omits a visible call instead of an invisible argument.
 */
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

  // The composer is narrow enough to clear the pane's left edge today, so this
  // is a guard rather than a regression: moving the horizontal clamp from the
  // window to the pane must not start pushing it out of the pane instead.
  const geometry = await readSurfaceGeometry(page, COMMENT_COMPOSER);
  expect(geometry.present, 'comment composer still mounted').toBe(true);
  await expectAnchorInsideRegionHorizontally(page, geometry);
  expectInsideVisibleRegionHorizontally(geometry, 'comment composer');
});

/**
 * The pane NARROWER than the surface anchored in it.
 *
 * Everything above turns on WHERE a surface is put. This turns on how WIDE it
 * is: `shift()` relocates but cannot shrink, and its clamp can satisfy both
 * pane edges only while the surface fits between them. A surface with a fixed
 * width overhangs a narrower pane from every coordinate the clamp could pick,
 * so a boundary-aware chain still paints it on the neighbour — the escape the
 * position fix could not reach.
 *
 * In the product the narrowing is a docked session panel: dragging the
 * terminal's (or the agents rail's) handle inward takes the editor column down
 * to its 5% floor while the bar keeps its ~450px of controls. Neither dock
 * exists on the web host these tests run against — the terminal needs a pty —
 * so the window is the lever that reaches the same geometry. It is the same
 * lever either way: every assertion here is a function of the pane's own
 * width, never of what occupies the space beyond it.
 *
 * TWO of the cap's three consumers are covered here, and the omission is a
 * reachability limit rather than an oversight: at `MIN_VIEWPORT_WIDTH_PX` the
 * pane bottoms out around 300px, which is still wider than a lint callout, so
 * that surface has no overhang for an arm to contain. Its cap is pinned at the
 * producer tier in `editor-visible-region.dom.test.tsx` instead. Give the
 * window lever more room — a real dock, or a host that lays out narrower — and
 * an arm for it belongs here beside these.
 */

/**
 * Shrink the window until the editor pane is about `targetPaneWidthPx` wide.
 *
 * Derives the window width from the CURRENT chrome rather than hardcoding one,
 * so a sidebar or gutter change moves the window instead of quietly widening
 * the pane back out of the regime under test — the failure mode that turns a
 * containment test into a tautology. `expectPaneNarrowerThan` is the assertion
 * that catches it if a responsive breakpoint defeats this anyway.
 */
async function narrowPaneTo(page: Page, targetPaneWidthPx: number): Promise<void> {
  const initial = page.viewportSize();
  if (!initial) throw new Error('narrowPaneTo: no viewport to resize');
  // Converge instead of solving for the window once. The chrome beside the
  // pane is not a constant: the sidebar collapses to an icon rail below its
  // own breakpoint and HANDS ITS WIDTH BACK to the editor, so a single
  // `window = chrome + target` lands the pane wider than it started. Each
  // round re-measures the chrome the app actually has at that width.
  for (let round = 0; round < 6; round += 1) {
    const paneWidth = await readPaneWidth(page);
    // Sub-pixel slack: the window is set in whole pixels, so the pane lands a
    // fraction wide of an exactly-computed target and an exact comparison
    // never terminates.
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

/**
 * Wait until the pane's width stops moving.
 *
 * Stability rather than "it changed": the pane is a `react-resizable-panels`
 * member whose relayout is driven by a ResizeObserver on the group, so it
 * still reads the pre-resize width for several frames — but a round that
 * lands on the width it already had is a legitimate convergence, and a
 * must-have-changed predicate would fail there instead of finishing.
 */
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

/**
 * Floor for the converging resize — the narrowest viewport the app is expected
 * to lay out in. A pane that still will not shrink at this width is a layout
 * finding rather than a test that needs a smaller window, so the loop reports
 * it instead of shrinking further.
 *
 * It is also the ceiling on how narrow a pane these tests can construct, which
 * is why the group covers the bar and the comment composer but not the lint
 * callout: at this floor the pane is still wider than a callout, so there is
 * no overhang to contain. The callout's cap is pinned at the producer tier in
 * `editor-visible-region.dom.test.tsx` instead.
 */
const MIN_VIEWPORT_WIDTH_PX = 320;

/**
 * Narrow the pane as far as the app's own layout allows.
 *
 * The narrow-pane arms want the widest overhang they can get, and the floor
 * is the app's, not a number this file should guess: `narrowPaneTo` converges
 * against whatever chrome the layout keeps at each width and stops at
 * `MIN_VIEWPORT_WIDTH_PX`. Asking for zero and swallowing the resulting
 * "could not reach it" is how we ask for that floor without restating it.
 * `expectPaneNarrowerThan` is what then proves the floor was low enough for
 * the surface under test.
 */
async function narrowPaneAsFarAsPossible(page: Page): Promise<void> {
  await narrowPaneTo(page, 0).catch(() => {});
}

/**
 * How far below the scroll container's top the selection is parked once the
 * pane has been narrowed.
 *
 * Narrowing reflows the prose, so the selected block ends up somewhere else —
 * often below the region's floor, where `hide()` correctly blanks the bar and
 * the containment assertion would pass on nothing. A plain
 * `scrollIntoView()` is not enough either: it settles the block against the
 * nearest edge, which is under the Ask AI composer's band. This inset clears
 * the toolbar band at the top and the composer band at the bottom by more
 * than a bar height on a 720px-tall window.
 */
const SELECTION_MID_PANE_INSET_PX = 200;

/** Width of the painted editor scroll container. */
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

/**
 * Assert the pane really is too narrow to host the surface at its natural
 * width. Without this the containment assertions pass on a pane that never
 * squeezed anything, and the whole group goes quietly green the day the
 * surface loses a control or the chrome gains one.
 */
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

/** The surface's width with no pane cap biting — measured, never assumed. */
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
  // Re-anchor: narrowing reflows the prose, so the block the selection lives
  // in leaves the visible region, at which point `hide()` fires and the
  // containment assertion passes vacuously on an invisible bar.
  await parkSelectionTopAtPaneInset(page, SELECTION_MID_PANE_INSET_PX);
  await waitForSurfaceSettled(page, BUBBLE_BAR);

  const geometry = await readSurfaceGeometry(page, BUBBLE_BAR);
  expect(geometry.present, 'bubble bar still mounted').toBe(true);
  expectPaneNarrowerThan(geometry, naturalWidth, 'bubble bar');
  await expectAnchorInsideRegionHorizontally(page, geometry);
  expectInsideVisibleRegionHorizontally(geometry, 'bubble bar (narrow pane)');
  // The cap buys width with HEIGHT: the bar only fits because it wraps to a
  // second row. That makes the vertical arm part of this contract rather than
  // a duplicate of the tests above — a wrapped bar tall enough to clear the
  // region would be the cap's own regression.
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

  // The plugin fixes `size` after `shift` in an array we cannot reorder, so
  // this arm is what proves the cap is stated on BOTH writers rather than
  // inherited from whichever one happened to run last.
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
  // `expectInsideVisibleRegionHorizontally` short-circuits on an unpainted
  // surface, so without this the arm would pass vacuously the day the card
  // stops rendering here rather than reporting that it had escaped.
  expect(geometry.visible, 'composer must be on screen for containment to bite').toBe(true);
  expectPaneNarrowerThan(geometry, naturalWidth, 'comment composer');
  expectInsideVisibleRegionHorizontally(geometry, 'comment composer (narrow pane)');
  expectInsideVisibleRegion(geometry, 'comment composer (narrow pane)');
});

/**
 * The same contract at the two remaining editor-anchored floating surfaces:
 * the suggestion picker (slash / wiki-link / tag) and the markdown-lint hover
 * callout. Both are body-appended, `position: fixed`, and anchored to a
 * virtual element built from a position inside the scrolled content, so
 * nothing in the DOM clips them either.
 *
 * They are anchored to a CARET or a text LINE rather than to a whole
 * selection, so they cannot reach the tall-reference amplifier the cases above
 * turn on: `hide()` is never the arm under test and the vertical escape has to
 * be constructed differently. What they share with the bar and the card is the
 * absent boundary — `shift()` clamps against the clipping ancestors, which is
 * the window, not the pane — and that is axis-independent. A ~490 px picker
 * opened past the middle of the prose column, or a callout hovered near the
 * column's right edge, leaves the pane sideways and lands on whatever occupies
 * the rail beside it.
 */

const SLASH_PICKER = '[data-suggestion-popup="slash-command"]';
const SUGGESTION_POPUP = SLASH_PICKER;
const LINT_CALLOUT = '.ok-lint-tooltip';

/**
 * The picker's own ceiling on its height (`size()`'s `40vh` cap). Used as the
 * precondition's yardstick rather than the picker's measured height, which the
 * fix is free to shrink: a caret with less than this much room on either side
 * of it cannot host a full-size picker whatever the chain does, so the surface
 * must be clamped, shrunk, or escaping.
 */
const SUGGESTION_MAX_HEIGHT_FRACTION = 0.4;

/** Scroll the pane until the caret's top edge rests at viewport `y`. */
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

/**
 * Put the caret inside the block carrying `marker`, as far right as it can go
 * while still resting at least `insetPx` inside the pane's right edge.
 *
 * The picker is `*-start`-placed, so its unclamped left edge IS the caret's x:
 * a caret in the right half of the prose column is the whole trigger, and the
 * inset keeps the ANCHOR unambiguously inside the pane so anything that spills
 * past the edge does so on the picker's own account.
 */
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
      // The marker is its own short text node at the block's head, so scanning
      // it alone would never reach the right half of the column. Widen to the
      // whole top-level block the marker sits in.
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

/**
 * Type the suggestion trigger and wait for the picker to settle.
 *
 * The leading space is load-bearing: the plugin's `allowedPrefixes` accepts the
 * trigger only after whitespace or at a block start, so a bare `/` typed
 * mid-word never opens anything and the test would fail on setup.
 */
async function openSuggestionPicker(page: Page): Promise<void> {
  await openPicker(page, SLASH_PICKER);
}

/**
 * Every picker that rides the shared middleware, with the characters that
 * summon it. Parameterised rather than one arm for the slash menu, because the
 * three do NOT degrade alike: the slash menu's columns are flex items that
 * shrink under the cap on their own, while the other two render a block root
 * carrying a fixed `width`, which a `max-width` on the portaled wrapper cannot
 * shrink. A group that only exercised the flex shape would go green while the
 * other two kept overhanging.
 */
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

/**
 * The widest box the picker actually PAINTS — the wrapper unioned with every
 * descendant.
 *
 * `readFloatingSurfaceGeometry` reads the wrapper's own border box, and a
 * child is free to overflow it: a block menu root with `width: 20rem` inside a
 * wrapper capped at 287px leaves the wrapper at 287 and paints 320. Measuring
 * the wrapper alone therefore reports containment for a picker the user can
 * plainly see lying across the dock, which is the exact hole that let a cap
 * inert on two of the three pickers look pinned.
 */
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

/** The caret's rect, read the way the picker's virtual element reads it. */
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
  // Bring the block on screen before measuring anything in it: a chunk the
  // scrollport has never reached is content-visibility-skipped, and
  // `coordsAtPos` inside one reports the placeholder's geometry.
  await selectSingleMarker(page, blockMarker(40));
  const region = await readFloatingSurfaceGeometry(page, SUGGESTION_POPUP);
  // High in the pane, so there is ample room below the caret and the vertical
  // arm cannot confound this one.
  await parkCaretAtViewportY(page, region.regionTop + 40);
  // Short of the line's end: the trigger characters reflow the text, and a
  // caret parked at the wrap point would ride the pushed word onto the next
  // line and lose the right-hand anchor this case is about.
  await placeCaretNearPaneRight(page, blockMarker(40), 200);
  await openSuggestionPicker(page);

  const geometry = await readFloatingSurfaceGeometry(page, SUGGESTION_POPUP);
  expect(geometry.present, 'suggestion picker still mounted').toBe(true);
  expect(geometry.visible, 'suggestion picker must be on screen for containment to be tested').toBe(
    true,
  );

  // The clamp is under test only if the unclamped placement would overhang.
  // A `*-start` picker's unclamped left edge is the caret's own x, so its
  // right edge is that plus the picker's width.
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
      // Both columns up in a roomy pane. Asserted so the narrow-pane check
      // below pins a TOGGLE rather than an absence that a never-rendered
      // preview would satisfy just as well. Only the slash menu has one.
      expect(await previewColumnCount(page), 'preview column up in a roomy pane').toBe(1);
    }

    await narrowPaneAsFarAsPossible(page);
    // The trigger characters and the caret do not survive the reflow the
    // resize causes, so the picker is re-opened against the narrowed pane
    // rather than measured where it was.
    const region = await readFloatingSurfaceGeometry(page, picker.selector);
    await parkCaretAtViewportY(page, region.regionTop + 40);
    await openPicker(page, picker.selector, picker.trigger);

    const geometry = await readFloatingSurfaceGeometry(page, picker.selector);
    expect(geometry.present, `${picker.label} picker still mounted`).toBe(true);
    expect(geometry.visible, `${picker.label} picker must be on screen to bite`).toBe(true);
    // Reachability from the two MEASURED numbers rather than a table of
    // expected widths: `narrowPaneTo` bottoms out at whatever chrome the host
    // keeps beside the pane, and a picker narrower than that floor has no
    // overhang for this arm to contain however narrow the window goes — the
    // same limit that keeps the lint callout out of the group above. Skipping
    // says so with both numbers instead of passing on nothing, and a picker
    // that grows past the floor starts being covered with no edit here.
    const paneWidth = geometry.regionRight - geometry.regionLeft;
    test.skip(
      naturalWidth <= paneWidth,
      `${picker.label} picker is ${naturalWidth}px, which already fits the narrowest pane ` +
        `this host lays out (${paneWidth}px) — no overhang to contain`,
    );
    expectPaneNarrowerThan(geometry, naturalWidth, `${picker.label} picker`);

    // The PAINTED box, not the wrapper's: a menu root carrying a fixed `width`
    // leaves the wrapper at the cap and paints past it, which the wrapper's
    // own rect reports as contained.
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
      // Containment alone would also be satisfied by squeezing both columns
      // into the pane, which is what the one-column rule exists to avoid.
      expect(await previewColumnCount(page), 'preview column dropped in a narrow pane').toBe(0);
    }
  });
}

/** Painted preview columns inside the suggestion picker — 0 once it goes one-column. */
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
  // A picker shrunk to nothing would satisfy containment for the wrong reason.
  expect(
    geometry.bottom - geometry.top,
    'suggestion picker must keep a usable height',
  ).toBeGreaterThan(60);

  // Neither side of the caret has room for a full-height picker, so whatever
  // the chain does it cannot simply place one and walk away. Stated against
  // `size()`'s own ceiling rather than the picker's measured height, which a
  // fix is free to shrink.
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

/**
 * The markdown-lint hover callout. Opt-in per project, so these enable the
 * plugin for the worker's content dir and hand it back afterwards — the same
 * arrangement `markdown-lint.e2e.ts` uses, and the reason they sit in their own
 * describe at the end of the file rather than beside the cases above.
 */
test.describe('markdown-lint hover callout', () => {
  // A hard tab mid-sentence trips MD010 without turning the line into an
  // indented code block, and the paragraph is long enough to wrap so a pointer
  // can rest near either the left or the right edge of the prose column.
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
    // Plain paragraphs, deliberately not `1.`-prefixed: an ordered list is ONE
    // top-level block, so every violation in the document would collapse into a
    // single decoration whose callout lists all sixty.
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

  /**
   * The painted lint block nearest `targetTop`, after scrolling one into place.
   * Returns its box so the caller can aim the pointer at a known line.
   */
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

  /**
   * Hold until the scrollport stops moving on its own.
   *
   * Chromium answers a programmatic `scrollTop` write with a scroll correction
   * of its own a frame or two later. Hovering before that lands moves the text
   * out from under a stationary pointer, which reads as a pointer-leave and
   * retires the callout ~140 ms into the measurement — the callout is raised,
   * then silently gone by the time its geometry is read.
   */
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

  /** Rest the pointer on a lint block and wait for its callout to settle. */
  async function hoverLintBlock(page: Page, x: number, y: number): Promise<void> {
    await page.mouse.move(x, y);
    await expect(page.locator(`${LINT_CALLOUT}:visible`)).not.toHaveCount(0);
    // The callout is appended at 0,0 and moved by an async `computePosition`,
    // so a settle poll alone could sample that initial coordinate twice.
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
    // The callout is `top-start`-placed, so it escapes only if the hovered line
    // has less clearance above it than the callout is tall.
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
    // The callout anchors to the pointer's x and is `*-start`-placed, so its
    // unclamped left edge is that x.
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
