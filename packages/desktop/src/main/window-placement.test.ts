import { describe, expect, test } from 'vitest';
import type { PersistedWindowBounds, RestoredWindow } from './state-store.ts';
import {
  MIN_VISIBLE_WIDTH_PX,
  resolveRestoredPlacement,
  sortWindowsByFocusSequence,
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
    const placement = resolveRestoredPlacement({
      saved: bounds({ x: 2200, y: 60 }),
      workAreas: [PRIMARY],
      minSize: MIN_SIZE,
    });
    expect(placement).toBeNull();
  });

  test('sliver overlap below the visibility floor → null', () => {
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

describe('sortWindowsByFocusSequence', () => {
  const proj = (projectPath: string): RestoredWindow => ({ kind: 'project', projectPath });
  const file = (filePath: string): RestoredWindow => ({ kind: 'file', filePath });

  test('orders least → most recently focused, across projects and loose files', () => {
    const seq = new Map([
      ['/a', 3],
      ['/notes/todo.md', 9],
      ['/c', 5],
    ]);
    expect(
      sortWindowsByFocusSequence([proj('/a'), file('/notes/todo.md'), proj('/c')], seq),
    ).toEqual([proj('/a'), proj('/c'), file('/notes/todo.md')]);
  });

  test('never-focused windows sort first, preserving relative order', () => {
    const seq = new Map([['/focused', 4]]);
    expect(sortWindowsByFocusSequence([proj('/x'), proj('/focused'), file('/y.md')], seq)).toEqual([
      proj('/x'),
      file('/y.md'),
      proj('/focused'),
    ]);
  });

  test('does not mutate the input', () => {
    const windows = [proj('/b'), proj('/a')];
    sortWindowsByFocusSequence(
      windows,
      new Map([
        ['/a', 1],
        ['/b', 2],
      ]),
    );
    expect(windows).toEqual([proj('/b'), proj('/a')]);
  });

  test('empty input → empty output', () => {
    expect(sortWindowsByFocusSequence([], new Map())).toEqual([]);
  });
});
