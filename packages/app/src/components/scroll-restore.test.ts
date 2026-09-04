import { describe, expect, test } from 'vitest';
import {
  clampTargetToContent,
  computeRestoreTarget,
  hasLandedAt,
  hasRestoreRunway,
  isExternalScroll,
  measureAnchor,
  measureContentExtent,
  SCROLL_LANDING_TOLERANCE_PX,
  shouldRecordScrollPosition,
} from './scroll-restore';

function fakeElement(opts: { rects: number; top?: number; scrollTop?: number }): HTMLElement {
  return {
    scrollTop: opts.scrollTop ?? 0,
    getClientRects: () => ({ length: opts.rects }) as DOMRectList,
    getBoundingClientRect: () => ({ top: opts.top ?? 0 }) as DOMRect,
  } as unknown as HTMLElement;
}

function fakeSurface(opts: { bottom: number; rects?: number }): Element {
  return {
    getClientRects: () => ({ length: opts.rects ?? 1 }) as DOMRectList,
    getBoundingClientRect: () => ({ bottom: opts.bottom }) as DOMRect,
  } as unknown as Element;
}

function fakeScroller(opts: {
  top?: number;
  scrollTop?: number;
  scrollHeight?: number;
  surfaces: Element[];
}): HTMLElement {
  return {
    scrollTop: opts.scrollTop ?? 0,
    scrollHeight: opts.scrollHeight ?? 0,
    querySelectorAll: () => opts.surfaces,
    getBoundingClientRect: () => ({ top: opts.top ?? 0 }) as DOMRect,
  } as unknown as HTMLElement;
}

describe('measureAnchor', () => {
  test('absent anchor (null / undefined) reports absent', () => {
    const container = fakeElement({ rects: 1, top: 56, scrollTop: 1200 });
    expect(measureAnchor(container, null)).toEqual({ kind: 'absent' });
    expect(measureAnchor(container, undefined)).toEqual({ kind: 'absent' });
  });

  test('anchor with no layout boxes (display:none / detached) is unmeasurable, never a viewport-origin measurement', () => {
    const container = fakeElement({ rects: 1, top: 56, scrollTop: 1200 });
    const hiddenAnchor = fakeElement({ rects: 0, top: 0 });
    expect(measureAnchor(container, hiddenAnchor)).toEqual({ kind: 'unmeasurable' });
  });

  test('laid-out anchor measures its content position (aTop - cTop + scrollTop)', () => {
    const container = fakeElement({ rects: 1, top: 56, scrollTop: 1205 });
    const anchor = fakeElement({ rects: 1, top: -722.40625 });
    expect(measureAnchor(container, anchor)).toEqual({
      kind: 'measured',
      contentPos: -722.40625 - 56 + 1205,
    });
  });

  test('a zero-height anchor that IS laid out still measures (h-0 divs generate a box)', () => {
    const container = fakeElement({ rects: 1, top: 0, scrollTop: 0 });
    const anchor = fakeElement({ rects: 1, top: 350 });
    expect(measureAnchor(container, anchor)).toEqual({ kind: 'measured', contentPos: 350 });
  });
});

describe('computeRestoreTarget', () => {
  test('no saved body offset restores the raw scrollTop regardless of anchor state', () => {
    expect(computeRestoreTarget(1200, null, { kind: 'measured', contentPos: 426 })).toBe(1200);
    expect(computeRestoreTarget(1200, null, { kind: 'unmeasurable' })).toBe(1200);
    expect(computeRestoreTarget(1200, null, { kind: 'absent' })).toBe(1200);
  });

  test('measured anchor keeps the body offset constant as the height above the body changes', () => {
    expect(computeRestoreTarget(1200, 774, { kind: 'measured', contentPos: 426 })).toBe(1200);
    expect(computeRestoreTarget(1200, 774, { kind: 'measured', contentPos: 104 })).toBe(878);
  });

  test('unmeasurable anchor yields no target (hold) — NOT scrollTop-relative feedback', () => {
    expect(computeRestoreTarget(1200, 774, { kind: 'unmeasurable' })).toBeNull();
  });

  test('anchor absent from the layout falls back to the raw saved scrollTop', () => {
    expect(computeRestoreTarget(1200, 774, { kind: 'absent' })).toBe(1200);
  });

  test('a zero body offset is a real offset, not "no offset"', () => {
    expect(computeRestoreTarget(1200, 0, { kind: 'measured', contentPos: 426 })).toBe(426);
    expect(computeRestoreTarget(1200, 0, { kind: 'unmeasurable' })).toBeNull();
  });
});

describe('measureContentExtent', () => {
  test('a container with no editing surface has no measurable extent', () => {
    expect(measureContentExtent(fakeScroller({ surfaces: [] }))).toBeNull();
  });

  test('measures the surface bottom into scroll coordinates (bottom - containerTop + scrollTop)', () => {
    const scroller = fakeScroller({
      top: 56,
      scrollTop: 9471,
      surfaces: [fakeSurface({ bottom: 631 })],
    });
    expect(measureContentExtent(scroller)).toBe(631 - 56 + 9471);
  });

  test('takes the lowest surface, not the last one', () => {
    const scroller = fakeScroller({
      surfaces: [
        fakeSurface({ bottom: 400 }),
        fakeSurface({ bottom: 10132 }),
        fakeSurface({ bottom: 0 }),
      ],
    });
    expect(measureContentExtent(scroller)).toBe(10132);
  });

  test('a surface with no layout boxes contributes nothing, not a zero rect', () => {
    const scroller = fakeScroller({
      top: 56,
      scrollTop: 1000,
      surfaces: [fakeSurface({ bottom: 5000 }), fakeSurface({ bottom: 0, rects: 0 })],
    });
    expect(measureContentExtent(scroller)).toBe(5000 - 56 + 1000);
  });

  test('a container whose surfaces are all unlaid-out reports no extent', () => {
    const scroller = fakeScroller({ surfaces: [fakeSurface({ bottom: 0, rects: 0 })] });
    expect(measureContentExtent(scroller)).toBeNull();
  });

  test('a surface nested inside another surface contributes nothing (atom node views)', () => {
    const nested = {
      ...fakeSurface({ bottom: 99_999 }),
      parentElement: { closest: () => ({}) as Element } as unknown as HTMLElement,
    } as unknown as Element;
    const scroller = fakeScroller({ surfaces: [fakeSurface({ bottom: 10132 }), nested] });
    expect(measureContentExtent(scroller)).toBe(10132);
  });

  test('never falls back to scrollHeight — that is the polluted quantity', () => {
    const scroller = fakeScroller({
      scrollHeight: 38944,
      surfaces: [fakeSurface({ bottom: 10132 })],
    });
    expect(measureContentExtent(scroller)).toBe(10132);
  });
});

describe('clampTargetToContent', () => {
  test('a target inside the content is untouched', () => {
    expect(clampTargetToContent(1200, 48046, 631)).toBe(1200);
  });

  test('a target past the content is pulled back to the last full viewport of content', () => {
    expect(clampTargetToContent(38313, 10132, 631)).toBe(10132 - 631);
  });

  test('content shorter than the viewport clamps to the top, never below zero', () => {
    expect(clampTargetToContent(38313, 447, 631)).toBe(0);
    expect(clampTargetToContent(0, 0, 631)).toBe(0);
  });

  test('an unmeasurable extent leaves the target alone', () => {
    expect(clampTargetToContent(38313, null, 631)).toBe(38313);
  });

  test('the bound is inclusive — a target exactly one viewport above the content bottom stands', () => {
    expect(clampTargetToContent(9501, 10132, 631)).toBe(9501);
  });

  test('clamping only ever lowers a target', () => {
    expect(clampTargetToContent(200, 48046, 631)).toBe(200);
    expect(clampTargetToContent(0, 48046, 631)).toBe(0);
  });
});

describe('hasRestoreRunway', () => {
  test('content below the target is runway', () => {
    expect(hasRestoreRunway(9501, 10132, 10132)).toBe(true);
  });

  test('scrollable space that is not content is NOT runway', () => {
    expect(hasRestoreRunway(38313, 10132, 38944)).toBe(false);
  });

  test('an unmeasurable extent falls back to scrollHeight', () => {
    expect(hasRestoreRunway(1200, null, 5000)).toBe(true);
    expect(hasRestoreRunway(1200, null, 900)).toBe(false);
  });

  test('a target exactly at the content bottom has no runway (boundary is exclusive)', () => {
    expect(hasRestoreRunway(10132, 10132, 10132)).toBe(false);
  });
});

describe('shouldRecordScrollPosition', () => {
  test('a scroll event on an unmeasurable-anchor frame must NOT be recorded', () => {
    expect(shouldRecordScrollPosition({ kind: 'unmeasurable' })).toBe(false);
  });

  test('measured and absent frames record normally', () => {
    expect(shouldRecordScrollPosition({ kind: 'measured', contentPos: 426 })).toBe(true);
    expect(shouldRecordScrollPosition({ kind: 'absent' })).toBe(true);
  });
});

describe('isExternalScroll', () => {
  test('an unchanged (or sub-tolerance) position is not external', () => {
    expect(isExternalScroll(1200, 1200)).toBe(false);
    expect(isExternalScroll(1200, 1200.5)).toBe(false);
  });

  test('an upward move of exactly the tolerance is not external (boundary is inclusive)', () => {
    expect(isExternalScroll(1200, 1200 + SCROLL_LANDING_TOLERANCE_PX)).toBe(false);
  });

  test('an upward move we did not write is external (no browser-side explanation)', () => {
    expect(isExternalScroll(1200, 2600)).toBe(true);
    expect(isExternalScroll(0, 400)).toBe(true);
  });

  test('an upward move just above the tolerance IS external', () => {
    expect(isExternalScroll(1200, 1200 + SCROLL_LANDING_TOLERANCE_PX + 0.001)).toBe(true);
  });

  test('downward moves are never external — they can be shrink-clamps against a TRANSIENT height', () => {
    expect(isExternalScroll(1330, 0)).toBe(false);
    expect(isExternalScroll(1200, 300)).toBe(false);
    expect(isExternalScroll(1200, 400)).toBe(false);
  });
});

describe('hasLandedAt', () => {
  test('integer-clamped scrollTop lands on a fractional target within tolerance', () => {
    expect(hasLandedAt(882, 882.40625)).toBe(true);
  });

  test('positions beyond the tolerance have not landed', () => {
    expect(hasLandedAt(880, 882.40625)).toBe(false);
    expect(hasLandedAt(882 + SCROLL_LANDING_TOLERANCE_PX + 0.5, 882)).toBe(false);
  });

  test('exact landing still lands', () => {
    expect(hasLandedAt(1200, 1200)).toBe(true);
  });

  test('a delta of exactly the tolerance lands (boundary is inclusive)', () => {
    expect(hasLandedAt(882 + SCROLL_LANDING_TOLERANCE_PX, 882)).toBe(true);
    expect(hasLandedAt(882 - SCROLL_LANDING_TOLERANCE_PX, 882)).toBe(true);
  });
});
