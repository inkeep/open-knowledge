import { describe, expect, test } from 'vitest';
import { changedRangeIsOnScreen } from './agent-follow-scroll';

const REGION = { top: 56, bottom: 700 };

describe('changedRangeIsOnScreen', () => {
  test('a change spanning past both edges of the region is on screen', () => {
    expect(changedRangeIsOnScreen({ top: -12_000, bottom: 20_000 }, REGION)).toBe(true);
  });

  test('a whole-document change is on screen while the reader sits at the top', () => {
    expect(changedRangeIsOnScreen({ top: 60, bottom: 20_000 }, REGION)).toBe(true);
  });

  test('a change resting fully inside the region is on screen', () => {
    expect(changedRangeIsOnScreen({ top: 100, bottom: 140 }, REGION)).toBe(true);
  });

  test('a change below the region is not on screen', () => {
    expect(changedRangeIsOnScreen({ top: 20_000, bottom: 20_050 }, REGION)).toBe(false);
  });

  test('a change above the region is not on screen', () => {
    expect(changedRangeIsOnScreen({ top: -900, bottom: -850 }, REGION)).toBe(false);
  });

  test('a change hidden behind the toolbar band is not on screen', () => {
    expect(changedRangeIsOnScreen({ top: 10, bottom: 50 }, REGION)).toBe(false);
  });

  test('a change hidden behind the composer band is not on screen', () => {
    expect(changedRangeIsOnScreen({ top: 720, bottom: 760 }, REGION)).toBe(false);
  });

  test('a change straddling the toolbar edge is on screen', () => {
    expect(changedRangeIsOnScreen({ top: 20, bottom: 80 }, REGION)).toBe(true);
  });

  test('a change straddling the composer edge is on screen', () => {
    expect(changedRangeIsOnScreen({ top: 680, bottom: 740 }, REGION)).toBe(true);
  });

  test('a region starting at the viewport top still excludes content above it', () => {
    expect(changedRangeIsOnScreen({ top: -40, bottom: -10 }, { top: 0, bottom: 700 })).toBe(false);
  });

  test('a collapsed band stands down only for a range that straddles it', () => {
    const collapsed = { top: 300, bottom: 300 };
    expect(changedRangeIsOnScreen({ top: 280, bottom: 320 }, collapsed)).toBe(true);
    expect(changedRangeIsOnScreen({ top: 400, bottom: 450 }, collapsed)).toBe(false);
    expect(changedRangeIsOnScreen({ top: 100, bottom: 150 }, collapsed)).toBe(false);
  });

  test('unmeasurable geometry reports on-screen so the reader is never yanked on a guess', () => {
    expect(changedRangeIsOnScreen({ top: Number.NaN, bottom: Number.NaN }, REGION)).toBe(true);
    expect(changedRangeIsOnScreen({ top: 0, bottom: Number.POSITIVE_INFINITY }, REGION)).toBe(true);
  });
});
