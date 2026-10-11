import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { EDITOR_TOOLBAR_HEIGHT, editorToolbarOverlapPx } from '@/lib/editor-toolbar-overlap';

export const TOOLBAR_HEIGHT = EDITOR_TOOLBAR_HEIGHT;

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
  const startOffset = scrollTop + tableTop - (containerTop + editorToolbarOverlapPx());
  return { startOffset, endOffset: startOffset + maxShift, maxShift };
}

interface AppliedFreeze {
  key: string;
  animations: Animation[];
}

const appliedFreezes = new WeakMap<HTMLTableCellElement, AppliedFreeze>();

const skippedChunks = new WeakSet<Element>();

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

function buildChromeKeyframes(range: FreezeRange, scrollMax: number): Keyframe[] {
  return buildBoundaryFlipKeyframes(
    range,
    scrollMax,
    { boxShadow: 'none' },
    { boxShadow: FROZEN_SHADOW },
  );
}

function buildOccluderKeyframes(range: FreezeRange, scrollMax: number): Keyframe[] {
  return buildBoundaryFlipKeyframes(range, scrollMax, { opacity: '0' }, { opacity: '1' });
}

export function applyScrollDrivenFreeze(
  cell: HTMLTableCellElement,
  timeline: AnimationTimeline,
  range: FreezeRange,
  scrollMax: number,
): void {
  const key = `sd|${range.startOffset}|${range.maxShift}|${scrollMax}`;
  const prev = appliedFreezes.get(cell);
  if (prev?.key === key) return;
  if (prev) for (const animation of prev.animations) animation.cancel();

  const base: ScrollDrivenAnimationOptions = { timeline, fill: 'both', easing: 'linear' };
  const transformAnimation = cell.animate(buildShiftKeyframes(range, scrollMax), base);
  const chromeAnimation = cell.animate(buildChromeKeyframes(range, scrollMax), base);
  const occluderAnimation = cell.animate(buildOccluderKeyframes(range, scrollMax), {
    ...base,
    pseudoElement: '::before',
  });
  const animations = [transformAnimation, chromeAnimation, occluderAnimation];
  for (const animation of animations) anchorScrollDrivenStartTime(animation);
  appliedFreezes.set(cell, { key, animations });
}

let scrollDrivenStartTimeRejectionWarned = false;

export function anchorScrollDrivenStartTime(animation: Animation): void {
  try {
    animation.startTime = CSS.percent(0);
  } catch (error) {
    if (import.meta.env.DEV && !scrollDrivenStartTimeRejectionWarned) {
      scrollDrivenStartTimeRejectionWarned = true;
      console.warn(
        '[frozen-table-headers] scroll-driven startTime assignment rejected; frozen headers will drop one frame on every freeze recompute in this browser',
        error,
      );
    }
  }
}

function applyInstantFreeze(cell: HTMLTableCellElement, shift: number): void {
  const key = `in|${shift}`;
  const prev = appliedFreezes.get(cell);
  if (prev?.key === key) return;
  if (prev) for (const animation of prev.animations) animation.cancel();
  const animation = cell.animate(
    [{ transform: `translateY(${shift}px)`, boxShadow: FROZEN_SHADOW }],
    { duration: 0, fill: 'forwards' },
  );
  const occluderAnimation = cell.animate([{ opacity: '1' }], {
    duration: 0,
    fill: 'forwards',
    pseudoElement: '::before',
  });
  appliedFreezes.set(cell, { key, animations: [animation, occluderAnimation] });
}

interface MeasuredHeader {
  firstRow: HTMLTableRowElement;
  tableRect: DOMRect;
  headerHeight: number;
}

function computeAndApplyFrozenHeaders(
  scrollEl: HTMLElement,
  editorDom: HTMLElement,
  timeline: AnimationTimeline | null,
  isRenderingSkipped: (table: HTMLTableElement) => boolean,
): void {
  const containerTop = scrollEl.getBoundingClientRect().top;
  const scrollTop = scrollEl.scrollTop;
  const scrollMax = scrollEl.scrollHeight - scrollEl.clientHeight;
  const measured: MeasuredHeader[] = [];
  for (const table of editorDom.querySelectorAll<HTMLTableElement>('.tableWrapper > table')) {
    const firstRow = table.querySelector('tbody')?.rows[0];
    if (!firstRow || !Array.from(firstRow.cells).some((c) => c.tagName === 'TH')) {
      continue;
    }
    if (isRenderingSkipped(table)) continue;
    measured.push({
      firstRow,
      tableRect: table.getBoundingClientRect(),
      headerHeight: firstRow.getBoundingClientRect().height,
    });
  }

  for (const { firstRow, tableRect, headerHeight } of measured) {
    const range = computeFreezeRange(
      scrollTop,
      containerTop,
      tableRect.top,
      tableRect.height,
      headerHeight,
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
    if (shift <= 0 || tableRect.bottom <= containerTop + editorToolbarOverlapPx()) {
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
          const editorDom = editorView.dom as HTMLElement;

          const isRenderingSkipped = (table: HTMLTableElement): boolean => {
            for (let el = table.parentElement; el && el !== editorDom; el = el.parentElement) {
              if (skippedChunks.has(el)) return true;
            }
            return false;
          };

          const run = (): void => {
            if (destroyed || !scrollEl) return;
            computeAndApplyFrozenHeaders(scrollEl, editorDom, timeline, isRenderingSkipped);
          };

          const scheduleRun = (): void => {
            if (rafId != null) return;
            rafId = requestAnimationFrame(() => {
              rafId = null;
              run();
            });
          };

          const onChunkVisibilityChange = (event: Event): void => {
            const chunk = event.target;
            if (!(chunk instanceof Element)) return;
            if ((event as ContentVisibilityAutoStateChangeEvent).skipped) {
              skippedChunks.add(chunk);
              return;
            }
            skippedChunks.delete(chunk);
            if (chunk.querySelector('table')) scheduleRun();
          };
          editorDom.addEventListener('contentvisibilityautostatechange', onChunkVisibilityChange, {
            capture: true,
          });

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
            scrollEl = editorDom.closest<HTMLElement>('[data-testid="editor-scroll-container"]');
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
              resizeObserver.observe(editorDom);
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
              editorDom.removeEventListener(
                'contentvisibilityautostatechange',
                onChunkVisibilityChange,
                { capture: true },
              );
              for (const row of editorDom.querySelectorAll<HTMLTableRowElement>(
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
