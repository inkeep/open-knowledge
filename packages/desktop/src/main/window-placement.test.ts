import { describe, expect, test } from 'bun:test';
import type { PersistedWindowBounds } from './state-store.ts';
import {
  MIN_VISIBLE_WIDTH_PX,
  resolveRestoredPlacement,
  sortByFocusSequence,
  TITLE_BAR_REACH_PX,
} from './window-placement.ts';

const MIN_SIZE = { width: 720, height: 480 };
const PRIMARY = { x: 0, y: 25, width: 1920, height: 1055 };
const SECONDARY_RIGHT = { x: 1920, y: 0, width: 2560, height: 1415 };

function bounds(overrides: Partial<PersistedWindowBounds> = {}): PersistedWindowBounds {
  return {
    x: 320,
    y: 152,
    width: 1280,
    height: 800,
    isMaximized: false,
    isFullScreen: false,
    ...overrides,
  };
}

describe('resolveRestoredPlacement', () => {
  test('no saved bounds → null (cascade fallback)', () => {
    expect(
      resolveRestoredPlacement({ saved: undefined, workAreas: [PRIMARY], minSize: MIN_SIZE }),
    ).toBeNull();
  });

  test('saved frame fully inside a display restores verbatim', () => {
    const placement = resolveRestoredPlacement({
      saved: bounds(),
      workAreas: [PRIMARY],
      minSize: MIN_SIZE,
    });
    expect(placement).toEqual({
      bounds: { x: 320, y: 152, width: 1280, height: 800 },
      maximize: false,
      fullscreen: false,
    });
  });

  test('frame on a secondary display restores there (multi-monitor)', () => {
    const placement = resolveRestoredPlacement({
      saved: bounds({ x: 2200, y: 60 }),
      workAreas: [PRIMARY, SECONDARY_RIGHT],
      minSize: MIN_SIZE,
    });
    expect(placement?.bounds).toEqual({ x: 2200, y: 60, width: 1280, height: 800 });
  });

  test('frame on an unplugged display → null (cascade fallback)', () => {
    // Saved while a display sat to the right; now only the primary remains
    // and the frame starts past its right edge.
    const placement = resolveRestoredPlacement({
      saved: bounds({ x: 2200, y: 60 }),
      workAreas: [PRIMARY],
      minSize: MIN_SIZE,
    });
    expect(placement).toBeNull();
  });

  test('sliver overlap below the visibility floor → null', () => {
    // Only (MIN_VISIBLE_WIDTH_PX - 1) px of the frame clips the display.
    const placement = resolveRestoredPlacement({
      saved: bounds({ x: PRIMARY.x + PRIMARY.width - (MIN_VISIBLE_WIDTH_PX - 1) }),
      workAreas: [PRIMARY],
      minSize: MIN_SIZE,
    });
    expect(placement).toBeNull();
  });

  test('title bar above the work area top → null (unreachable drag handle)', () => {
    const placement = resolveRestoredPlacement({
      saved: bounds({ y: PRIMARY.y - 1 }),
      workAreas: [PRIMARY],
      minSize: MIN_SIZE,
    });
    expect(placement).toBeNull();
  });

  test('title bar below the reachable strip at the bottom → null', () => {
    const placement = resolveRestoredPlacement({
      saved: bounds({ y: PRIMARY.y + PRIMARY.height - (TITLE_BAR_REACH_PX - 1) }),
      workAreas: [PRIMARY],
      minSize: MIN_SIZE,
    });
    expect(placement).toBeNull();
  });

  test('sub-minimum saved size clamps up to the window class floor', () => {
    const placement = resolveRestoredPlacement({
      saved: bounds({ width: 200, height: 100 }),
      workAreas: [PRIMARY],
      minSize: MIN_SIZE,
    });
    expect(placement?.bounds.width).toBe(MIN_SIZE.width);
    expect(placement?.bounds.height).toBe(MIN_SIZE.height);
  });

  test('maximize / fullscreen flags pass through', () => {
    expect(
      resolveRestoredPlacement({
        saved: bounds({ isMaximized: true }),
        workAreas: [PRIMARY],
        minSize: MIN_SIZE,
      })?.maximize,
    ).toBe(true);
    expect(
      resolveRestoredPlacement({
        saved: bounds({ isFullScreen: true }),
        workAreas: [PRIMARY],
        minSize: MIN_SIZE,
      })?.fullscreen,
    ).toBe(true);
  });

  test('negative coordinates on a display arranged left/above restore fine', () => {
    const LEFT_DISPLAY = { x: -1920, y: -500, width: 1920, height: 1080 };
    const placement = resolveRestoredPlacement({
      saved: bounds({ x: -1600, y: -400 }),
      workAreas: [LEFT_DISPLAY, PRIMARY],
      minSize: MIN_SIZE,
    });
    expect(placement?.bounds).toEqual({ x: -1600, y: -400, width: 1280, height: 800 });
  });
});

describe('sortByFocusSequence', () => {
  test('orders least → most recently focused', () => {
    const seq = new Map([
      ['/a', 3],
      ['/b', 9],
      ['/c', 5],
    ]);
    expect(sortByFocusSequence(['/a', '/b', '/c'], seq)).toEqual(['/a', '/c', '/b']);
  });

  test('never-focused paths sort first, preserving relative order', () => {
    const seq = new Map([['/focused', 4]]);
    expect(sortByFocusSequence(['/x', '/focused', '/y'], seq)).toEqual(['/x', '/y', '/focused']);
  });

  test('does not mutate the input', () => {
    const paths = ['/b', '/a'];
    sortByFocusSequence(
      paths,
      new Map([
        ['/a', 1],
        ['/b', 2],
      ]),
    );
    expect(paths).toEqual(['/b', '/a']);
  });

  test('empty input → empty output', () => {
    expect(sortByFocusSequence([], new Map())).toEqual([]);
  });
});
