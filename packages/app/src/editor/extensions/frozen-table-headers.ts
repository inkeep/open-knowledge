/**
 * FrozenTableHeaders — keeps the first row (column headers) visible when
 * scrolling past them vertically, and freezes the first column with CSS sticky
 * for horizontal scrolling.
 *
 * **Why JS transform instead of CSS `position: sticky; top`:**
 * `.tableWrapper` has `overflow-x: auto`, which coerces `overflow-y` to `auto`
 * as well (CSS scroll container rules). This makes `.tableWrapper` the containing
 * block for `position: sticky`, preventing sticky cells from reaching the outer
 * `ScrollPreservingContainer`. A scroll-driven `translateY` is the only approach
 * that doesn't require restructuring the table DOM.
 *
 * **Why scroll-driven Web Animations (ScrollTimeline) instead of per-scroll JS:**
 * Two reasons, both load-bearing:
 *  1. Scroll events reach the main thread after the compositor has already
 *     painted the scrolled frame, so a scroll-listener + rAF implementation
 *     trails the scroll by a frame or more — the header visibly shakes. A
 *     scroll-driven animation is advanced by the compositor in the same frame
 *     as the scroll, so the header tracks pixel-for-pixel. The required shift
 *     is linear in scrollTop with clamping at both ends — exactly an animation
 *     with px ranges, `easing: linear`, and `fill: both`.
 *  2. It removes all per-scroll-frame JS. Geometry reads (`getBoundingClientRect`)
 *     force layout of `content-visibility: auto` chunks (`.ok-chunk-wrapper`,
 *     see chunk-wrapper-decoration.ts), so reading every table's rect on every
 *     scroll frame would defeat that virtualization. Ranges are recomputed only
 *     on PM transactions, scroller resize, chunk visibility flips, and a
 *     trailing scroll throttle for drift (skipped chunks above a table are
 *     sized by `contain-intrinsic-size` estimates, so the table's document
 *     offset can shift as chunks materialize).
 *
 * **Why Web Animations and never `cell.style.transform = ...`:**
 * Header cells are ProseMirror-managed DOM. PM's DOMObserver watches the whole
 * editor subtree with `attributes: true`, and a plain `<th>` view desc does not
 * ignore attribute mutations (`ViewDesc.ignoreMutation` returns false for nodes
 * with a contentDOM). Inline `style` writes trigger DOM-change read-backs; under
 * concurrent transactions (e.g. the CRDT bridge settling) the write → observe →
 * reparse → re-render → re-apply cycle becomes a microtask loop that starves
 * rAF and wedges the renderer. Animations change computed style WITHOUT touching
 * any DOM attribute, so the observer never fires.
 *
 * The transform animation carries ONLY `transform`: mixing non-composited
 * properties into the same animation demotes the whole animation to the main
 * thread, which would reintroduce the shake. z-index + shadow ride a second,
 * main-thread animation that flips within 1px of scroll at the freeze boundary.
 *
 * Browsers without `ScrollTimeline` fall back to the scroll-listener + rAF
 * path applying instant fill-forwards animations (correct, mildly laggy).
 *
 * First-column freeze is pure CSS — `.tableWrapper` IS the horizontal scroll
 * container, so `position: sticky; left: 0` works natively on first-column
 * cells. See `globals.css` for those rules.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from 'prosemirror-state';

// EditorToolbar is absolutely positioned at the top of the scroll container,
// 3.5rem tall. Frozen headers must clear it. One of the four load-bearing
// toolbar-height constants listed in components/EditorActivityPool.tsx —
// move them together.
const TOOLBAR_HEIGHT = 56;

// Subtle shadow to indicate the frozen row overlaps the table body.
const FROZEN_SHADOW = '0 2px 4px rgba(0, 0, 0, 0.08)';

// Trailing throttle for drift recompute while scrolling (scroll-driven mode).
const DRIFT_RECOMPUTE_MS = 150;

interface ScrollTimelineOptions {
  source: Element | null;
  axis?: 'block' | 'inline' | 'x' | 'y';
}
type ScrollTimelineConstructor = new (options: ScrollTimelineOptions) => AnimationTimeline;

// Not yet in lib.dom; present in Chromium >= 115 (Electron is well past).
const ScrollTimelineImpl = (globalThis as { ScrollTimeline?: ScrollTimelineConstructor })
  .ScrollTimeline;

interface ScrollDrivenAnimationOptions extends KeyframeAnimationOptions {
  timeline?: AnimationTimeline | null;
}

export interface FreezeRange {
  /** Scroll offset at which the header starts translating (shift 0). */
  startOffset: number;
  /** Scroll offset at which the header reaches maxShift (pinned at last row). */
  endOffset: number;
  /** Greatest translation: table height minus header height. */
  maxShift: number;
}

/**
 * Scroll offsets between which the header translates linearly from 0 to
 * maxShift: shift(scrollTop) = clamp(scrollTop - startOffset, 0, maxShift).
 * Inputs are viewport-space rect tops measured at `scrollTop`. Returns null
 * when the table cannot freeze (the header is the whole table).
 */
export function computeFreezeRange(
  scrollTop: number,
  containerTop: number,
  tableTop: number,
  tableHeight: number,
  headerHeight: number,
): FreezeRange | null {
  const maxShift = tableHeight - headerHeight;
  if (maxShift <= 0) return null;
  // The scroll offset at which the table's top crosses the toolbar boundary.
  const startOffset = scrollTop + tableTop - (containerTop + TOOLBAR_HEIGHT);
  return { startOffset, endOffset: startOffset + maxShift, maxShift };
}

interface AppliedFreeze {
  key: string;
  animations: Animation[];
}

// Last applied effect per cell. WeakMap so cells dropped by a PM re-render
// release their entries — replacements start clean and get fresh animations
// on the next pass.
const appliedFreezes = new WeakMap<HTMLTableCellElement, AppliedFreeze>();

function cancelFreeze(cell: HTMLTableCellElement): void {
  const prev = appliedFreezes.get(cell);
  if (!prev) return;
  for (const animation of prev.animations) animation.cancel();
  appliedFreezes.delete(cell);
}

function resetHeaderCells(firstRow: HTMLTableRowElement): void {
  for (const cell of Array.from(firstRow.cells)) {
    cancelFreeze(cell);
  }
}

// Corner cell (first col + header row) must sit above both the sticky column
// layer (z:1) and other frozen header cells (z:2). z-index applies because
// cells are position: relative (sticky for the first column) in static CSS.
const cellZIndex = (cell: HTMLTableCellElement): string => (cell.cellIndex === 0 ? '3' : '2');

/**
 * Keyframes mapping timeline progress (scrollTop / scrollMax) onto
 * shift(scrollTop) = clamp(scrollTop - startOffset, 0, maxShift). The function
 * is piecewise linear with breakpoints only at the freeze window's edges, so
 * keyframes at {0, start, end, 1} with linear easing reproduce it exactly.
 * Keyframe offsets are used instead of animation ranges (rangeStart/rangeEnd):
 * range options in animate() are a newer surface that engines without support
 * silently drop (WebIDL ignores unknown dictionary members), which would leave
 * the animation spanning the whole scroll range — keyframe offsets are
 * bedrock WAAPI semantics everywhere ScrollTimeline exists.
 */
export function buildShiftKeyframes(range: FreezeRange, scrollMax: number): Keyframe[] {
  return buildFreezeKeyframes(range, scrollMax, (shift) => ({
    transform: `translateY(${shift}px)`,
  }));
}

function buildFreezeKeyframes(
  range: FreezeRange,
  scrollMax: number,
  toProps: (shiftPx: number) => Omit<Keyframe, 'offset'>,
): Keyframe[] {
  // Callers guard, but a direct call with no scroll range must not produce
  // NaN offsets — no scrolling means no freeze.
  if (!(scrollMax > 0)) {
    return [
      { offset: 0, ...toProps(0) },
      { offset: 1, ...toProps(0) },
    ];
  }
  const shiftAt = (scroll: number): number =>
    Math.max(0, Math.min(scroll - range.startOffset, range.maxShift));
  const breakpoints = Array.from(
    new Set(
      [0, range.startOffset / scrollMax, range.endOffset / scrollMax, 1].map((o) =>
        Math.max(0, Math.min(o, 1)),
      ),
    ),
  ).sort((a, b) => a - b);
  return breakpoints.map((offset) => ({
    offset,
    ...toProps(shiftAt(offset * scrollMax)),
  }));
}

/** Keyframes that flip between two constant states within 1px of scroll at
 *  the freeze boundary. Constant on both sides, so main-thread updating of
 *  these (non-composited) properties cannot lag visibly during scroll. */
function buildBoundaryFlipKeyframes(
  range: FreezeRange,
  scrollMax: number,
  pre: Omit<Keyframe, 'offset'>,
  post: Omit<Keyframe, 'offset'>,
): Keyframe[] {
  if (!(scrollMax > 0)) {
    return [
      { ...pre, offset: 0 },
      { ...pre, offset: 1 },
    ];
  }
  const flip = range.startOffset / scrollMax;
  if (flip <= 0)
    return [
      { ...post, offset: 0 },
      { ...post, offset: 1 },
    ];
  if (flip >= 1)
    return [
      { ...pre, offset: 0 },
      { ...pre, offset: 1 },
    ];
  const flipEnd = Math.min(flip + 1 / scrollMax, 1);
  return [
    { ...pre, offset: 0 },
    { ...pre, offset: flip },
    { ...post, offset: flipEnd },
    { ...post, offset: 1 },
  ];
}

/** Frozen chrome: z-index + shadow on the cell itself. */
function buildChromeKeyframes(range: FreezeRange, scrollMax: number, zIndex: string): Keyframe[] {
  return buildBoundaryFlipKeyframes(
    range,
    scrollMax,
    { zIndex: 'auto', boxShadow: 'none' },
    { zIndex, boxShadow: FROZEN_SHADOW },
  );
}

/** Occluder reveal: the static ::before block above each header cell (see
 *  globals.css) becomes opaque while frozen. It is painted into the cell's
 *  composited layer, so it tracks the transform pixel-for-pixel — unlike a
 *  scroll-driven clip-path on the wrapper, which updates off the compositor
 *  and can trail (or, across rebuild cycles, desync from) the header. */
function buildOccluderKeyframes(range: FreezeRange, scrollMax: number): Keyframe[] {
  return buildBoundaryFlipKeyframes(range, scrollMax, { opacity: '0' }, { opacity: '1' });
}

/** Scroll-driven path: the compositor maps scroll offset → translateY. */
function applyScrollDrivenFreeze(
  cell: HTMLTableCellElement,
  timeline: AnimationTimeline,
  range: FreezeRange,
  scrollMax: number,
): void {
  const zIndex = cellZIndex(cell);
  const key = `sd|${range.startOffset}|${range.maxShift}|${scrollMax}|${zIndex}`;
  const prev = appliedFreezes.get(cell);
  if (prev?.key === key) return;
  if (prev) for (const animation of prev.animations) animation.cancel();

  const base: ScrollDrivenAnimationOptions = { timeline, fill: 'both', easing: 'linear' };
  // Transform-only so the animation stays compositor-eligible (mixing
  // non-composited properties demotes the whole animation to the main thread).
  const transformAnimation = cell.animate(buildShiftKeyframes(range, scrollMax), base);
  const chromeAnimation = cell.animate(buildChromeKeyframes(range, scrollMax, zIndex), base);
  const occluderAnimation = cell.animate(buildOccluderKeyframes(range, scrollMax), {
    ...base,
    pseudoElement: '::before',
  });
  appliedFreezes.set(cell, {
    key,
    animations: [transformAnimation, chromeAnimation, occluderAnimation],
  });
}

/** Fallback path (no ScrollTimeline): instant effect at the current shift. */
function applyInstantFreeze(cell: HTMLTableCellElement, shift: number): void {
  const zIndex = cellZIndex(cell);
  const key = `in|${shift}|${zIndex}`;
  const prev = appliedFreezes.get(cell);
  if (prev?.key === key) return;
  if (prev) for (const animation of prev.animations) animation.cancel();
  const animation = cell.animate(
    [{ transform: `translateY(${shift}px)`, zIndex, boxShadow: FROZEN_SHADOW }],
    { duration: 0, fill: 'forwards' },
  );
  const occluderAnimation = cell.animate([{ opacity: '1' }], {
    duration: 0,
    fill: 'forwards',
    pseudoElement: '::before',
  });
  appliedFreezes.set(cell, { key, animations: [animation, occluderAnimation] });
}

function computeAndApplyFrozenHeaders(
  scrollEl: HTMLElement,
  editorDom: HTMLElement,
  timeline: AnimationTimeline | null,
  onTableWrapper?: (wrapper: HTMLElement) => void,
): void {
  const containerTop = scrollEl.getBoundingClientRect().top;
  const scrollTop = scrollEl.scrollTop;
  const scrollMax = scrollEl.scrollHeight - scrollEl.clientHeight;
  const wrappers = editorDom.querySelectorAll<HTMLElement>('.tableWrapper');
  for (const wrapper of wrappers) {
    onTableWrapper?.(wrapper);
    const table = wrapper.querySelector('table');
    if (!table) continue;
    const firstRow = table.querySelector('tbody')?.rows[0];
    if (!firstRow || !Array.from(firstRow.cells).some((c) => c.tagName === 'TH')) {
      continue;
    }

    // Row/table rects are unaffected by the cells' own transforms
    // (getBoundingClientRect excludes descendant transforms), so these
    // measurements stay stable while the freeze is applied.
    const tableRect = table.getBoundingClientRect();
    const headerRect = firstRow.getBoundingClientRect();
    const range = computeFreezeRange(
      scrollTop,
      containerTop,
      tableRect.top,
      tableRect.height,
      headerRect.height,
    );

    if (!range) {
      resetHeaderCells(firstRow);
      continue;
    }

    if (timeline) {
      // No scrollable overflow → nothing can ever freeze.
      if (scrollMax <= 0) {
        resetHeaderCells(firstRow);
        continue;
      }
      for (const cell of Array.from(firstRow.cells) as HTMLTableCellElement[]) {
        applyScrollDrivenFreeze(cell, timeline, range, scrollMax);
      }
      continue;
    }

    // Fallback: compute the instantaneous shift and apply it directly.
    const shift = Math.max(0, Math.min(scrollTop - range.startOffset, range.maxShift));
    if (shift <= 0 || tableRect.bottom <= containerTop + TOOLBAR_HEIGHT) {
      resetHeaderCells(firstRow);
      continue;
    }
    for (const cell of Array.from(firstRow.cells) as HTMLTableCellElement[]) {
      applyInstantFreeze(cell, shift);
    }
  }
}

export const FrozenTableHeaders = Extension.create({
  name: 'frozenTableHeaders',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('frozenTableHeaders'),

        view(editorView) {
          let scrollEl: HTMLElement | null = null;
          let timeline: AnimationTimeline | null = null;
          let rafId: number | null = null;
          let driftTimer: ReturnType<typeof setTimeout> | null = null;
          let resizeObserver: ResizeObserver | null = null;
          let destroyed = false;
          // Wrappers whose chunk-visibility flips we listen to. Iterable so
          // destroy() can detach the listeners; PM node replacement drops a
          // wrapper anyway and the replacement is re-wired on the next pass.
          const cvWired = new Set<HTMLElement>();

          const run = (): void => {
            if (destroyed || !scrollEl) return;
            computeAndApplyFrozenHeaders(
              scrollEl,
              editorView.dom as HTMLElement,
              timeline,
              wireChunkVisibility,
            );
          };

          const scheduleRun = (): void => {
            if (rafId != null) return;
            rafId = requestAnimationFrame(() => {
              rafId = null;
              run();
            });
          };

          // Skipped chunks above a table are sized by contain-intrinsic-size
          // estimates; when one materializes at its real size, every table
          // below shifts — recompute the ranges.
          function wireChunkVisibility(wrapper: HTMLElement): void {
            if (cvWired.has(wrapper)) return;
            cvWired.add(wrapper);
            wrapper.addEventListener('contentvisibilityautostatechange', scheduleRun);
          }

          const onScroll = (): void => {
            if (timeline) {
              // The compositor owns per-frame movement; recomputes here are
              // only drift correction (chunk materialization or async layout
              // can shift table offsets and the scroll range). Leading edge:
              // refresh once at the start of a scroll burst; trailing edge:
              // refresh after it settles.
              if (driftTimer == null) scheduleRun();
              if (driftTimer != null) clearTimeout(driftTimer);
              driftTimer = setTimeout(() => {
                driftTimer = null;
                run();
              }, DRIFT_RECOMPUTE_MS);
              return;
            }
            scheduleRun();
          };

          // Defer scroll-container lookup to after PM has mounted into the DOM.
          requestAnimationFrame(() => {
            if (destroyed) return;
            scrollEl = (editorView.dom as HTMLElement).closest<HTMLElement>(
              '[data-testid="editor-scroll-container"]',
            );
            if (!scrollEl && import.meta.env.DEV) {
              console.warn(
                '[frozen-table-headers] editor-scroll-container not found; table headers will not freeze',
              );
            }
            if (scrollEl && ScrollTimelineImpl) {
              try {
                timeline = new ScrollTimelineImpl({ source: scrollEl, axis: 'block' });
              } catch {
                // Partial implementation — the scroll-listener fallback below
                // still produces correct (if lagging) behavior.
                timeline = null;
              }
            }
            scrollEl?.addEventListener('scroll', onScroll, { passive: true });
            if (scrollEl && typeof ResizeObserver !== 'undefined') {
              resizeObserver = new ResizeObserver(scheduleRun);
              // The scroller's box (viewport resizes, sidebar toggles) AND the
              // content (.ProseMirror): chunk materialization and async layout
              // (fonts, images) grow the content height without any PM
              // transaction, which would otherwise leave the animation ranges
              // built against a stale scroll range.
              resizeObserver.observe(scrollEl);
              resizeObserver.observe(editorView.dom as HTMLElement);
            }
            run();
          });

          return {
            // Content edits can change table heights and document offsets;
            // selection-only transactions cannot, and the rect reads in run()
            // force layout (including of skipped content-visibility chunks),
            // so guard on actual doc changes — same pattern as
            // table-insert-controls.ts.
            update(view, prevState) {
              if (prevState.doc.eq(view.state.doc)) return;
              run();
            },
            destroy() {
              destroyed = true;
              scrollEl?.removeEventListener('scroll', onScroll);
              resizeObserver?.disconnect();
              if (rafId != null) cancelAnimationFrame(rafId);
              if (driftTimer != null) clearTimeout(driftTimer);
              for (const wrapper of cvWired) {
                wrapper.removeEventListener('contentvisibilityautostatechange', scheduleRun);
              }
              cvWired.clear();
              // Cancel lingering fill animations so a recycled DOM subtree
              // doesn't keep stale transforms or a revealed occluder.
              for (const row of (
                editorView.dom as HTMLElement
              ).querySelectorAll<HTMLTableRowElement>(
                '.tableWrapper > table > tbody > tr:first-child',
              )) {
                resetHeaderCells(row);
              }
            },
          };
        },
      }),
    ];
  },
});
