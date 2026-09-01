import { describe, expect, test } from 'vitest';
import { layoutMarkers, railBand, railLeft } from './CommentMarginRail';

const RAIL_TOP = 100;
const RAIL_HEIGHT = 600;
const ICON_H = 30;

describe('layoutMarkers', () => {
  test('centers a marker on the line it belongs to', () => {
    const [marker] = layoutMarkers([{ id: 'a', y: 400 }], RAIL_TOP, RAIL_HEIGHT);
    expect(marker.top).toBe(400 - ICON_H / 2);
    expect(marker.offscreen).toBe(false);
  });

  test('stacks markers that would overlap instead of piling them on one point', () => {
    const out = layoutMarkers(
      [
        { id: 'a', y: 400 },
        { id: 'b', y: 405 },
        { id: 'c', y: 410 },
      ],
      RAIL_TOP,
      RAIL_HEIGHT,
    );
    for (let i = 1; i < out.length; i += 1) {
      expect(out[i].top).toBeGreaterThanOrEqual(out[i - 1].top + ICON_H);
    }
    expect(out[0].top).toBe(400 - ICON_H / 2);
  });

  test('orders by position on screen, not by input order', () => {
    const out = layoutMarkers(
      [
        { id: 'low', y: 600 },
        { id: 'high', y: 200 },
      ],
      RAIL_TOP,
      RAIL_HEIGHT,
    );
    expect(out.map((m) => m.id)).toEqual(['high', 'low']);
  });

  test('clamps a line scrolled above the viewport to the top edge, flagged', () => {
    const [marker] = layoutMarkers([{ id: 'a', y: -250 }], RAIL_TOP, RAIL_HEIGHT);
    expect(marker.top).toBe(RAIL_TOP);
    expect(marker.offscreen).toBe(true);
  });

  test('clamps a line scrolled below the viewport to the bottom edge, flagged', () => {
    const [marker] = layoutMarkers([{ id: 'a', y: 5000 }], RAIL_TOP, RAIL_HEIGHT);
    expect(marker.top).toBe(RAIL_TOP + RAIL_HEIGHT - ICON_H);
    expect(marker.offscreen).toBe(true);
  });

  test('never places a marker outside the rail, however crowded', () => {
    const crowded = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, y: 690 }));
    for (const marker of layoutMarkers(crowded, RAIL_TOP, RAIL_HEIGHT)) {
      expect(marker.top).toBeGreaterThanOrEqual(RAIL_TOP);
      expect(marker.top).toBeLessThanOrEqual(RAIL_TOP + RAIL_HEIGHT - ICON_H);
    }
  });

  test('no markers, no positions', () => {
    expect(layoutMarkers([], RAIL_TOP, RAIL_HEIGHT)).toEqual([]);
  });
});

describe('railBand', () => {
  const scrollport = { top: 100, height: 600 };
  const TOOLBAR = 56;

  test('starts below the strip the scrollport declares as covered', () => {
    expect(railBand(scrollport, TOOLBAR)).toEqual({ top: 156, height: 544 });
  });

  test('keeps a top-clamped marker clear of the toolbar', () => {
    const band = railBand(scrollport, TOOLBAR);
    const [marker] = layoutMarkers([{ id: 'a', y: -250 }], band.top, band.height);
    expect(marker.top).toBeGreaterThanOrEqual(scrollport.top + TOOLBAR);
    expect(marker.offscreen).toBe(true);
  });

  test('a line hidden behind the toolbar counts as offscreen, not as placed there', () => {
    const band = railBand(scrollport, TOOLBAR);
    const [marker] = layoutMarkers([{ id: 'a', y: 130 }], band.top, band.height);
    expect(marker.top).toBe(band.top);
    expect(marker.offscreen).toBe(true);
  });

  test('leaves the band alone when the scrollport declares no inset', () => {
    expect(railBand(scrollport, 0)).toEqual(scrollport);
  });

  test('never reports a negative height for a scrollport shorter than its inset', () => {
    expect(railBand({ top: 100, height: 20 }, TOOLBAR).height).toBe(0);
  });
});

describe('railLeft', () => {
  const RAIL_WIDTH = 34;

  test('sits inside the container when the container fits its pane', () => {
    expect(railLeft({ left: 0, right: 800 }, 900)).toBe(800 - RAIL_WIDTH);
  });

  test('follows the clipping edge when the container overflows the pane', () => {
    expect(railLeft({ left: 0, right: 800 }, 500)).toBe(500 - RAIL_WIDTH);
  });

  test('declines rather than shrinking once the pane is too narrow', () => {
    expect(railLeft({ left: 0, right: 200 }, 900)).toBeNull();
  });

  test('measures the visible width, not the measured one, when deciding', () => {
    expect(railLeft({ left: 0, right: 900 }, 200)).toBeNull();
  });

  test('never reports a left that would put the rail past the visible edge', () => {
    for (const clipRight of [300, 400, 640, 1200]) {
      const left = railLeft({ left: 0, right: 1000 }, clipRight);
      if (left === null) continue;
      expect(left + RAIL_WIDTH).toBeLessThanOrEqual(clipRight);
    }
  });
});
