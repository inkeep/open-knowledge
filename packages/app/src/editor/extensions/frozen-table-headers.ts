import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { EDITOR_TOOLBAR_HEIGHT, editorToolbarOverlapPx } from '@/lib/editor-toolbar-overlap';

export const TOOLBAR_HEIGHT = EDITOR_TOOLBAR_HEIGHT;

const FROZEN_SHADOW = '0 2px 4px rgba(0, 0, 0, 0.08)';

const DRIFT_RECOMPUTE_MS = 150;

interface ViewTimelineOptions {
  subject: Element;
  axis?: 'block' | 'inline' | 'x' | 'y';
  inset?: CSSNumericValue[];
}
interface ViewTimelineLike extends AnimationTimeline {
  readonly source: Element | null;
}
type ViewTimelineConstructor = new (options: ViewTimelineOptions) => ViewTimelineLike;

const ViewTimelineImpl = (globalThis as { ViewTimeline?: ViewTimelineConstructor }).ViewTimeline;

let viewTimelinesUsable = Boolean(ViewTimelineImpl);

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

export interface WrapperFreeze {
  range: FreezeRange;
  timelineLength: number;
}

const toLayoutUnit = (px: number): number => Math.round(px * 64) / 64;

export function computeWrapperFreeze(
  wrapperTop: number,
  wrapperHeight: number,
  tableTop: number,
  tableHeight: number,
  headerHeight: number,
  scrollportHeight: number,
): WrapperFreeze | null {
  const maxShift = toLayoutUnit(tableHeight - headerHeight);
  const scrollport = toLayoutUnit(scrollportHeight);
  const wrapper = toLayoutUnit(wrapperHeight);
  if (maxShift <= 0 || !(wrapper > 0) || !(scrollport > 0)) return null;
  const startOffset = scrollport + toLayoutUnit(tableTop - wrapperTop);
  return {
    range: { startOffset, endOffset: startOffset + maxShift, maxShift },
    timelineLength: scrollport + wrapper,
  };
}

interface AppliedFreeze {
  key: string;
  timeline?: AnimationTimeline;
  animations: Animation[];
}

const appliedFreezes = new WeakMap<HTMLTableCellElement, AppliedFreeze>();

const skippedChunks = new WeakSet<Element>();

const wrapperTimelines = new WeakMap<HTMLElement, ViewTimelineLike | 'scroll-events'>();

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

export function buildShiftKeyframes(range: FreezeRange, timelineLength: number): Keyframe[] {
  return buildFreezeKeyframes(range, timelineLength, (shift) => ({
    transform: `translateY(${shift}px)`,
  }));
}

function buildFreezeKeyframes(
  range: FreezeRange,
  timelineLength: number,
  toProps: (shiftPx: number) => Omit<Keyframe, 'offset'>,
): Keyframe[] {
  if (!(timelineLength > 0)) {
    return [
      { offset: 0, ...toProps(0) },
      { offset: 1, ...toProps(0) },
    ];
  }
  const shiftAt = (scroll: number): number =>
    Math.max(0, Math.min(scroll - range.startOffset, range.maxShift));
  const breakpoints = Array.from(
    new Set(
      [0, range.startOffset / timelineLength, range.endOffset / timelineLength, 1].map((o) =>
        Math.max(0, Math.min(o, 1)),
      ),
    ),
  ).sort((a, b) => a - b);
  return breakpoints.map((offset) => ({
    offset,
    ...toProps(shiftAt(offset * timelineLength)),
  }));
}

function buildBoundaryFlipKeyframes(
  range: FreezeRange,
  timelineLength: number,
  pre: Omit<Keyframe, 'offset'>,
  post: Omit<Keyframe, 'offset'>,
): Keyframe[] {
  if (!(timelineLength > 0)) {
    return [
      { ...pre, offset: 0 },
      { ...pre, offset: 1 },
    ];
  }
  const flip = range.startOffset / timelineLength;
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
  const flipEnd = Math.min(flip + 1 / timelineLength, 1);
  return [
    { ...pre, offset: 0 },
    { ...pre, offset: flip },
    { ...post, offset: flipEnd },
    { ...post, offset: 1 },
  ];
}

function buildChromeKeyframes(range: FreezeRange, timelineLength: number): Keyframe[] {
  return buildBoundaryFlipKeyframes(
    range,
    timelineLength,
    { boxShadow: 'none' },
    { boxShadow: FROZEN_SHADOW },
  );
}

function buildOccluderKeyframes(range: FreezeRange, timelineLength: number): Keyframe[] {
  return buildBoundaryFlipKeyframes(range, timelineLength, { opacity: '0' }, { opacity: '1' });
}

export function applyViewTimelineFreeze(
  cell: HTMLTableCellElement,
  timeline: AnimationTimeline,
  { range, timelineLength }: WrapperFreeze,
): void {
  const key = `vt|${range.startOffset}|${range.maxShift}|${timelineLength}`;
  const prev = appliedFreezes.get(cell);
  if (prev?.key === key && prev.timeline === timeline) return;
  if (prev) for (const animation of prev.animations) animation.cancel();

  const base: ScrollDrivenAnimationOptions = { timeline, fill: 'both', easing: 'linear' };
  const transformAnimation = cell.animate(buildShiftKeyframes(range, timelineLength), base);
  const chromeAnimation = cell.animate(buildChromeKeyframes(range, timelineLength), base);
  const occluderAnimation = cell.animate(buildOccluderKeyframes(range, timelineLength), {
    ...base,
    pseudoElement: '::before',
  });
  const animations = [transformAnimation, chromeAnimation, occluderAnimation];
  for (const animation of animations) anchorScrollDrivenStartTime(animation);
  appliedFreezes.set(cell, { key, timeline, animations });
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

let nestedScrollerWarned = false;

function wrapperTimeline(wrapper: HTMLElement, scrollEl: HTMLElement): ViewTimelineLike | null {
  if (!ViewTimelineImpl || !viewTimelinesUsable) return null;
  const cached = wrapperTimelines.get(wrapper);
  if (cached) return cached === 'scroll-events' ? null : cached;
  let timeline: ViewTimelineLike;
  try {
    timeline = new ViewTimelineImpl({
      subject: wrapper,
      axis: 'block',
      inset: [CSS.px(editorToolbarOverlapPx()), CSS.px(0)],
    });
  } catch (error) {
    viewTimelinesUsable = false;
    if (import.meta.env.DEV) {
      console.warn(
        '[frozen-table-headers] ViewTimeline construction rejected; table headers fall back to scroll-event freezing',
        error,
      );
    }
    return null;
  }
  if (timeline.source !== scrollEl) {
    wrapperTimelines.set(wrapper, 'scroll-events');
    if (import.meta.env.DEV && !nestedScrollerWarned) {
      nestedScrollerWarned = true;
      console.warn(
        '[frozen-table-headers] a table sits inside a scroll container other than editor-scroll-container; its header freezes from scroll events on the main thread',
      );
    }
    return null;
  }
  wrapperTimelines.set(wrapper, timeline);
  return timeline;
}

interface MeasuredHeader {
  firstRow: HTMLTableRowElement;
  wrapper: HTMLElement;
  wrapperRect: DOMRect;
  tableRect: DOMRect;
  headerHeight: number;
}

function computeAndApplyFrozenHeaders(
  scrollEl: HTMLElement,
  editorDom: HTMLElement,
  isRenderingSkipped: (table: HTMLTableElement) => boolean,
): boolean {
  const containerTop = scrollEl.getBoundingClientRect().top;
  const scrollTop = scrollEl.scrollTop;
  const scrollportHeight = scrollEl.clientHeight - editorToolbarOverlapPx();
  const measured: MeasuredHeader[] = [];
  let followsScrollEvents = false;
  for (const table of editorDom.querySelectorAll<HTMLTableElement>('.tableWrapper > table')) {
    const wrapper = table.parentElement;
    const firstRow = table.querySelector('tbody')?.rows[0];
    if (!wrapper || !firstRow || !Array.from(firstRow.cells).some((c) => c.tagName === 'TH')) {
      continue;
    }
    if (isRenderingSkipped(table)) continue;
    measured.push({
      firstRow,
      wrapper,
      wrapperRect: wrapper.getBoundingClientRect(),
      tableRect: table.getBoundingClientRect(),
      headerHeight: firstRow.getBoundingClientRect().height,
    });
  }

  for (const { firstRow, wrapper, wrapperRect, tableRect, headerHeight } of measured) {
    const cells = Array.from(firstRow.cells) as HTMLTableCellElement[];

    const freeze = computeWrapperFreeze(
      wrapperRect.top,
      wrapperRect.height,
      tableRect.top,
      tableRect.height,
      headerHeight,
      scrollportHeight,
    );
    if (!freeze) {
      resetHeaderCells(firstRow);
      continue;
    }
    const timeline = wrapperTimeline(wrapper, scrollEl);
    if (timeline) {
      for (const cell of cells) applyViewTimelineFreeze(cell, timeline, freeze);
      continue;
    }
    followsScrollEvents = true;

    const range = computeFreezeRange(
      scrollTop,
      containerTop,
      tableRect.top,
      tableRect.height,
      headerHeight,
    );
    const shift = range ? Math.max(0, Math.min(scrollTop - range.startOffset, range.maxShift)) : 0;
    if (shift <= 0 || tableRect.bottom <= containerTop + editorToolbarOverlapPx()) {
      resetHeaderCells(firstRow);
      continue;
    }
    for (const cell of cells) applyInstantFreeze(cell, shift);
  }
  return followsScrollEvents;
}

export const FrozenTableHeaders = Extension.create({
  name: 'frozenTableHeaders',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('frozenTableHeaders'),

        view(editorView) {
          let scrollEl: HTMLElement | null = null;
          let rafId: number | null = null;
          let driftTimer: ReturnType<typeof setTimeout> | null = null;
          let resizeObserver: ResizeObserver | null = null;
          let destroyed = false;
          let followsScrollEvents = false;
          const editorDom = editorView.dom as HTMLElement;

          const isRenderingSkipped = (table: HTMLTableElement): boolean => {
            for (let el = table.parentElement; el && el !== editorDom; el = el.parentElement) {
              if (skippedChunks.has(el)) return true;
            }
            return false;
          };

          const run = (): void => {
            if (destroyed || !scrollEl) return;
            followsScrollEvents = computeAndApplyFrozenHeaders(
              scrollEl,
              editorDom,
              isRenderingSkipped,
            );
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
            if (!followsScrollEvents) {
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
