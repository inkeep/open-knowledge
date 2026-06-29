import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from 'prosemirror-state';

const TOOLBAR_HEIGHT = 56;

const FROZEN_SHADOW = '0 2px 4px rgba(0, 0, 0, 0.08)';

const DRIFT_RECOMPUTE_MS = 150;

interface ScrollTimelineOptions {
  source: Element | null;
  axis?: 'block' | 'inline' | 'x' | 'y';
}
type ScrollTimelineConstructor = new (options: ScrollTimelineOptions) => AnimationTimeline;

const ScrollTimelineImpl = (globalThis as { ScrollTimeline?: ScrollTimelineConstructor })
  .ScrollTimeline;

interface ScrollDrivenAnimationOptions extends KeyframeAnimationOptions {
  timeline?: AnimationTimeline | null;
}

export interface FreezeRange {
  startOffset: number;
  endOffset: number;
  maxShift: number;
}

export function computeFreezeRange(
  scrollTop: number,
  containerTop: number,
  tableTop: number,
  tableHeight: number,
  headerHeight: number,
): FreezeRange | null {
  const maxShift = tableHeight - headerHeight;
  if (maxShift <= 0) return null;
  const startOffset = scrollTop + tableTop - (containerTop + TOOLBAR_HEIGHT);
  return { startOffset, endOffset: startOffset + maxShift, maxShift };
}

interface AppliedFreeze {
  key: string;
  animations: Animation[];
}

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

const cellZIndex = (cell: HTMLTableCellElement): string => (cell.cellIndex === 0 ? '3' : '2');

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
      if (scrollMax <= 0) {
        resetHeaderCells(firstRow);
        continue;
      }
      for (const cell of Array.from(firstRow.cells) as HTMLTableCellElement[]) {
        applyScrollDrivenFreeze(cell, timeline, range, scrollMax);
      }
      continue;
    }

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

          function wireChunkVisibility(wrapper: HTMLElement): void {
            if (cvWired.has(wrapper)) return;
            cvWired.add(wrapper);
            wrapper.addEventListener('contentvisibilityautostatechange', scheduleRun);
          }

          const onScroll = (): void => {
            if (timeline) {
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
                timeline = null;
              }
            }
            scrollEl?.addEventListener('scroll', onScroll, { passive: true });
            if (scrollEl && typeof ResizeObserver !== 'undefined') {
              resizeObserver = new ResizeObserver(scheduleRun);
              resizeObserver.observe(scrollEl);
              resizeObserver.observe(editorView.dom as HTMLElement);
            }
            run();
          });

          return {
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
