import { describe, expect, test } from 'vitest';
import {
  computeRestoreTarget,
  hasLandedAt,
  isExternalScroll,
  measureAnchor,
  SCROLL_LANDING_TOLERANCE_PX,
  shouldRecordScrollPosition,
} from './scroll-restore';

/** Minimal layout fake: only the members measureAnchor reads. */
function fakeElement(opts: { rects: number; top?: number; scrollTop?: number }): HTMLElement {
  return {
    scrollTop: opts.scrollTop ?? 0,
    getClientRects: () => ({ length: opts.rects }) as DOMRectList,
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
    // Saved at scrollTop 1200 with 426px above the body -> offset 774. After
    // the Properties panel collapses (322px less above the body), the same
    // body content sits at scrollTop 878.
    expect(computeRestoreTarget(1200, 774, { kind: 'measured', contentPos: 426 })).toBe(1200);
    expect(computeRestoreTarget(1200, 774, { kind: 'measured', contentPos: 104 })).toBe(878);
  });

  test('unmeasurable anchor yields no target (hold) — NOT scrollTop-relative feedback', () => {
    // The regression this pins: a zero-rect anchor used to degenerate into
    // `scrollTop - containerTop`, making each applied frame raise the next
    // frame's target by ~the body offset until the scroller ran away from the
    // saved position. The only safe output for a degenerate frame is null.
    expect(computeRestoreTarget(1200, 774, { kind: 'unmeasurable' })).toBeNull();
  });

  test('anchor absent from the layout falls back to the raw saved scrollTop', () => {
    expect(computeRestoreTarget(1200, 774, { kind: 'absent' })).toBe(1200);
  });

  test('a zero body offset is a real offset, not "no offset"', () => {
    // 0 is stored when the user sat exactly at the anchor position. A
    // falsy-check drift (bodyOffset === null -> !bodyOffset) would silently
    // switch these to raw-scrollTop restores.
    expect(computeRestoreTarget(1200, 0, { kind: 'measured', contentPos: 426 })).toBe(426);
    expect(computeRestoreTarget(1200, 0, { kind: 'unmeasurable' })).toBeNull();
  });
});

describe('shouldRecordScrollPosition', () => {
  test('a scroll event on an unmeasurable-anchor frame must NOT be recorded', () => {
    // The save-side twin of the restore-side hold: recording pairs the
    // scrollTop with a garbage anchor state and corrupts the saved body
    // offset the next restore relies on.
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
    // A <= -> < equivalent mutation here would make a legitimate 1px
    // per-frame anchor correction read as a takeover and end the loop one
    // pixel short.
    expect(isExternalScroll(1200, 1200 + SCROLL_LANDING_TOLERANCE_PX)).toBe(false);
  });

  test('an upward move we did not write is external (no browser-side explanation)', () => {
    expect(isExternalScroll(1200, 2600)).toBe(true);
    expect(isExternalScroll(0, 400)).toBe(true);
  });

  test('an upward move just above the tolerance IS external', () => {
    // Pins the > side of the boundary: a > -> >= drift would misclassify a
    // legitimate 1px anchor correction as a takeover.
    expect(isExternalScroll(1200, 1200 + SCROLL_LANDING_TOLERANCE_PX + 0.001)).toBe(true);
  });

  test('downward moves are never external — they can be shrink-clamps against a TRANSIENT height', () => {
    // The regression this pins: a fresh-mount hydration collapse clamps
    // scrollTop to 0 against a momentary small scrollHeight; by the next
    // (starved) frame the height has regrown, so no comparison against the
    // CURRENT maxScroll can tell this clamp from a takeover. Treating the
    // downward move as external stranded the rename-restore at 0 in CI.
    // Downward USER takeovers are caught by the intent listeners instead.
    expect(isExternalScroll(1330, 0)).toBe(false);
    expect(isExternalScroll(1200, 300)).toBe(false);
    expect(isExternalScroll(1200, 400)).toBe(false);
  });
});

describe('hasLandedAt', () => {
  test('integer-clamped scrollTop lands on a fractional target within tolerance', () => {
    // Observed in the wild: target 882.40625, scrollTop clamped to 882.
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
    // A <= -> < mutation here would leave the loop rewriting to the backstop
    // and never emit phase2-success.
    expect(hasLandedAt(882 + SCROLL_LANDING_TOLERANCE_PX, 882)).toBe(true);
    expect(hasLandedAt(882 - SCROLL_LANDING_TOLERANCE_PX, 882)).toBe(true);
  });
});
