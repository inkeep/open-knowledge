import type { CollisionDetection, KeyboardCodes, Modifier } from '@dnd-kit/core';
import { closestCenter, KeyboardCode } from '@dnd-kit/core';
import { CSS, type Transform } from '@dnd-kit/utilities';
import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';

type TabDroppableContainer = Parameters<CollisionDetection>[0]['droppableContainers'][number];
type SortableTabKeyDownEvent = Pick<KeyboardEvent, 'code' | 'currentTarget' | 'target'>;
type SortableTabKeyDownDecisionEvent = SortableTabKeyDownEvent &
  Pick<KeyboardEvent, 'defaultPrevented'>;
type SortableTabKeyDownAction = 'activate-tab' | 'delegate-sortable' | 'ignore';

const TAB_CLOSE_BUTTON_CLASS =
  'mr-1.5 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none transition hover:bg-foreground/10 hover:text-foreground hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50';
const DRAGGING_TAB_ACTIVE_CLASS =
  'border-border bg-background text-foreground hover:bg-background focus-visible:bg-background';
export const DRAGGING_TAB_Z_INDEX = 20;
export const TAB_REORDER_AUTO_SCROLL = false;
export const TAB_KEYBOARD_DRAG_CODES = {
  start: [KeyboardCode.Space],
  cancel: [KeyboardCode.Esc],
  end: [KeyboardCode.Space, KeyboardCode.Enter],
} satisfies KeyboardCodes;

export interface TabReorderBounds {
  left: number;
  right: number;
}

export function getTabCloseButtonClass(isActive: boolean): string {
  return cn(
    TAB_CLOSE_BUTTON_CLASS,
    isActive
      ? 'opacity-100'
      : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100',
  );
}

export function getTabCloseButtonTabIndex(isActive: boolean): -1 | undefined {
  return isActive ? undefined : -1;
}

export function getSortableTabClassName({
  className,
  isDragging,
}: {
  className?: string;
  isDragging: boolean;
}): string {
  return cn(className, isDragging && DRAGGING_TAB_ACTIVE_CLASS);
}

export function shouldActivateSortableTabFromKeyDown(event: SortableTabKeyDownEvent): boolean {
  return event.code === KeyboardCode.Enter && event.target === event.currentTarget;
}

export function getSortableTabKeyDownAction({
  event,
  hasKeyboardActivation,
  isDragging,
}: {
  event: SortableTabKeyDownDecisionEvent;
  hasKeyboardActivation: boolean;
  isDragging: boolean;
}): SortableTabKeyDownAction {
  if (event.defaultPrevented) return 'ignore';
  if (!isDragging && hasKeyboardActivation && shouldActivateSortableTabFromKeyDown(event)) {
    return 'activate-tab';
  }
  return 'delegate-sortable';
}

export function getSortableTabStyle({
  activeWidth,
  isDragging,
  outerStyle,
  transform,
  transition,
}: {
  activeWidth?: number | null;
  isDragging: boolean;
  outerStyle?: CSSProperties;
  transform: Transform | null;
  transition: string | undefined;
}): CSSProperties {
  const stableWidth = isDragging && activeWidth ? activeWidth : undefined;
  return {
    ...outerStyle,
    transform: CSS.Transform.toString(transform ? { ...transform, scaleX: 1, scaleY: 1 } : null),
    transition,
    flexBasis: stableWidth ?? outerStyle?.flexBasis,
    maxWidth: stableWidth ?? outerStyle?.maxWidth,
    minWidth: stableWidth ?? outerStyle?.minWidth,
    opacity: outerStyle?.opacity,
    width: stableWidth ?? outerStyle?.width,
    zIndex: isDragging ? DRAGGING_TAB_Z_INDEX : outerStyle?.zIndex,
  };
}

export function measureTabReorderBounds(
  root: HTMLElement | null,
  // Surface-neutral: each consumer passes the attribute selector marking its own
  // sortable tab nodes (editor tabs vs terminal tabs), so this geometry helper is
  // not tied to one strip.
  sortableSelector: string,
): TabReorderBounds | null {
  const tabNodes = root?.querySelectorAll<HTMLElement>(sortableSelector) ?? [];
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;

  for (const tabNode of tabNodes) {
    const rect = tabNode.getBoundingClientRect();
    left = Math.min(left, rect.left);
    right = Math.max(right, rect.right);
  }

  return Number.isFinite(left) && Number.isFinite(right) ? { left, right } : null;
}

export function createTabReorderModifier(bounds: TabReorderBounds | null): Modifier {
  return ({ activeNodeRect, transform }) => {
    const next = { ...transform, y: 0 };
    if (!bounds || !activeNodeRect) return next;

    const minX = bounds.left - activeNodeRect.left;
    const maxX = bounds.right - activeNodeRect.right;
    next.x = Math.min(Math.max(next.x, minX), maxX);
    return next;
  };
}

export const tabRunCollisionDetection: CollisionDetection = (args) => {
  const { droppableContainers, droppableRects, pointerCoordinates } = args;
  if (pointerCoordinates) {
    let left = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let leftContainer: TabDroppableContainer | null = null;
    let rightContainer: TabDroppableContainer | null = null;

    for (const container of droppableContainers) {
      const rect = droppableRects.get(container.id);
      if (!rect) continue;
      if (rect.left < left) {
        left = rect.left;
        leftContainer = container;
      }
      if (rect.right > right) {
        right = rect.right;
        rightContainer = container;
      }
    }

    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      return [];
    }
    const edgeContainer =
      pointerCoordinates.x < left
        ? leftContainer
        : pointerCoordinates.x > right
          ? rightContainer
          : null;
    if (edgeContainer)
      return [{ id: edgeContainer.id, data: { droppableContainer: edgeContainer, value: 0 } }];
  }

  return closestCenter(args);
};
