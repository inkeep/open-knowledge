import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  anchorScrollDrivenStartTime,
  applyViewTimelineFreeze,
  buildShiftKeyframes,
  computeFreezeRange,
  computeWrapperFreeze,
} from './frozen-table-headers.ts';

describe('computeFreezeRange (scroll-driven animation ranges)', () => {
  it('returns null for a single-row table (header is the whole table)', () => {
    expect(computeFreezeRange(0, 0, 100, 40, 40)).toBeNull();
  });

  it('places startOffset where the table top meets the toolbar boundary', () => {
    const range = computeFreezeRange(0, 0, 156, 1000, 40);
    expect(range).toEqual({ startOffset: 100, endOffset: 1060, maxShift: 960 });
  });

  it('is invariant to the scroll position at which geometry is measured', () => {
    const atTop = computeFreezeRange(0, 0, 156, 1000, 40);
    const scrolled = computeFreezeRange(300, 0, 156 - 300, 1000, 40);
    expect(scrolled).toEqual(atTop);
  });

  it('agrees with the per-frame shift formula across the whole scroll range', () => {
    const containerTop = 0;
    const tableDocTop = 156;
    const tableHeight = 1000;
    const headerHeight = 40;
    const range = computeFreezeRange(0, containerTop, tableDocTop, tableHeight, headerHeight);
    if (!range) throw new Error('expected a range');
    for (const scrollTop of [0, 50, 100, 101, 500, 1060, 1500]) {
      const animShift = Math.max(0, Math.min(scrollTop - range.startOffset, range.maxShift));
      const tableTop = tableDocTop - scrollTop;
      const expected = Math.max(
        0,
        Math.min(containerTop + 56 - tableTop, tableHeight - headerHeight),
      );
      expect(animShift).toBe(expected);
    }
  });

  it('yields a negative startOffset for a table starting under the toolbar', () => {
    const range = computeFreezeRange(0, 0, 30, 400, 40);
    expect(range?.startOffset).toBe(-26);
  });
});

describe('computeWrapperFreeze (view-timeline cover ranges)', () => {
  it('returns null for a single-row table', () => {
    expect(computeWrapperFreeze(0, 40, 0, 40, 40, 700)).toBeNull();
  });

  it('spans the cover range: scrollport plus wrapper height', () => {
    const freeze = computeWrapperFreeze(200, 1000, 200, 1000, 40, 700);
    expect(freeze).toEqual({
      range: { startOffset: 700, endOffset: 1660, maxShift: 960 },
      timelineLength: 1700,
    });
  });

  it('offsets the ramp by the table position inside its wrapper', () => {
    const freeze = computeWrapperFreeze(200, 1016, 208, 1000, 40, 700);
    expect(freeze?.range.startOffset).toBe(708);
  });

  it('agrees with the per-frame shift formula at every scroll position', () => {
    const containerTop = 0;
    const toolbar = 56;
    const clientHeight = 756;
    const wrapperDocTop = 1200;
    const tableDocTop = 1208;
    const wrapperHeight = 1016;
    const tableHeight = 1000;
    const headerHeight = 40;
    const freeze = computeWrapperFreeze(
      wrapperDocTop,
      wrapperHeight,
      tableDocTop,
      tableHeight,
      headerHeight,
      clientHeight - toolbar,
    );
    if (!freeze) throw new Error('expected a freeze');
    const coverStart = wrapperDocTop - clientHeight;
    for (const scrollTop of [0, 444, 1144, 1152, 1153, 1600, 2112, 2500, 4000]) {
      const coverScroll = scrollTop - coverStart;
      const animShift = Math.max(
        0,
        Math.min(coverScroll - freeze.range.startOffset, freeze.range.maxShift),
      );
      const tableTop = tableDocTop - scrollTop;
      const expected = Math.max(
        0,
        Math.min(containerTop + toolbar - tableTop, tableHeight - headerHeight),
      );
      expect(animShift).toBe(expected);
    }
  });

  it('is unchanged when the table only moves in the viewport', () => {
    const atTop = computeWrapperFreeze(1200, 1016, 1208, 1000, 40, 700);
    const scrolled = computeWrapperFreeze(1200 - 900, 1016, 1208 - 900, 1000, 40, 700);
    expect(scrolled).toEqual(atTop);
  });

  it('absorbs sub-layout-unit noise in measured rects', () => {
    const exact = computeWrapperFreeze(300, 1016, 308, 1000, 40, 700);
    const noisy = computeWrapperFreeze(300.0041, 1016.0003, 308.0049, 999.9998, 40.0002, 699.9996);
    expect(noisy).toEqual(exact);
  });
});

describe('buildShiftKeyframes', () => {
  const ty = (k: Keyframe): number =>
    Number(/translateY\((-?[\d.]+)px\)/.exec(String(k.transform))?.[1]);

  it('emits plateau-ramp-plateau keyframes for a mid-document table', () => {
    const frames = buildShiftKeyframes({ startOffset: 100, endOffset: 1000, maxShift: 900 }, 2000);
    expect(frames.map((f) => f.offset)).toEqual([0, 0.05, 0.5, 1]);
    expect(frames.map(ty)).toEqual([0, 0, 900, 900]);
  });

  it('clamps a negative startOffset (table already under the toolbar at scroll 0)', () => {
    const frames = buildShiftKeyframes({ startOffset: -50, endOffset: 150, maxShift: 200 }, 1000);
    expect(frames[0]?.offset).toBe(0);
    expect(ty(frames[0] as Keyframe)).toBe(50);
    expect(frames.map((f) => f.offset)).toEqual([0, 0.15, 1]);
    expect(frames.map(ty)).toEqual([50, 200, 200]);
  });

  it('keeps offsets non-decreasing and within [0, 1] when the freeze window exceeds scroll range', () => {
    const frames = buildShiftKeyframes({ startOffset: 500, endOffset: 3000, maxShift: 2500 }, 1000);
    expect(frames.map((f) => f.offset)).toEqual([0, 0.5, 1]);
    expect(frames.map(ty)).toEqual([0, 0, 500]);
  });
});

describe('anchorScrollDrivenStartTime (deletion guard, not browser-rung coverage)', () => {
  const realCss = (globalThis as { CSS?: unknown }).CSS;

  afterEach(() => {
    (globalThis as { CSS?: unknown }).CSS = realCss;
    vi.restoreAllMocks();
  });

  function stubCssPercent(): void {
    (globalThis as { CSS?: unknown }).CSS = { percent: (value: number) => ({ percent: value }) };
  }

  it('anchors the replacement at zero progress so it is not left play-pending', () => {
    stubCssPercent();
    let assigned: unknown;
    const animation = {
      set startTime(value: unknown) {
        assigned = value;
      },
    } as unknown as Animation;

    anchorScrollDrivenStartTime(animation);

    expect(assigned).toEqual({ percent: 0 });
  });

  it('contains a rejected assignment and reports it once rather than per animation', () => {
    stubCssPercent();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rejecting = {
      set startTime(_value: unknown) {
        throw new TypeError('percentage start time is not supported on this timeline');
      },
    } as unknown as Animation;

    expect(() => {
      anchorScrollDrivenStartTime(rejecting);
      anchorScrollDrivenStartTime(rejecting);
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('applyViewTimelineFreeze (every animation it creates is anchored)', () => {
  const realCss = (globalThis as { CSS?: unknown }).CSS;

  afterEach(() => {
    (globalThis as { CSS?: unknown }).CSS = realCss;
  });

  it('anchors all three tracks, not only the transform', () => {
    (globalThis as { CSS?: unknown }).CSS = { percent: (value: number) => ({ percent: value }) };
    const anchored: unknown[] = [];
    const cell = {
      cellIndex: 0,
      animate: () => {
        const index = anchored.length;
        anchored.push(undefined);
        return {
          set startTime(value: unknown) {
            anchored[index] = value;
          },
        } as unknown as Animation;
      },
    } as unknown as HTMLTableCellElement;

    applyViewTimelineFreeze(cell, {} as AnimationTimeline, {
      range: { startOffset: 100, endOffset: 1000, maxShift: 900 },
      timelineLength: 2_000,
    });

    expect(anchored).toEqual([{ percent: 0 }, { percent: 0 }, { percent: 0 }]);
  });

  it('keeps its animations when the table only moves in the viewport', () => {
    (globalThis as { CSS?: unknown }).CSS = { percent: (value: number) => ({ percent: value }) };
    let created = 0;
    const cell = {
      animate: () => {
        created++;
        return { cancel: () => {}, set startTime(_value: unknown) {} } as unknown as Animation;
      },
    } as unknown as HTMLTableCellElement;
    const timeline = {} as AnimationTimeline;
    const freezeAt = (wrapperTop: number) =>
      computeWrapperFreeze(wrapperTop, 1016, wrapperTop + 8, 1000, 40, 700);

    for (const wrapperTop of [1200, 300, -400]) {
      const freeze = freezeAt(wrapperTop);
      if (!freeze) throw new Error('expected a freeze');
      applyViewTimelineFreeze(cell, timeline, freeze);
    }

    expect(created).toBe(3);
  });
});
