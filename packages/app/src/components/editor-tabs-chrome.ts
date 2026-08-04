import type { CollisionDetection, KeyboardCodes, Modifier } from '@dnd-kit/core';
import { closestCenter, KeyboardCode } from '@dnd-kit/core';
import { CSS, type Transform } from '@dnd-kit/utilities';
import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';

type TabDroppableContainer = Parameters<CollisionDetection>[0]['droppableContainers'][number];
type SortableTabKeyDownEvent = Pick<KeyboardEvent, 'code' | 'currentTarget' | 'target'>;
type SortableTabKeyDownDecisionEvent = SortableTabKeyDownEvent &
  Pick<KeyboardEvent, 'defaultPrevented'>;
type TabContextMenuKeyDownEvent = Pick<KeyboardEvent, 'key' | 'shiftKey'>;
type SortableTabKeyDownAction = 'activate-tab' | 'delegate-sortable' | 'ignore';

export interface EditorTabDragData {
  kind: 'editor-tab';
  paneId: string;
  tabId: string;
  splittable: boolean;
  label: string;
}

interface PaneEdgeDropData {
  kind: 'pane-edge';
  paneId: string;
  side: 'left' | 'right';
}

interface PaneStripDropData {
  kind: 'pane-strip';
  paneId: string;
  index: number;
}

export type EditorTabDropData = PaneEdgeDropData | PaneStripDropData;

const TAB_CLOSE_BUTTON_CLASS =
  'flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-foreground/10 hover:text-foreground hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50';
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
      ? 'mr-1 opacity-100'
      : 'pointer-events-none absolute right-1 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100',
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

export function shouldOpenTabContextMenu(event: TabContextMenuKeyDownEvent): boolean {
  return event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
}

export function findEditorTabElement(
  root: ParentNode,
  paneId: string,
  tabId: string,
): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>('[data-editor-tab-id]')) {
    if (element.dataset.editorPaneId === paneId && element.dataset.editorTabId === tabId) {
      return element;
    }
  }
  return null;
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
  disableMovement = false,
  isDragging,
  outerStyle,
  transform,
  transition,
}: {
  activeWidth?: number | null;
  disableMovement?: boolean;
  isDragging: boolean;
  outerStyle?: CSSProperties;
  transform: Transform | null;
  transition: string | undefined;
}): CSSProperties {
  const stableWidth = isDragging && activeWidth ? activeWidth : undefined;
  return {
    ...outerStyle,
    transform: disableMovement
      ? undefined
      : CSS.Transform.toString(transform ? { ...transform, scaleX: 1, scaleY: 1 } : null),
    transition: disableMovement ? undefined : transition,
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

export function isEditorTabDragData(value: unknown): value is EditorTabDragData {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as Partial<EditorTabDragData>;
  return (
    data.kind === 'editor-tab' &&
    typeof data.paneId === 'string' &&
    typeof data.tabId === 'string' &&
    typeof data.splittable === 'boolean' &&
    typeof data.label === 'string'
  );
}

export function isEditorTabDropData(value: unknown): value is EditorTabDropData {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as Partial<EditorTabDropData>;
  if (data.kind === 'pane-edge') {
    return typeof data.paneId === 'string' && (data.side === 'left' || data.side === 'right');
  }
  return (
    data.kind === 'pane-strip' &&
    typeof data.paneId === 'string' &&
    typeof data.index === 'number' &&
    Number.isInteger(data.index)
  );
}

function pointerIsInsideRect(
  pointer: { x: number; y: number },
  rect: { top: number; right: number; bottom: number; left: number },
): boolean {
  return (
    pointer.x >= rect.left &&
    pointer.x <= rect.right &&
    pointer.y >= rect.top &&
    pointer.y <= rect.bottom
  );
}

function rectsOverlap(
  first: { top: number; right: number; bottom: number; left: number },
  second: { top: number; right: number; bottom: number; left: number },
): boolean {
  return (
    first.left < second.right &&
    first.right > second.left &&
    first.top < second.bottom &&
    first.bottom > second.top
  );
}

export const editorWorkspaceCollisionDetection: CollisionDetection = (args) => {
  const edgeContainers = args.droppableContainers.filter(
    (container) => container.data.current?.kind === 'pane-edge',
  );
  const tabAndStripContainers = args.droppableContainers.filter(
    (container) => container.data.current?.kind !== 'pane-edge',
  );
  const activeData = args.active.data.current;

  const pointerCoordinates = args.pointerCoordinates;
  if (pointerCoordinates && isEditorTabDragData(activeData) && activeData.splittable) {
    const edge = edgeContainers.find((container) => {
      const rect = args.droppableRects.get(container.id);
      return rect ? pointerIsInsideRect(pointerCoordinates, rect) : false;
    });
    if (edge) {
      return [{ id: edge.id, data: { droppableContainer: edge, value: 0 } }];
    }
  }

  if (pointerCoordinates) {
    const pointerHitContainers = tabAndStripContainers.filter((container) => {
      const rect = args.droppableRects.get(container.id);
      return rect ? pointerIsInsideRect(pointerCoordinates, rect) : false;
    });
    if (pointerHitContainers.length > 0) {
      const pointerHitTabs = pointerHitContainers.filter((container) =>
        isEditorTabDragData(container.data.current),
      );
      return closestCenter({
        ...args,
        droppableContainers: pointerHitTabs.length > 0 ? pointerHitTabs : pointerHitContainers,
      });
    }

    const overlappingStrips = tabAndStripContainers.filter((container) => {
      const data = container.data.current;
      const rect = args.droppableRects.get(container.id);
      if (data?.kind !== 'pane-strip' || !rect) return false;
      return rectsOverlap(args.collisionRect, rect);
    });
    if (overlappingStrips.length === 0) return [];

    const paneIds = new Set(overlappingStrips.map((container) => container.data.current?.paneId));
    const overlappingTabs = tabAndStripContainers.filter((container) => {
      const data = container.data.current;
      const rect = args.droppableRects.get(container.id);
      if (!isEditorTabDragData(data) || !paneIds.has(data.paneId) || !rect) return false;
      return rectsOverlap(args.collisionRect, rect);
    });
    return closestCenter({
      ...args,
      droppableContainers: overlappingTabs.length > 0 ? overlappingTabs : overlappingStrips,
    });
  }

  return closestCenter({
    ...args,
    droppableContainers: tabAndStripContainers,
  });
};

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
