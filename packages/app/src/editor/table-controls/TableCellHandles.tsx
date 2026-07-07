/**
 * TableCellHandles — per-column / per-row dropdown handles for the active cell.
 *
 * When the selection is inside a table cell, two handles appear: one above the
 * cell's column and one to the left of its row. Each opens a dropdown scoped to
 * that column/row (insert before/after, delete, delete table; plus a header
 * toggle on the first column/row only). Replaces the old single bubble toolbar.
 *
 * Cell geometry is resolved straight from the DOM — GFM tables are rectangular
 * (no colspan/rowspan), so `cellIndex` and the `<tr>` index are the grid
 * coordinates, and the column's top cell / row's left cell are the natural
 * anchors.
 *
 * Positioning uses floating-ui `strategy: 'absolute'` + `autoUpdate`.
 * `strategy: 'fixed'` is wrong here — the editor has transformed ancestors
 * (animations / `<Activity>`), which become the containing block for fixed
 * elements and throw the coordinates off.
 *
 * The handles render in the normal React tree inside a `position: relative`
 * host (`.ok-table-cell-handle-layer`), NOT a portal into
 * `view.dom.parentElement`. That node is the one TipTap's `PureEditorContent`
 * vacuums on `<Activity>` recycle (it `appendChild`s `parentNode.childNodes`
 * into the view); a React portal there desyncs React's DOM bookkeeping, so a
 * later unmount throws `Failed to execute 'removeChild'` — the exact crash
 * `drag-handle.ts` and `table-insert-controls.ts` use imperative DOM to dodge.
 * The host inherits `grid-column: content` from `.tiptap-editor > *` and lives
 * inside the scroll container, so floating-ui (which measures the offsetParent
 * at compute time) places the handles identically and they track scroll.
 *
 * Commands are the stock tiptap table commands, run selection-relative (the
 * active cell is the selection, so `addColumnAfter` etc. target the right
 * column/row).
 *
 * Visibility is CSS-only — the layer is mounted whenever the cursor is in a
 * cell but is hidden by default and revealed by `.tiptap-editor:focus-within`
 * (covers both editor and pill focus, since the pill is a descendant) plus
 * `:has([data-state="open"])` on the layer (covers menu open while focus is
 * inside the Radix-portaled content). See `.ok-table-cell-handle-layer` in
 * `globals.css`. Pure CSS works because focus moves *within* `.tiptap-editor`
 * continuously through the click → pill → menu handoff, so there's no race.
 */

import { autoUpdate, computePosition, offset } from '@floating-ui/dom';
import type { Editor } from '@tiptap/react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Columns3,
  Ellipsis,
  EllipsisVertical,
  Grid2x2X,
  type LucideIcon,
  TableProperties,
  Trash2,
} from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getFindReplaceState } from '../find-replace/tiptap-find-replace-extension';
import { useTableDragReorder } from './useTableDragReorder';

type Axis = 'column' | 'row';

interface ActiveCell {
  /** Top cell of the active column — anchor for the column handle. */
  columnAnchor: HTMLTableCellElement;
  /** Left cell of the active row — anchor for the row handle. */
  rowAnchor: HTMLTableCellElement;
  isFirstColumn: boolean;
  isFirstRow: boolean;
}

interface MenuItem {
  label: string;
  icon: LucideIcon;
  run: (editor: Editor) => void;
  /** Render a separator above this item (groups destructive actions). */
  separatorBefore?: boolean;
}

function columnItems(showHeaderToggle: boolean): MenuItem[] {
  return [
    ...(showHeaderToggle
      ? [
          {
            label: 'Toggle header column',
            icon: Columns3,
            run: (e: Editor) => e.chain().focus().toggleHeaderColumn().run(),
          },
        ]
      : []),
    {
      label: 'Insert column left',
      icon: ArrowLeft,
      run: (e) => e.chain().focus().addColumnBefore().run(),
    },
    {
      label: 'Insert column right',
      icon: ArrowRight,
      run: (e) => e.chain().focus().addColumnAfter().run(),
    },
    {
      label: 'Delete column',
      icon: Trash2,
      separatorBefore: true,
      run: (e) => e.chain().focus().deleteColumn().run(),
    },
    { label: 'Delete table', icon: Grid2x2X, run: (e) => e.chain().focus().deleteTable().run() },
  ];
}

function rowItems(showHeaderToggle: boolean): MenuItem[] {
  return [
    ...(showHeaderToggle
      ? [
          {
            label: 'Toggle header row',
            icon: TableProperties,
            run: (e: Editor) => e.chain().focus().toggleHeaderRow().run(),
          },
        ]
      : []),
    {
      label: 'Insert row above',
      icon: ArrowUp,
      run: (e) => e.chain().focus().addRowBefore().run(),
    },
    {
      label: 'Insert row below',
      icon: ArrowDown,
      run: (e) => e.chain().focus().addRowAfter().run(),
    },
    {
      label: 'Delete row',
      icon: Trash2,
      separatorBefore: true,
      run: (e) => e.chain().focus().deleteRow().run(),
    },
    { label: 'Delete table', icon: Grid2x2X, run: (e) => e.chain().focus().deleteTable().run() },
  ];
}

function computeActiveCell(editor: Editor): ActiveCell | null {
  if (!editor.isEditable) return null;
  // Stand down while find-replace owns the selection.
  if (getFindReplaceState(editor.state).query) return null;

  const { state, view } = editor;
  const $from = state.selection.$from;
  let cellPos = -1;
  for (let depth = $from.depth; depth > 0; depth--) {
    const role = $from.node(depth).type.spec.tableRole;
    if (role === 'cell' || role === 'header_cell') {
      cellPos = $from.before(depth);
      break;
    }
  }
  if (cellPos < 0) return null;

  const cellDOM = view.nodeDOM(cellPos);
  if (!(cellDOM instanceof HTMLTableCellElement)) return null;
  const table = cellDOM.closest('table');
  const tr = cellDOM.closest('tr');
  // Guard that the cell is actually in a mounted editor view (not a stale
  // node from a previous doc); the handles themselves render in the React
  // tree, so we don't need the editor content node as a portal target.
  const inEditor = cellDOM.closest('.ProseMirror');
  if (!table || !tr || !inEditor) return null;

  const rowIndex = Array.prototype.indexOf.call(table.rows, tr);
  const colIndex = cellDOM.cellIndex;
  const columnAnchor = table.rows[0]?.cells[colIndex];
  const rowAnchor = table.rows[rowIndex]?.cells[0];
  if (!columnAnchor || !rowAnchor) return null;

  return {
    columnAnchor,
    rowAnchor,
    isFirstColumn: colIndex === 0,
    isFirstRow: rowIndex === 0,
  };
}

function CellHandle({
  editor,
  anchor,
  axis,
  items,
}: {
  editor: Editor;
  anchor: HTMLTableCellElement;
  axis: Axis;
  items: MenuItem[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Controlled Radix open state — the drag hook coordinates against it so
  // a pending drag never flashes the menu open. The hook's pointerup calls
  // onClickGesture when the gesture stayed under the drag threshold, and
  // we translate that into `setOpen(true)`.
  const [open, setOpen] = useState(false);
  const drag = useTableDragReorder({
    editor,
    axis,
    anchor,
    onClickGesture: () => setOpen(true),
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const placement = axis === 'column' ? 'top' : 'left';
    // Negative offset pulls the handle onto the table edge rather than floating
    // outside it — our layout has no gutter, so a positive gap would push it
    // into adjacent content (the block above / content beside the table). The
    // column sits lower (more onto the table) than the row: a horizontal pill
    // above the edge reads as more "floating" than a vertical pill beside it,
    // so it needs more overlap to look equally attached.
    const overlap = axis === 'column' ? -14 : -6;
    const update = () => {
      void computePosition(anchor, el, {
        strategy: 'absolute',
        placement,
        middleware: [offset(overlap)],
      })
        .then(({ x, y }) => {
          el.style.left = `${x}px`;
          el.style.top = `${y}px`;
          el.style.opacity = '1';
        })
        // Anchor cell can be detached by a remote edit before this resolves;
        // the next autoUpdate tick re-positions, so swallow the rejection.
        .catch(() => {});
    };
    return autoUpdate(anchor, el, update);
  }, [anchor, axis]);

  const HandleIcon = axis === 'column' ? Ellipsis : EllipsisVertical;

  return (
    <>
      <div
        ref={ref}
        data-testid="table-cell-handle"
        className="absolute left-0 top-0 z-10 opacity-0"
      >
        <DropdownMenu
          open={open}
          onOpenChange={(next) => {
            if (drag.shouldAllowOpen(next)) setOpen(next);
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="secondary"
              onPointerDown={drag.onPointerDown}
              // The transparent `::before` (-inset-6px) expands the click target
              // to ~24px (WCAG 2.5.8) without enlarging the visible 12px pill.
              // `cursor-grab` telegraphs the drag affordance; the drag hook
              // swaps it for `grabbing` on the body during an active gesture.
              className={
                axis === 'column'
                  ? 'h-3 w-7 rounded-full p-0 text-gray-700 dark:text-muted-foreground bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 hover:text-foreground dark:hover:bg-gray-600 dark:hover:text-gray-100 relative cursor-grab before:absolute before:-inset-[6px] before:content-[""]'
                  : 'h-7 w-3 rounded-full p-0 text-gray-700 dark:text-muted-foreground bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 hover:text-foreground dark:hover:bg-gray-600 dark:hover:text-gray-100 relative cursor-grab before:absolute before:-inset-[6px] before:content-[""]'
              }
              aria-label={axis === 'column' ? 'Column options' : 'Row options'}
            >
              <HandleIcon className="size-3.5" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align={axis === 'column' ? 'center' : 'start'}
            side={axis === 'column' ? 'bottom' : 'right'}
            // Override the shadcn default `w-(--radix-…-trigger-width)`: the trigger
            // is a tiny handle, so width-to-trigger collapses the menu and wraps
            // labels. Size to content instead, with a comfortable floor.
            className="w-auto min-w-44 whitespace-nowrap"
          >
            {items.map((item) => (
              <Fragment key={item.label}>
                {item.separatorBefore && <DropdownMenuSeparator />}
                <DropdownMenuItem onSelect={() => item.run(editor)}>
                  <item.icon aria-hidden />
                  {item.label}
                </DropdownMenuItem>
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {drag.indicator && (
        // Fixed-position drop indicator. Escapes the transformed-ancestor
        // trap that `strategy: 'absolute'` was chosen to avoid — we compute
        // client coordinates directly from the table's DOMRect, so fixed
        // positioning is correct here (unlike the handles, whose autoUpdate
        // tracks scroll via floating-ui). The `pointerEvents: 'none'` keeps
        // the indicator from intercepting the ongoing gesture.
        <div
          aria-hidden
          className="pointer-events-none fixed z-50 bg-primary"
          style={{
            left: drag.indicator.rect.left,
            top: drag.indicator.rect.top,
            width: drag.indicator.rect.width,
            height: drag.indicator.rect.height,
          }}
        />
      )}
    </>
  );
}

export function TableCellHandles({ editor }: { editor: Editor }) {
  const [active, setActive] = useState<ActiveCell | null>(null);

  useEffect(() => {
    // Bail when the active cell is unchanged (same column/row anchors) so a
    // keystroke inside a table doesn't churn a fresh object and re-render the
    // two dropdowns. Anchors are stable DOM elements per cell.
    const update = () =>
      setActive((prev) => {
        const next = computeActiveCell(editor);
        if (
          prev &&
          next &&
          prev.columnAnchor === next.columnAnchor &&
          prev.rowAnchor === next.rowAnchor
        ) {
          return prev;
        }
        return next;
      });
    update();
    editor.on('selectionUpdate', update);
    editor.on('update', update);
    return () => {
      editor.off('selectionUpdate', update);
      editor.off('update', update);
    };
  }, [editor]);

  if (!active) return null;

  // Positioned, zero-footprint React-owned host: the absolute handles need a
  // positioned offsetParent that lives inside the editor's scroll container.
  // Rendering here (NOT a portal into view.dom.parentElement) keeps the DOM out
  // of TipTap's Activity-recycle vacuum.
  // Visibility (focus + menu-open gating) is CSS-only — see globals.css.
  return (
    <div className="ok-table-cell-handle-layer">
      <CellHandle
        editor={editor}
        anchor={active.columnAnchor}
        axis="column"
        items={columnItems(active.isFirstColumn)}
      />
      <CellHandle
        editor={editor}
        anchor={active.rowAnchor}
        axis="row"
        items={rowItems(active.isFirstRow)}
      />
    </div>
  );
}
