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

/** Minimal layout fake: only the members measureAnchor reads. */
function fakeElement(opts: { rects: number; top?: number; scrollTop?: number }): HTMLElement {
  return {
    scrollTop: opts.scrollTop ?? 0,
    getClientRects: () => ({ length: opts.rects }) as DOMRectList,
    getBoundingClientRect: () => ({ top: opts.top ?? 0 }) as DOMRect,
  } as unknown as HTMLElement;
}

/** Minimal layout fake for one of the scroller's editing surfaces. */
function fakeSurface(opts: { bottom: number; rects?: number }): Element {
  return {
    getClientRects: () => ({ length: opts.rects ?? 1 }) as DOMRectList,
    getBoundingClientRect: () => ({ bottom: opts.bottom }) as DOMRect,
  } as unknown as Element;
}

/**
 * Scroller fake. `scrollHeight` is deliberately settable and deliberately
 * inconsistent with the surfaces: the whole point of measuring the editing
 * surface is that scrollHeight can describe space the document does not
 * occupy.
 */
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

describe('measureContentExtent', () => {
  test('a container with no editing surface has no measurable extent', () => {
    // A Suspense skeleton or warm fallback: no evidence, so callers keep
    // whatever behavior they had rather than clamping against nothing.
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
    // The hidden half of a dual-mounted document reports a rect at the
    // viewport origin, which as an extent would clamp every restore to the
    // top of the page. Same hazard as an unmeasurable anchor.
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
    // contenteditable=false atoms (wiki-link chips, embeds) match the selector
    // but sit inside the real editing surface; ancestry excludes them so a
    // chip-dense document costs one rect read, not one per atom.
    const nested = {
      ...fakeSurface({ bottom: 99_999 }),
      parentElement: { closest: () => ({}) as Element } as unknown as HTMLElement,
    } as unknown as Element;
    const scroller = fakeScroller({ surfaces: [fakeSurface({ bottom: 10132 }), nested] });
    expect(measureContentExtent(scroller)).toBe(10132);
  });

  test('never falls back to scrollHeight — that is the polluted quantity', () => {
    // The bug shape: absolutely positioned chrome parked deep in the scroller
    // keeps scrollHeight stretched thousands of pixels past a document that
    // re-rendered much shorter. A helper that consulted scrollHeight here
    // would hand the restore back the same phantom runway it is meant to
    // withhold.
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
    // The reported bug: an offset saved against 48,046px of materialized
    // content, re-applied to a layout that re-rendered at 10,132px.
    expect(clampTargetToContent(38313, 10132, 631)).toBe(10132 - 631);
  });

  test('content shorter than the viewport clamps to the top, never below zero', () => {
    expect(clampTargetToContent(38313, 447, 631)).toBe(0);
    expect(clampTargetToContent(0, 0, 631)).toBe(0);
  });

  test('an unmeasurable extent leaves the target alone', () => {
    // Nothing measured is not evidence of a short document; clamping on it
    // would strand a healthy restore at 0.
    expect(clampTargetToContent(38313, null, 631)).toBe(38313);
  });

  test('the bound is inclusive — a target exactly one viewport above the content bottom stands', () => {
    // A <= -> < drift here would shave a pixel off every restore that lands
    // at the very end of a document.
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
    // Overlay chrome can stretch scrollHeight far past the document (38,944
    // vs content ending at 10,132) — a runway check that trusted scrollHeight
    // would approve a target 28,000px past real content and let the restore
    // mark that landing a success.
    expect(hasRestoreRunway(38313, 10132, 38944)).toBe(false);
  });

  test('an unmeasurable extent falls back to scrollHeight', () => {
    expect(hasRestoreRunway(1200, null, 5000)).toBe(true);
    expect(hasRestoreRunway(1200, null, 900)).toBe(false);
  });

  test('a target exactly at the content bottom has no runway (boundary is exclusive)', () => {
    // The boundary is exclusive (`>`): a document that shrank to exactly the
    // target has no document below it, which is "restoration was not
    // possible", not an abandoned restore.
    expect(hasRestoreRunway(10132, 10132, 10132)).toBe(false);
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
