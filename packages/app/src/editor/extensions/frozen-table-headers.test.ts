import { describe, expect, it } from 'bun:test';
import { buildShiftKeyframes, computeFreezeRange } from './frozen-table-headers.ts';

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
    const tableDocTop = 156; // table top in document space (scrollTop 0 measurement)
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
