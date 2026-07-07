/**
 * Drag-to-reorder gesture for the TableCellHandles ellipsis buttons.
 *
 * The handle is dual-gesture: a click opens its dropdown (insert / delete /
 * toggle-header), a drag past a small threshold reorders the row / column.
 * Distinguishing the two:
 *
 *   1. On pointerdown we set `pendingDragRef` and DON'T yet decide.
 *   2. Radix DropdownMenuTrigger tries to open on the same pointerdown,
 *      but the CellHandle owns `open` state and forwards Radix's request
 *      through `handleOpenChange` — which refuses while `pendingDragRef`
 *      is set so the menu never flashes during a drag.
 *   3. On pointermove past `DRAG_THRESHOLD_PX` we flip into drag mode and
 *      an insertion indicator tracks the pointer's nearest row / column
 *      boundary.
 *   4. On pointerup: drag mode → commit the reorder transaction and swallow
 *      the click; otherwise → open the menu manually via `setOpen(true)`.
 *
 * The reorder is a single ProseMirror transaction that rebuilds the table
 * with the moved row / column at the new index. This works for GFM tables
 * (rectangular, no colspan / rowspan) — the same rectangularity assumption
 * TableCellHandles' geometry logic already relies on.
 *
 * **Row 0 is the markdown header — positional, not per-cell.** The OK
 * markdown pipeline treats row 0 as the header on every path
 * (`packages/core/src/markdown/index.ts:595` on parse,
 * `to-markdown-handlers.ts:896` on emit); the per-cell `tableHeader` /
 * `tableCell` distinction is discarded during PM→mdast
 * (`index.ts:1760-1765`). A row-splice that lands ANY data row at index 0
 * (or drags the header row away) silently inverts the markdown header on
 * the next round-trip. We enforce the invariant in two places: the row
 * branch of `computeDragTarget` clamps target indices to `[1, rowCount]`
 * so the drop indicator never suggests a position above / at the header,
 * and `commitReorder` refuses to move a header-row source. Users who want
 * to change the header row use the "Toggle header row" menu item, not a
 * drag.
 */

import type { Node as PmNode, ResolvedPos } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/react';
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';

type Axis = 'row' | 'column';

/** Cursor must move at least this many CSS pixels before the gesture flips
 * from "candidate click" to "drag". A too-small threshold catches jitter on
 * a mouse-down; a too-large one makes the drag feel unresponsive. 5px is
 * the same threshold the Radix DnD primitives use. */
const DRAG_THRESHOLD_PX = 5;

/** Row 0 is the positional markdown header — see the file header. Any drag
 * whose source OR target is index 0 would corrupt the header on round-trip.
 * The clamp lives here instead of a magic number in the middle of the file. */
const FIRST_MOVABLE_ROW_INDEX = 1;

interface UseTableDragReorderOptions {
  editor: Editor;
  axis: Axis;
  /** The active cell whose column / row this handle belongs to — the source
   * of the drag. Used to resolve the source index + the containing table. */
  anchor: HTMLTableCellElement;
  /** Called on pointerup when the gesture stayed under the drag threshold
   * (a click). The consumer opens its controlled Radix menu here since the
   * hook refused Radix's own pointerdown open request. Kept in a ref so a
   * fresh closure per render never staled the pointerup handler. */
  onClickGesture: () => void;
}

interface DragTarget {
  /** Insertion index. `0` = before row / column 0, `N` = after the last one. */
  index: number;
  /** Fixed-position bounding box for the drop indicator line. */
  rect: { left: number; top: number; width: number; height: number };
}

export interface UseTableDragReorderResult {
  /** Wire this onto the handle Button (or any ancestor that receives the
   * pointerdown). Ignores non-primary buttons. */
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  /** Consult this before letting Radix DropdownMenu open. Refuses opens
   * while the pointer is a drag candidate so a pending drag never flashes
   * the menu. */
  shouldAllowOpen: (nextOpen: boolean) => boolean;
  /** True while the pointer is past-threshold and reordering is live.
   * Callers can gate visual state on it (e.g. cursor styling). */
  isDragging: boolean;
  /** Rendered indicator line for the imminent drop position — null unless
   * dragging AND a valid target is under the pointer. Render into a
   * fixed-position portal / absolutely-positioned host that doesn't move
   * with editor scroll. */
  indicator: DragTarget | null;
}

/**
 * Attach to a CellHandle. Returns pointer handlers, an indicator descriptor,
 * and hooks the caller uses to coordinate with a controlled Radix menu.
 */
export function useTableDragReorder({
  editor,
  axis,
  anchor,
  onClickGesture,
}: UseTableDragReorderOptions): UseTableDragReorderResult {
  // Ref rather than state — the pointerdown / move / up handlers all read
  // and mutate it synchronously; setState would introduce render-cycle
  // races (pointermove firing before pointerdown's state has committed).
  const pendingDragRef = useRef<{
    startX: number;
    startY: number;
    isDragging: boolean;
    lastTarget: DragTarget | null;
  } | null>(null);

  // Held here so an unmount effect can abort mid-drag: CellHandle unmounts
  // whenever `computeActiveCell` returns null — a realistic path via a
  // concurrent CRDT edit that deletes the table, or a keystroke that moves
  // the selection out. Without this, `document.body.style.cursor =
  // 'grabbing'` stays set until page reload and `onUp` eventually fires
  // `commitReorder` against a stale editor / anchor.
  const controllerRef = useRef<AbortController | null>(null);

  // Latest-ref pattern for the click callback so the pointerup handler
  // (installed lazily inside onPointerDown) always calls the freshest
  // version, without having to re-bind on every render.
  const onClickGestureRef = useRef(onClickGesture);
  useEffect(() => {
    onClickGestureRef.current = onClickGesture;
  }, [onClickGesture]);

  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      pendingDragRef.current = null;
      // Body style mutations from an active drag must be undone on unmount
      // — the gesture's `onUp` handler is the normal reset path, but it
      // never fires if the component unmounts first.
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  const [isDragging, setIsDragging] = useState(false);
  const [indicator, setIndicator] = useState<DragTarget | null>(null);

  const shouldAllowOpen = (nextOpen: boolean): boolean => {
    // Radix opens on pointerdown; refuse while the pointer is a drag
    // candidate (or actively dragging). If the gesture turns out to be a
    // click, the pointerup handler calls onClickGestureRef.current() explicitly.
    if (nextOpen && pendingDragRef.current !== null) return false;
    return true;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    // Left-button only. Right / middle / touch-hold shouldn't reorder.
    if (event.button !== 0) return;

    // Abort any lingering gesture from a previous pointerdown that never got
    // its pointerup (browser bug, focus-stealing dev-tools, etc.). Idempotent
    // when there's nothing to abort.
    controllerRef.current?.abort();

    pendingDragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      isDragging: false,
      lastTarget: null,
    };

    // AbortController for the gesture's document listeners. Lets `onUp`
    // tear down every subscription with one `abort()` call instead of
    // referencing itself for `removeEventListener` — the self-reference
    // form trips React Compiler's missing-dep pass. Stored in
    // `controllerRef` so the unmount effect can abort mid-gesture.
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
        // Text selection while dragging on a cell would fight the browser's
        // caret drag behavior. Belt-and-suspenders in case the pointerdown
        // originated on a text node.
        document.body.style.userSelect = 'none';
      }

      const target = computeDragTarget(anchor, axis, moveEvent.clientX, moveEvent.clientY);
      drag.lastTarget = target;
      setIndicator(target);
    };

    const onUp = (): void => {
      controller.abort();
      // Only clear the shared ref if THIS controller still owns it — a
      // subsequent pointerdown may have replaced it already, and clobbering
      // that would leak the newer gesture's cleanup path.
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
        // Click gesture: open the menu manually since shouldAllowOpen
        // refused Radix's pointerdown attempt.
        onClickGestureRef.current();
      }
    };

    document.addEventListener('pointermove', onMove, { signal });
    document.addEventListener('pointerup', onUp, { signal });
    // pointercancel fires when the OS interrupts the gesture (dev-tools
    // stealing focus, alt-tab, PIP takeover). Same cleanup path.
    document.addEventListener('pointercancel', onUp, { signal });
  };

  return { onPointerDown, shouldAllowOpen, isDragging, indicator };
}

/**
 * Given the anchor cell + pointer position, decide which row / column
 * boundary is closest and return an insertion index + the rect for the
 * indicator line.
 *
 * For rows: iterate the table's `<tr>`s and check which one the pointer
 * is over; split each row into upper half (insert before) and lower half
 * (insert after). Above the first row → index 0; below the last → row
 * count.
 *
 * For columns: same shape against row 0's `<td>`s (GFM tables are
 * rectangular so row 0 has the same column count as every other row).
 */
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
        // Above the first row → clamp to insert BELOW the header row. Above-
        // header drops would corrupt the positional header (see file header).
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
        // If the clamp bumped the index, anchor the indicator at the bottom
        // of the header row so what the user sees matches what will happen.
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

/** Bottom edge of `rows[index]` if it exists, else the given fallback. Keeps
 * the row-branch clamp behavior sensible for a one-row table (no header
 * boundary to draw a line at — fall back to the caller's own reference y). */
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
  // Row 0 is the positional markdown header (see file header). Refuse header
  // sources and above-header targets; computeDragTarget already clamps the
  // indicator, but a defense-in-depth check here handles callers that could
  // ever bypass the indicator.
  if (axis === 'row') {
    if (sourceIndex < FIRST_MOVABLE_ROW_INDEX) return;
    if (targetIndex < FIRST_MOVABLE_ROW_INDEX) return;
  }
  // A move to the immediate before / after position is a no-op; skip
  // dispatching so the doc's history doesn't accumulate empty transactions.
  if (targetIndex === sourceIndex || targetIndex === sourceIndex + 1) return;

  const { state, view } = editor;
  const tablePos = findTablePos(state.selection.$from);
  if (tablePos < 0) {
    // Selection no longer inside a table (moved out mid-gesture, remote
    // edit deleted the table, etc.). Warn to match the `nodeAt null` case
    // below — otherwise a "drag didn't work" report is indistinguishable
    // from the header-guard refusal or the adjacent no-op.
    console.warn('[table-drag-reorder] no table found at selection depth');
    return;
  }
  const table = state.doc.nodeAt(tablePos);
  if (!table) {
    // `findTablePos` returned a plausible position but the doc has no node
    // there — a PM doc / selection inconsistency (concurrent edit landing
    // between selection resolution and dispatch). Log so the "drag didn't
    // work" report has telemetry; otherwise this is indistinguishable from
    // an adjacent no-op drop.
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
  // When moving DOWN, removing `from` shifts every subsequent index left by
  // one, so a target of `to` in the original list becomes `to - 1` in the
  // spliced list.
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
