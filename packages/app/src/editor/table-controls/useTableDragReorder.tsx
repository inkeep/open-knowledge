import type { Node as PmNode, ResolvedPos } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/react';
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';

type Axis = 'row' | 'column';

const DRAG_THRESHOLD_PX = 5;

const FIRST_MOVABLE_ROW_INDEX = 1;

interface UseTableDragReorderOptions {
  editor: Editor;
  axis: Axis;
  anchor: HTMLTableCellElement;
  onClickGesture: () => void;
}

interface DragTarget {
  index: number;
  rect: { left: number; top: number; width: number; height: number };
}

export interface UseTableDragReorderResult {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  shouldAllowOpen: (nextOpen: boolean) => boolean;
  isDragging: boolean;
  indicator: DragTarget | null;
}

export function useTableDragReorder({
  editor,
  axis,
  anchor,
  onClickGesture,
}: UseTableDragReorderOptions): UseTableDragReorderResult {
  const pendingDragRef = useRef<{
    startX: number;
    startY: number;
    isDragging: boolean;
    lastTarget: DragTarget | null;
  } | null>(null);

  const controllerRef = useRef<AbortController | null>(null);

  const onClickGestureRef = useRef(onClickGesture);
  useEffect(() => {
    onClickGestureRef.current = onClickGesture;
  }, [onClickGesture]);

  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      pendingDragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  const [isDragging, setIsDragging] = useState(false);
  const [indicator, setIndicator] = useState<DragTarget | null>(null);

  const shouldAllowOpen = (nextOpen: boolean): boolean => {
    if (nextOpen && pendingDragRef.current !== null) return false;
    return true;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;

    controllerRef.current?.abort();

    pendingDragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      isDragging: false,
      lastTarget: null,
    };

    const controller = new AbortController();
    controllerRef.current = controller;
    const { signal } = controller;

    const onMove = (moveEvent: PointerEvent): void => {
      const drag = pendingDragRef.current;
      if (!drag) return;

      if (!drag.isDragging) {
        const dx = moveEvent.clientX - drag.startX;
        const dy = moveEvent.clientY - drag.startY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        drag.isDragging = true;
        setIsDragging(true);
        document.body.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';
      }

      const target = computeDragTarget(anchor, axis, moveEvent.clientX, moveEvent.clientY);
      drag.lastTarget = target;
      setIndicator(target);
    };

    const onUp = (): void => {
      controller.abort();
      if (controllerRef.current === controller) controllerRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      const drag = pendingDragRef.current;
      pendingDragRef.current = null;
      setIsDragging(false);
      setIndicator(null);

      if (!drag) return;
      if (drag.isDragging && drag.lastTarget) {
        commitReorder(editor, anchor, axis, drag.lastTarget.index);
      } else if (!drag.isDragging) {
        onClickGestureRef.current();
      }
    };

    document.addEventListener('pointermove', onMove, { signal });
    document.addEventListener('pointerup', onUp, { signal });
    document.addEventListener('pointercancel', onUp, { signal });
  };

  return { onPointerDown, shouldAllowOpen, isDragging, indicator };
}

export function computeDragTarget(
  anchor: HTMLTableCellElement,
  axis: Axis,
  clientX: number,
  clientY: number,
): DragTarget | null {
  const table = anchor.closest('table');
  if (!table) return null;
  const tableRect = table.getBoundingClientRect();

  if (axis === 'row') {
    const rows = Array.from(table.rows);
    if (rows.length === 0) return null;
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i].getBoundingClientRect();
      if (clientY < rect.top) {
        return {
          index: FIRST_MOVABLE_ROW_INDEX,
          rect: horizontalLine(tableRect, rowBottomOr(rows, 0, rect.top)),
        };
      }
      if (clientY <= rect.bottom) {
        const midY = rect.top + rect.height / 2;
        const insertAfter = clientY >= midY;
        const rawIndex = insertAfter ? i + 1 : i;
        const index = Math.max(FIRST_MOVABLE_ROW_INDEX, rawIndex);
        const clamped = index !== rawIndex;
        const y = clamped ? rowBottomOr(rows, 0, rect.top) : insertAfter ? rect.bottom : rect.top;
        return { index, rect: horizontalLine(tableRect, y) };
      }
    }
    const last = rows[rows.length - 1].getBoundingClientRect();
    return { index: rows.length, rect: horizontalLine(tableRect, last.bottom) };
  }

  const referenceRow = table.rows[0];
  if (!referenceRow) return null;
  const cells = Array.from(referenceRow.cells);
  if (cells.length === 0) return null;
  for (let i = 0; i < cells.length; i++) {
    const rect = cells[i].getBoundingClientRect();
    if (clientX < rect.left) {
      return { index: 0, rect: verticalLine(tableRect, rect.left) };
    }
    if (clientX <= rect.right) {
      const midX = rect.left + rect.width / 2;
      const insertAfter = clientX >= midX;
      const x = insertAfter ? rect.right : rect.left;
      return { index: insertAfter ? i + 1 : i, rect: verticalLine(tableRect, x) };
    }
  }
  const last = cells[cells.length - 1].getBoundingClientRect();
  return { index: cells.length, rect: verticalLine(tableRect, last.right) };
}

function rowBottomOr(rows: HTMLTableRowElement[], index: number, fallbackY: number): number {
  const row = rows[index];
  return row ? row.getBoundingClientRect().bottom : fallbackY;
}

function horizontalLine(tableRect: DOMRect, y: number): DragTarget['rect'] {
  return { left: tableRect.left, top: y - 1, width: tableRect.width, height: 2 };
}

function verticalLine(tableRect: DOMRect, x: number): DragTarget['rect'] {
  return { left: x - 1, top: tableRect.top, width: 2, height: tableRect.height };
}

function commitReorder(
  editor: Editor,
  anchor: HTMLTableCellElement,
  axis: Axis,
  targetIndex: number,
): void {
  const sourceIndex = axis === 'row' ? rowIndexOf(anchor) : anchor.cellIndex;
  if (sourceIndex < 0) return;
  if (axis === 'row') {
    if (sourceIndex < FIRST_MOVABLE_ROW_INDEX) return;
    if (targetIndex < FIRST_MOVABLE_ROW_INDEX) return;
  }
  if (targetIndex === sourceIndex || targetIndex === sourceIndex + 1) return;

  const { state, view } = editor;
  const tablePos = findTablePos(state.selection.$from);
  if (tablePos < 0) {
    console.warn('[table-drag-reorder] no table found at selection depth');
    return;
  }
  const table = state.doc.nodeAt(tablePos);
  if (!table) {
    console.warn('[table-drag-reorder] nodeAt returned null at tablePos', tablePos);
    return;
  }

  const tr = state.tr;
  const newTable =
    axis === 'row'
      ? tableWithMovedRow(table, sourceIndex, targetIndex)
      : tableWithMovedColumn(table, sourceIndex, targetIndex);
  applyTableReplacement(tr, tablePos, table, newTable);
  view.dispatch(tr);
}

function rowIndexOf(cell: HTMLTableCellElement): number {
  const tr = cell.parentElement;
  const table = tr?.closest('table');
  if (!table) return -1;
  return Array.prototype.indexOf.call(table.rows, tr);
}

function findTablePos($from: ResolvedPos): number {
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.spec.tableRole === 'table') {
      return $from.before(depth);
    }
  }
  return -1;
}

export function tableWithMovedRow(table: PmNode, from: number, to: number): PmNode {
  const rows: PmNode[] = [];
  table.forEach((row) => {
    rows.push(row);
  });
  const [moved] = rows.splice(from, 1);
  const dest = to > from ? to - 1 : to;
  rows.splice(dest, 0, moved);
  return table.type.create(table.attrs, rows, table.marks);
}

export function tableWithMovedColumn(table: PmNode, from: number, to: number): PmNode {
  const dest = to > from ? to - 1 : to;
  const newRows: PmNode[] = [];
  table.forEach((row) => {
    const cells: PmNode[] = [];
    row.forEach((cell) => {
      cells.push(cell);
    });
    const [moved] = cells.splice(from, 1);
    cells.splice(dest, 0, moved);
    newRows.push(row.type.create(row.attrs, cells, row.marks));
  });
  return table.type.create(table.attrs, newRows, table.marks);
}

function applyTableReplacement(
  tr: Transaction,
  tablePos: number,
  oldTable: PmNode,
  newTable: PmNode,
): void {
  tr.replaceRangeWith(tablePos, tablePos + oldTable.nodeSize, newTable);
}
