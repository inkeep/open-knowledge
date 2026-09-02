import { autoUpdate, computePosition, offset } from '@floating-ui/dom';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
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
import { handleAnchorCellPos, selectTableAxis } from './table-axis-selection';
import { useTableDragReorder } from './useTableDragReorder';

type Axis = 'column' | 'row';

interface ActiveCell {
  columnAnchor: HTMLTableCellElement;
  rowAnchor: HTMLTableCellElement;
  isFirstColumn: boolean;
  isFirstRow: boolean;
}

interface MenuItem {
  id: string;
  label: MessageDescriptor;
  icon: LucideIcon;
  run: (editor: Editor) => void;
  separatorBefore?: boolean;
}

function columnItems(showHeaderToggle: boolean): MenuItem[] {
  return [
    ...(showHeaderToggle
      ? [
          {
            id: 'toggle-header-column',
            label: msg`Toggle header column`,
            icon: Columns3,
            run: (e: Editor) => e.chain().focus().toggleHeaderColumn().run(),
          },
        ]
      : []),
    {
      id: 'insert-column-left',
      label: msg`Insert column left`,
      icon: ArrowLeft,
      run: (e) => e.chain().focus().addColumnBefore().run(),
    },
    {
      id: 'insert-column-right',
      label: msg`Insert column right`,
      icon: ArrowRight,
      run: (e) => e.chain().focus().addColumnAfter().run(),
    },
    {
      id: 'delete-column',
      label: msg`Delete column`,
      icon: Trash2,
      separatorBefore: true,
      run: (e) => e.chain().focus().deleteColumn().run(),
    },
    {
      id: 'delete-table',
      label: msg`Delete table`,
      icon: Grid2x2X,
      run: (e) => e.chain().focus().deleteTable().run(),
    },
  ];
}

function rowItems(showHeaderToggle: boolean): MenuItem[] {
  return [
    ...(showHeaderToggle
      ? [
          {
            id: 'toggle-header-row',
            label: msg`Toggle header row`,
            icon: TableProperties,
            run: (e: Editor) => e.chain().focus().toggleHeaderRow().run(),
          },
        ]
      : []),
    {
      id: 'insert-row-above',
      label: msg`Insert row above`,
      icon: ArrowUp,
      run: (e) => e.chain().focus().addRowBefore().run(),
    },
    {
      id: 'insert-row-below',
      label: msg`Insert row below`,
      icon: ArrowDown,
      run: (e) => e.chain().focus().addRowAfter().run(),
    },
    {
      id: 'delete-row',
      label: msg`Delete row`,
      icon: Trash2,
      separatorBefore: true,
      run: (e) => e.chain().focus().deleteRow().run(),
    },
    {
      id: 'delete-table',
      label: msg`Delete table`,
      icon: Grid2x2X,
      run: (e) => e.chain().focus().deleteTable().run(),
    },
  ];
}

function computeActiveCell(editor: Editor): ActiveCell | null {
  if (!editor.isEditable) return null;
  if (getFindReplaceState(editor.state).query) return null;

  const { state, view } = editor;
  let cellPos = handleAnchorCellPos(state.selection) ?? -1;
  if (cellPos < 0) {
    const $from = state.selection.$from;
    for (let depth = $from.depth; depth > 0; depth--) {
      const role = $from.node(depth).type.spec.tableRole;
      if (role === 'cell' || role === 'header_cell') {
        cellPos = $from.before(depth);
        break;
      }
    }
  }
  if (cellPos < 0) return null;

  const cellDOM = view.nodeDOM(cellPos);
  if (!(cellDOM instanceof HTMLTableCellElement)) return null;
  const table = cellDOM.closest('table');
  const tr = cellDOM.closest('tr');
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
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const drag = useTableDragReorder({
    editor,
    axis,
    anchor,
    onClickGesture: () => {
      selectTableAxis(editor, anchor, axis);
      setOpen(true);
    },
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const placement = axis === 'column' ? 'top' : 'left';
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
              className={
                axis === 'column'
                  ? 'h-3 w-7 rounded-full p-0 text-gray-700 dark:text-muted-foreground bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 hover:text-foreground dark:hover:bg-gray-600 dark:hover:text-gray-100 relative cursor-grab before:absolute before:-inset-[6px] before:content-[""]'
                  : 'h-7 w-3 rounded-full p-0 text-gray-700 dark:text-muted-foreground bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 hover:text-foreground dark:hover:bg-gray-600 dark:hover:text-gray-100 relative cursor-grab before:absolute before:-inset-[6px] before:content-[""]'
              }
              aria-label={axis === 'column' ? t`Column options` : t`Row options`}
            >
              <HandleIcon className="size-3.5" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align={axis === 'column' ? 'center' : 'start'}
            side={axis === 'column' ? 'bottom' : 'right'}
            className="w-auto min-w-44 whitespace-nowrap"
          >
            {items.map((item) => (
              <Fragment key={item.id}>
                {item.separatorBefore && <DropdownMenuSeparator />}
                <DropdownMenuItem onSelect={() => item.run(editor)}>
                  <item.icon aria-hidden />
                  {t(item.label)}
                </DropdownMenuItem>
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {drag.indicator && (
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
