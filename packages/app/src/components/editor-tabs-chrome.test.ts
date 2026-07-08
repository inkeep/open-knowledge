import { describe, expect, test } from 'bun:test';
import { type CollisionDetection, KeyboardCode, type Modifier } from '@dnd-kit/core';
import {
  createTabReorderModifier,
  DRAGGING_TAB_Z_INDEX,
  getSortableTabClassName,
  getSortableTabKeyDownAction,
  getSortableTabStyle,
  getTabCloseButtonClass,
  getTabCloseButtonTabIndex,
  measureTabReorderBounds,
  shouldActivateSortableTabFromKeyDown,
  TAB_KEYBOARD_DRAG_CODES,
  TAB_REORDER_AUTO_SCROLL,
  type TabReorderBounds,
  tabRunCollisionDetection,
} from './editor-tabs-chrome';

type ModifierArgs = Parameters<Modifier>[0];
type CollisionArgs = Parameters<CollisionDetection>[0];
type SortableTabKeyDownEvent = Parameters<typeof shouldActivateSortableTabFromKeyDown>[0];
type SortableTabKeyDownActionArgs = Parameters<typeof getSortableTabKeyDownAction>[0];

function rect(left: number, width: number, top = 0, height = 20) {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
  };
}

function fakeRootForRects(rects: Array<ReturnType<typeof rect>>): HTMLElement {
  return {
    querySelectorAll: () =>
      rects.map((r) => ({
        getBoundingClientRect: () => r,
      })),
  } as unknown as HTMLElement;
}

function modifierArgs(
  bounds: TabReorderBounds | null,
  x: number,
  y: number,
): { args: ModifierArgs; bounds: TabReorderBounds | null } {
  return {
    args: {
      active: null,
      activeNodeRect: rect(120, 60),
      activatorEvent: null,
      containerNodeRect: null,
      draggingNodeRect: null,
      overlayNodeRect: null,
      over: null,
      scrollableAncestorRects: [],
      scrollableAncestors: [],
      transform: { scaleX: 1, scaleY: 1, x, y },
      windowRect: null,
    },
    bounds,
  };
}

function collisionArgs(pointerX: number): CollisionArgs {
  const droppableContainers = [
    {
      data: { current: undefined },
      disabled: false,
      id: 'tab-a',
      key: 'tab-a',
      node: { current: null },
      rect: { current: null },
    },
    {
      data: { current: undefined },
      disabled: false,
      id: 'tab-b',
      key: 'tab-b',
      node: { current: null },
      rect: { current: null },
    },
  ];

  return {
    active: {
      data: { current: undefined },
      id: 'active-tab',
      rect: { current: { initial: null, translated: null } },
    },
    collisionRect: rect(118, 40),
    droppableContainers,
    droppableRects: new Map([
      ['tab-a', rect(100, 40)],
      ['tab-b', rect(160, 40)],
    ]),
    pointerCoordinates: { x: pointerX, y: 10 },
  };
}

function sortableTabKeyDownEvent(
  code: KeyboardCode,
  targetIsCurrentTarget = true,
): SortableTabKeyDownEvent {
  const currentTarget = {};
  return {
    code,
    currentTarget,
    target: targetIsCurrentTarget ? currentTarget : {},
  };
}

function sortableTabKeyDownActionArgs({
  code,
  defaultPrevented = false,
  hasKeyboardActivation = true,
  isDragging = false,
  targetIsCurrentTarget = true,
}: {
  code: KeyboardCode;
  defaultPrevented?: boolean;
  hasKeyboardActivation?: boolean;
  isDragging?: boolean;
  targetIsCurrentTarget?: boolean;
}): SortableTabKeyDownActionArgs {
  const currentTarget = {};
  return {
    event: {
      code,
      currentTarget,
      defaultPrevented,
      target: targetIsCurrentTarget ? currentTarget : {},
    },
    hasKeyboardActivation,
    isDragging,
  };
}

describe('editor tab chrome helpers', () => {
  test('inactive close controls are hover-only and skipped by tab navigation', () => {
    const className = getTabCloseButtonClass(false);

    expect(className).toContain('opacity-0');
    expect(className).toContain('pointer-events-none');
    expect(className).toContain('group-hover:opacity-100');
    expect(className).toContain('group-hover:pointer-events-auto');
    expect(className).not.toContain('group-focus-within:opacity-100');
    expect(className).not.toContain('focus-visible:opacity-100');
    expect(getTabCloseButtonTabIndex(false)).toBe(-1);
  });

  test('active close controls are visible and keyboard reachable', () => {
    const className = getTabCloseButtonClass(true);

    expect(className).toContain('opacity-100');
    expect(className).not.toContain('opacity-0');
    expect(getTabCloseButtonTabIndex(true)).toBeUndefined();
  });

  test('dragged tabs use active-tab colors even when the source tab was inactive', () => {
    const className = getSortableTabClassName({
      className:
        'bg-transparent hover:bg-muted focus-visible:bg-muted border-transparent text-muted-foreground',
      isDragging: true,
    });

    expect(className).toContain('bg-background');
    expect(className).toContain('hover:bg-background');
    expect(className).toContain('focus-visible:bg-background');
    expect(className).toContain('border-border');
    expect(className).toContain('text-foreground');
    expect(className).not.toContain('bg-transparent');
    expect(className).not.toContain('hover:bg-muted');
    expect(className).not.toContain('focus-visible:bg-muted');
    expect(className).not.toContain('border-transparent');
    expect(className).not.toContain('text-muted-foreground');
  });

  test('non-dragged tabs preserve caller classes', () => {
    expect(
      getSortableTabClassName({
        className: 'bg-transparent border-transparent text-muted-foreground',
        isDragging: false,
      }),
    ).toBe('bg-transparent border-transparent text-muted-foreground');
  });

  test('keyboard drag starts with Space so Enter can activate the focused tab', () => {
    expect(TAB_KEYBOARD_DRAG_CODES.start).toEqual([KeyboardCode.Space]);
    expect(TAB_KEYBOARD_DRAG_CODES.start).not.toContain(KeyboardCode.Enter);
    expect(TAB_KEYBOARD_DRAG_CODES.cancel).toEqual([KeyboardCode.Esc]);
    expect(TAB_KEYBOARD_DRAG_CODES.end).toContain(KeyboardCode.Enter);
  });

  test('sortable tab keyboard activation handles Enter only on the outer tab', () => {
    expect(shouldActivateSortableTabFromKeyDown(sortableTabKeyDownEvent(KeyboardCode.Enter))).toBe(
      true,
    );
    expect(shouldActivateSortableTabFromKeyDown(sortableTabKeyDownEvent(KeyboardCode.Space))).toBe(
      false,
    );
    expect(
      shouldActivateSortableTabFromKeyDown(sortableTabKeyDownEvent(KeyboardCode.Enter, false)),
    ).toBe(false);
  });

  test('sortable tab keydown action activates Enter only before dragging starts', () => {
    expect(
      getSortableTabKeyDownAction(sortableTabKeyDownActionArgs({ code: KeyboardCode.Enter })),
    ).toBe('activate-tab');
    expect(
      getSortableTabKeyDownAction(
        sortableTabKeyDownActionArgs({ code: KeyboardCode.Enter, isDragging: true }),
      ),
    ).toBe('delegate-sortable');
    expect(
      getSortableTabKeyDownAction(
        sortableTabKeyDownActionArgs({ code: KeyboardCode.Enter, hasKeyboardActivation: false }),
      ),
    ).toBe('delegate-sortable');
    expect(
      getSortableTabKeyDownAction(sortableTabKeyDownActionArgs({ code: KeyboardCode.Space })),
    ).toBe('delegate-sortable');
    expect(
      getSortableTabKeyDownAction(
        sortableTabKeyDownActionArgs({
          code: KeyboardCode.Enter,
          targetIsCurrentTarget: false,
        }),
      ),
    ).toBe('delegate-sortable');
  });

  test('sortable tab keydown action ignores caller-prevented events', () => {
    expect(
      getSortableTabKeyDownAction(
        sortableTabKeyDownActionArgs({ code: KeyboardCode.Enter, defaultPrevented: true }),
      ),
    ).toBe('ignore');
  });

  test('tab reorder disables edge auto-scroll so pointer drags stay bounded', () => {
    expect(TAB_REORDER_AUTO_SCROLL).toBe(false);
  });

  test('dragged tab style stays opaque and stacks above sibling tabs', () => {
    const style = getSortableTabStyle({
      isDragging: true,
      outerStyle: { opacity: 0.9, zIndex: 3 },
      transform: { scaleX: 1, scaleY: 1, x: 12, y: 8 },
      transition: 'transform 150ms ease',
    });

    expect(style.opacity).toBe(0.9);
    expect(style.transition).toBe('transform 150ms ease');
    expect(style.zIndex).toBe(DRAGGING_TAB_Z_INDEX);
  });

  test('dragged tab style keeps measured width and removes transform scaling', () => {
    const style = getSortableTabStyle({
      activeWidth: 144,
      isDragging: true,
      transform: { scaleX: 0.5, scaleY: 0.75, x: 12, y: 8 },
      transition: undefined,
    });

    expect(style.width).toBe(144);
    expect(style.minWidth).toBe(144);
    expect(style.maxWidth).toBe(144);
    expect(style.flexBasis).toBe(144);
    expect(style.transform).toBe('translate3d(12px, 8px, 0) scaleX(1) scaleY(1)');
  });

  test('non-dragged tab style preserves caller stacking', () => {
    const style = getSortableTabStyle({
      isDragging: false,
      outerStyle: { opacity: 0.8, zIndex: 7 },
      transform: null,
      transition: undefined,
    });

    expect(style.opacity).toBe(0.8);
    expect(style.zIndex).toBe(7);
  });

  test('measures reorder bounds from sortable tab nodes only', () => {
    const bounds = measureTabReorderBounds(
      fakeRootForRects([rect(80, 40), rect(150, 60)]),
      '[data-editor-tab-sortable]',
    );

    expect(bounds).toEqual({ left: 80, right: 210 });
  });

  test('measureTabReorderBounds returns null without a tab root', () => {
    expect(measureTabReorderBounds(null, '[data-editor-tab-sortable]')).toBeNull();
  });

  test('measureTabReorderBounds returns null when no sortable tab nodes are present', () => {
    expect(measureTabReorderBounds(fakeRootForRects([]), '[data-editor-tab-sortable]')).toBeNull();
  });

  test('horizontal modifier clamps x to measured tab bounds and removes y movement', () => {
    const { args, bounds } = modifierArgs({ left: 100, right: 220 }, 200, 48);
    const clampedRight = createTabReorderModifier(bounds)(args);

    expect(clampedRight.x).toBe(40);
    expect(clampedRight.y).toBe(0);

    const leftInput = modifierArgs({ left: 100, right: 220 }, -100, -24);
    const clampedLeft = createTabReorderModifier(leftInput.bounds)(leftInput.args);

    expect(clampedLeft.x).toBe(-20);
    expect(clampedLeft.y).toBe(0);
  });

  test('horizontal modifier without measured bounds only removes y movement', () => {
    const { args } = modifierArgs(null, 50, 30);
    const result = createTabReorderModifier(null)(args);

    expect(result.x).toBe(50);
    expect(result.y).toBe(0);
  });

  test('collision detection clamps pointer overshoot to the nearest edge tab', () => {
    expect(tabRunCollisionDetection(collisionArgs(90))[0]?.id).toBe('tab-a');
    expect(tabRunCollisionDetection(collisionArgs(210))[0]?.id).toBe('tab-b');
  });

  test('collision detection delegates within the tab run', () => {
    const collisions = tabRunCollisionDetection(collisionArgs(125));

    expect(collisions.length).toBeGreaterThan(0);
    expect(collisions[0]?.id).toBe('tab-a');
  });

  test('collision detection delegates when pointer coordinates are absent for keyboard drag', () => {
    const collisions = tabRunCollisionDetection({
      ...collisionArgs(125),
      pointerCoordinates: null,
    });

    expect(collisions.length).toBeGreaterThan(0);
    expect(collisions[0]?.id).toBe('tab-a');
  });
});
