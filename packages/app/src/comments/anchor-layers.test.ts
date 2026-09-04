import { describe, expect, it } from 'vitest';
import { buildAnchorSegments, COMMENT_HUE, type PlacedAnchor } from './anchor-layers';

const at = (id: string | null, from: number, to: number): PlacedAnchor => ({ id, from, to });

const ACTIVE_FILL = `rgba(${COMMENT_HUE},0.45)`;
const RESTING =
  `border-radius:2px;padding-bottom:1px;cursor:pointer;background-color:rgba(${COMMENT_HUE},0.22);` +
  `box-shadow:inset 0 -2px 0 rgba(${COMMENT_HUE},0.7);`;
const ACTIVE =
  `border-radius:2px;padding-bottom:1px;cursor:pointer;background-color:${ACTIVE_FILL};` +
  `box-shadow:inset 0 -2px 0 rgba(${COMMENT_HUE},1);`;

describe('buildAnchorSegments', () => {
  it('leaves a lone unattended highlight on its original style', () => {
    expect(buildAnchorSegments([at('t1', 4, 12)])).toEqual([
      { from: 4, to: 12, threadId: 't1', style: RESTING },
    ]);
  });

  it('deepens the active thread and leaves the rest resting', () => {
    const segments = buildAnchorSegments([at('t1', 0, 5), at('t2', 9, 14)], 't2');
    expect(segments[0].style).toBe(RESTING);
    expect(segments[1].style).toBe(ACTIVE);
  });

  it('splits overlapping highlights into three segments', () => {
    const segments = buildAnchorSegments([at('t1', 0, 10), at('t2', 6, 16)]);
    expect(segments.map((s) => [s.from, s.to])).toEqual([
      [0, 6],
      [6, 10],
      [10, 16],
    ]);
  });

  it('gives the shared span to the active thread, not to whoever came last', () => {
    const placed = [at('t1', 0, 10), at('t2', 6, 16)];
    expect(buildAnchorSegments(placed, 't1').map((s) => s.style)).toEqual([
      ACTIVE,
      ACTIVE,
      RESTING,
    ]);
    expect(buildAnchorSegments(placed, 't2').map((s) => s.style)).toEqual([
      RESTING,
      ACTIVE,
      ACTIVE,
    ]);
  });

  it('reads as one unbroken wash when nothing is active', () => {
    const styles = buildAnchorSegments([at('t1', 0, 10), at('t2', 6, 16)]).map((s) => s.style);
    expect(new Set(styles).size).toBe(1);
  });

  it('separates the active thread nested inside a wider one', () => {
    const segments = buildAnchorSegments([at('wide', 0, 30), at('narrow', 10, 20)], 'narrow');
    expect(segments.map((s) => s.style)).toEqual([RESTING, ACTIVE, RESTING]);
  });

  it('opens the narrower comment where two overlap', () => {
    const [, shared] = buildAnchorSegments([at('wide', 0, 20), at('narrow', 6, 10)]);
    expect(shared.threadId).toBe('narrow');
  });

  it('treats the composer draft as active and drops the pointer cursor', () => {
    const [segment] = buildAnchorSegments([at(null, 0, 8)]);
    expect(segment.threadId).toBeNull();
    expect(segment.style).not.toContain('cursor:pointer');
    expect(segment.style).toContain(ACTIVE_FILL);
  });

  it('stands the draft out from the comment it overlaps', () => {
    const segments = buildAnchorSegments([at('t1', 0, 10), at(null, 6, 16)]);
    expect(segments[0].style).toBe(RESTING);
    expect(segments[1].style).toContain(ACTIVE_FILL);
    expect(segments[2].threadId).toBeNull();
  });

  it('drops empty and orphaned ranges', () => {
    expect(buildAnchorSegments([])).toEqual([]);
    expect(buildAnchorSegments([at('t1', 5, 5)])).toEqual([]);
  });

  it('ignores an active id that is not on this document', () => {
    const segments = buildAnchorSegments([at('t1', 0, 10)], 'elsewhere');
    expect(segments[0].style).toBe(RESTING);
  });

  it('does not split a range the active thread covers end to end', () => {
    const segments = buildAnchorSegments([at('t1', 0, 30), at('t2', 10, 20)], 't1');
    expect(segments.map((s) => [s.from, s.to])).toEqual([
      [0, 10],
      [10, 20],
      [20, 30],
    ]);
    expect(new Set(segments.map((s) => s.style)).size).toBe(1);
  });

  it('is stable regardless of the order the store lists threads in', () => {
    const forward = buildAnchorSegments([at('t1', 0, 10), at('t2', 6, 16)], 't1');
    const reversed = buildAnchorSegments([at('t2', 6, 16), at('t1', 0, 10)], 't1');
    expect(reversed).toEqual(forward);
  });
});
