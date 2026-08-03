/**
 * Where a comment marker lands on the rail.
 *
 * The bug this replaces: markers were positioned by document FRACTION
 * (`range.from / doc.size`) against the scroll container's box. That container
 * also holds the cover and the frontmatter table, which ProseMirror knows
 * nothing about — so on a doc with a tall properties block every marker floated
 * hundreds of pixels above the text it pointed at. Positions now come from the
 * text's own viewport coords; these cover what the layout does with them.
 */

import { describe, expect, test } from 'vitest';
import { layoutMarkers, railBand } from './CommentMarginRail';

const RAIL_TOP = 100;
const RAIL_HEIGHT = 600; // visible band: 100 → 700
const ICON_H = 30;

describe('layoutMarkers', () => {
  test('centers a marker on the line it belongs to', () => {
    const [marker] = layoutMarkers([{ id: 'a', y: 400 }], RAIL_TOP, RAIL_HEIGHT);
    // Centered, not hanging below the baseline.
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
    // The first still sits where its line is; only the crowded ones move.
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
    // Flagged so the UI can dim it — parked at the edge, not pointing at a line.
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

/**
 * The second bug: the rail ran the full height of the scrollport, but the
 * scrollport reaches up under the editor toolbar, whose buttons are flush
 * against the same right edge. Anything clamped to the top — every comment
 * scrolled above the viewport — piled onto those buttons.
 */
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
    // 130 is inside the scrollport's box but under the toolbar.
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
