import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { MASCOT_OUTLINE_PATH } from './mascot-outline';
import {
  buildMorphedPath,
  buildShapeLibrary,
  EYE_OFFSET_Y,
  ease,
  FALLBACK_SKIN_PATH,
  FALLBACK_STROKE_WIDTH,
  morphFrameAt,
  POSE_SEQUENCE,
  SHAPE,
  toMorphSource,
} from './working-avatar-shapes';

describe('morphFrameAt', () => {
  const SEQ = 4;
  const DUR = 8;

  test('starts on the first segment with zero progress', () => {
    expect(morphFrameAt(0, SEQ, DUR, false)).toEqual({ from: 0, to: 1, t: 0 });
  });

  test('walks segments in order across the cycle', () => {
    expect(morphFrameAt(2.5, SEQ, DUR, false).from).toBe(0);
    expect(morphFrameAt(3, SEQ, DUR, false).from).toBe(1);
    expect(morphFrameAt(6, SEQ, DUR, false).from).toBe(2);
    expect(morphFrameAt(6, SEQ, DUR, false).to).toBe(3);
  });

  test('wraps at the cycle boundary rather than running off the end', () => {
    expect(morphFrameAt(DUR, SEQ, DUR, false)).toEqual(morphFrameAt(0, SEQ, DUR, false));
    expect(morphFrameAt(DUR * 3 + 1, SEQ, DUR, false)).toEqual(morphFrameAt(1, SEQ, DUR, false));
  });

  test('never indexes past the last pose', () => {
    // The final instant of the cycle still has to name a valid `to`.
    const frame = morphFrameAt(DUR - 1e-9, SEQ, DUR, false);
    expect(frame.to).toBeLessThanOrEqual(SEQ - 1);
  });

  test('hold finishes the morph early and then sits still', () => {
    const segment = DUR / (SEQ - 1);
    // 58% of the segment is the whole morph; everything after it is the beat.
    expect(morphFrameAt(segment * 0.58, SEQ, DUR, true).t).toBe(1);
    expect(morphFrameAt(segment * 0.9, SEQ, DUR, true).t).toBe(1);
    // Without hold the same instant is still mid-morph.
    expect(morphFrameAt(segment * 0.9, SEQ, DUR, false).t).toBeLessThan(1);
  });
});

describe('ease', () => {
  test('is pinned at both ends and symmetric about the midpoint', () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeCloseTo(0.5, 10);
    expect(ease(0.25) + ease(0.75)).toBeCloseTo(1, 10);
  });
});

describe('POSE_SEQUENCE', () => {
  test('starts and ends at home so the loop closes seamlessly', () => {
    expect(POSE_SEQUENCE[0]).toBe(SHAPE.blobby);
    expect(POSE_SEQUENCE.at(-1)).toBe(SHAPE.blobby);
  });

  test('only names poses the library actually builds', () => {
    // Which poses are in the sequence is a design choice and free to change;
    // naming one the library never builds would blank the mascot mid-cycle.
    const built = Object.values(SHAPE);
    for (const pose of POSE_SEQUENCE) expect(built).toContain(pose);
  });

  test('every pose carrying an eye offset lifts the face rather than dropping it', () => {
    // The offsets exist for bodies that sit high (the comma). A positive value
    // would push the eyes down off the shape instead.
    for (const offset of Object.values(EYE_OFFSET_Y)) expect(offset).toBeLessThan(0);
  });
});

describe('morph source', () => {
  // Two hand-built paths with identical command structure — the precondition
  // every generated shape has to satisfy for lerping to be meaningful.
  const A = 'M1.00 2.00C3.00 4.00 5.00 6.00 7.00 8.00Z';
  const B = 'M3.00 4.00C5.00 6.00 7.00 8.00 9.00 10.00Z';

  test('splits a path into shared command fragments plus its numbers', () => {
    const source = toMorphSource([A, B]);
    expect(source.numbers[0]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(source.numbers[1]).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test('rebuilds the original path when handed the original numbers', () => {
    const source = toMorphSource([A, B]);
    expect(buildMorphedPath(source.fragments, source.numbers[0])).toBe(A);
  });

  test('a half-way lerp lands half-way between the two shapes', () => {
    const source = toMorphSource([A, B]);
    const mid = source.numbers[0].map((n, i) => n + (source.numbers[1][i] - n) * 0.5);
    expect(buildMorphedPath(source.fragments, mid)).toBe(
      'M2.00 3.00C4.00 5.00 6.00 7.00 8.00 9.00Z',
    );
  });
});

describe('buildShapeLibrary', () => {
  // Node has no SVG path measurement, which is exactly the degraded path the
  // component has to survive — it renders the static pose instead.
  test('reports unavailability rather than throwing when paths cannot be measured', () => {
    expect(buildShapeLibrary()).toBeNull();
  });

  test('the static fallback pose is a closed path the morph engine can parse', () => {
    const source = toMorphSource([FALLBACK_SKIN_PATH]);
    expect(FALLBACK_SKIN_PATH.endsWith('Z')).toBe(true);
    // 40 cubic segments (6 numbers each) plus the opening moveto pair.
    expect(source.numbers[0]).toHaveLength(40 * 6 + 2);
  });
});

describe('frozen fallback pose', () => {
  /**
   * `FALLBACK_SKIN_PATH` is `buildShapeLibrary().paths[SHAPE.blobby]` captured by
   * hand, and nothing can recompute it here — the generator needs
   * `getPointAtLength`, which neither Node nor jsdom implements. So this pins
   * its dominant input instead: retracing the mascot silently desynchronises the
   * frozen pose, and reduced-motion users (who only ever see the frozen pose)
   * would get a shape that no longer matches the live mascot.
   *
   * This is a tripwire, not an equality check. It catches "the outline moved and
   * nobody regenerated"; it cannot catch a hand-corrupted constant.
   */
  test('the outline the fallback pose was traced from has not moved', () => {
    const digest = createHash('sha256').update(MASCOT_OUTLINE_PATH).digest('hex').slice(0, 16);
    expect(
      digest,
      'MASCOT_OUTLINE_PATH changed. Regenerate FALLBACK_SKIN_PATH and FALLBACK_STROKE_WIDTH ' +
        'by running buildShapeLibrary() in a browser and taking paths[SHAPE.blobby] and ' +
        'strokeWidth, then update this digest.',
    ).toBe('abc881bcf4959fe4');
  });

  test('the fallback stroke width is the weight the pose was traced at', () => {
    // Both constants are regenerated together; a lone edit to one is drift.
    expect(FALLBACK_STROKE_WIDTH).toBeCloseTo(2.26, 2);
  });
});
